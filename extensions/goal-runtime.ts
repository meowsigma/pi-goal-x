/**
 * GoalRuntime — continuation scheduling, stale-checkpoint state, the turn-stop
 * guard, and one-time steering reminders (post-compaction, budget reached).
 *
 * The extension (`extensions/goal.ts`) instantiates one GoalRuntime with hooks
 * bound to its closure state and the pi API; every runtime decision is
 * encapsulated here so the scheduling/guarding behavior is independently
 * testable with a mock context.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalCheckpointDetailsV2, GoalContinuationState, GoalRecord } from "./goal-record.ts";
import { checkpointTriggerPrompt } from "./prompts/goal-prompts.ts";
import { POST_STOP_ALLOWED_TOOLS } from "./goal-tool-names.ts";
import { networkErrorBackoffPlan, type NetworkErrorBackoffPlan, type NetworkErrorRecoveryPolicy } from "./network-error-backoff.ts";

export const CONTINUATION_IDLE_RETRY_MS = 50;
const DEFERRED_WAKE_MAX_MS = 2_147_000_000;
const AUDIT_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;
const AUDIT_RETRY_MAX_ATTEMPTS = AUDIT_RETRY_DELAYS_MS.length;
const PROGRESS_REVIEW_MAX_FAILURES = 3;

export interface AuditRetryAdmission {
	allowed: boolean;
	retryAfterMs?: number;
	attempt?: number;
	maxAttempts: number;
}

export interface AuditRetryPlan {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
}

const POST_STOP_ALLOWED = new Set<string>(POST_STOP_ALLOWED_TOOLS);

export interface GoalRuntimeTimers {
	setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
	clearTimeout(timer: ReturnType<typeof setTimeout>): void;
	now(): number;
}

export interface GoalRuntimeHooks {
	/** Dispatch a hidden follow-up checkpoint message (pi.sendMessage + triggerTurn). */
	sendFollowUp(content: string, details: Record<string, unknown>): void;
	/** Current focused goal (state.goal). */
	getGoal(): GoalRecord | null;
	/** Whether a checkpointed goal id is still actionable (active + autoContinue). */
	isActionable(goalId: string | null | undefined): boolean;
	/** Authoritative write used before a deferred wake is armed. */
	persistGoal?(goal: GoalRecord, ctx: ExtensionContext): boolean;
	/** Dispatch a due review/recovery wake; optional for focused runtime tests. */
	onDeferredWake?(ctx: ExtensionContext, goal: GoalRecord): void;
	/** Surface a failed authoritative wake retirement without dispatching it. */
	onDeferredWakePersistenceFailure?(ctx: ExtensionContext, goal: GoalRecord, message: string): void;
}

export class GoalRuntime {
	// ── continuation scheduling ──────────────────────────────────────────
	private continuationQueuedFor: string | null = null;
	private continuationScheduledFor: string | null = null;
	private continuationTimer: ReturnType<typeof setTimeout> | null = null;
	private networkErrorRetryGoalId: string | null = null;
	private networkErrorRetryAttempt = 0;
	private networkErrorRetryTimer: ReturnType<typeof setTimeout> | null = null;
	/** Audit recovery is separate from host provider recovery: ordinary
	 * continuation/user-prompt cleanup must not reset this admission gate. */
	private auditRetryByGoal = new Map<string, { attempt: number; nextAt: number; exhausted: boolean }>();
	private auditRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private auditRetryWakeGeneration = new Map<string, number>();
	/** One-shot continuation lease that pivots an audit-only turn to independent work. */
	private auditRecoveryLeases = new Map<string, { pending: boolean; issued: boolean; promptDelivered: boolean }>();
	private progressReviewInFlight = new Set<string>();
	private progressReviewPending = new Set<string>();
	private deferredWakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private deferredWakeGeneration = new Map<string, number>();

	// ── turn-stop guard ──────────────────────────────────────────────────
	private turnSeq = 0;
	private turnStoppedFor: { goalId: string; turnSeq: number } | null = null;

	// ── stale checkpoint state ───────────────────────────────────────────
	private checkpointGoalId: string | null = null;

	/** Monotonic per-session counter persisted on v2 checkpoint details (issue #30). */
	private checkpointSeq = 0;

	// ── one-time steering reminders ──────────────────────────────────────
	private postCompactReminderPending = false;
	private postBudgetReminderPending = false;

	private readonly hooks: GoalRuntimeHooks;
	private readonly timers: GoalRuntimeTimers;

	constructor(hooks: GoalRuntimeHooks, timers: Partial<GoalRuntimeTimers> = {}) {
		this.hooks = hooks;
		this.timers = {
			setTimeout: timers.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
			clearTimeout: timers.clearTimeout ?? ((timer) => clearTimeout(timer)),
			now: timers.now ?? (() => Date.now()),
		};
	}

	// ── continuation scheduling ──────────────────────────────────────────

	clearContinuationState(resetNetworkErrorBackoff = true): void {
		this.clearContinuationTimer();
		this.continuationQueuedFor = null;
		if (resetNetworkErrorBackoff) this.clearNetworkErrorBackoff();
	}

	/** Clear the pending timer but keep the queued marker (used at session shutdown). */
	clearContinuationTimer(): void {
		if (this.continuationTimer) {
			this.timers.clearTimeout(this.continuationTimer);
			this.continuationTimer = null;
		}
		this.continuationScheduledFor = null;
	}

	/** Request one whole-goal review at the next settled lifecycle boundary. */
	requestProgressReview(goalId: string): void { this.progressReviewPending.add(goalId); }
	consumeProgressReviewRequest(goalId: string): boolean {
		if (!this.progressReviewPending.has(goalId)) return false;
		this.progressReviewPending.delete(goalId);
		return true;
	}
	beginProgressReview(goalId: string): boolean {
		if (this.progressReviewInFlight.has(goalId)) return false;
		this.progressReviewInFlight.add(goalId);
		return true;
	}
	endProgressReview(goalId: string): void { this.progressReviewInFlight.delete(goalId); }
	isProgressReviewInFlight(goalId: string): boolean { return this.progressReviewInFlight.has(goalId); }
	/** Review-provider exhaustion is independent of ordinary execution progress. */
	isProgressReviewExhausted(goal: GoalRecord): boolean {
		return (goal.continuation?.reviewFailures ?? 0) >= PROGRESS_REVIEW_MAX_FAILURES;
	}

	/** Whether a continuation is queued or scheduled for this goal id. */
	continuationPendingFor(goalId: string): boolean {
		return this.continuationQueuedFor === goalId || this.continuationScheduledFor === goalId;
	}

	/**
	 * Schedule the next auto-continuation for the focused active goal.
	 * Only `active` + autoContinue goals can queue. `force` bypasses the
	 * already-queued/scheduled dedup (used right after creation/resume).
	 */
	queueContinuation(ctx: ExtensionContext, goal: GoalRecord, force = false): void {
		// A durable wait/recovery lease is the sole continuation owner until its
		// due callback retires it. Reload and ordinary checkpoints must not wake it early.
		if (goal.status !== "active" || !goal.autoContinue || goal.continuation?.wake || goal.continuation?.hold) return;
		const goalId = goal.id;
		if (!force && this.continuationPendingFor(goalId)) return;
		this.clearContinuationTimer();
		let delay = CONTINUATION_IDLE_RETRY_MS;
		try {
			delay = ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : CONTINUATION_IDLE_RETRY_MS;
		} catch {
			return;
		}
		this.continuationScheduledFor = goalId;
		this.continuationTimer = this.timers.setTimeout(() => this.sendQueuedContinuation(ctx, goalId), delay);
		this.continuationTimer.unref?.();
	}

	/** Cancel a pending continuation for a goal id (e.g. after update/clear/focus change). */
	cancelContinuationFor(goalId: string): void {
		if (this.continuationQueuedFor === goalId) this.continuationQueuedFor = null;
		if (this.continuationScheduledFor === goalId) this.clearContinuationState();
		if (this.networkErrorRetryGoalId === goalId) this.clearNetworkErrorBackoff();
	}

	/**
	 * Admission gate for completion audits. A failed audit can leave the goal
	 * active for independent work, but the same goal cannot immediately launch
	 * another audit while its goal-scoped cooldown is active or exhausted.
	 */
	auditRetryAdmission(goalId: string): AuditRetryAdmission {
		const state = this.auditRetryByGoal.get(goalId);
		if (!state) return { allowed: true, maxAttempts: AUDIT_RETRY_MAX_ATTEMPTS };
		if (state.exhausted) return { allowed: false, attempt: state.attempt, maxAttempts: AUDIT_RETRY_MAX_ATTEMPTS };
		const retryAfterMs = Math.max(0, state.nextAt - this.timers.now());
		return retryAfterMs > 0
			? { allowed: false, retryAfterMs, attempt: state.attempt, maxAttempts: AUDIT_RETRY_MAX_ATTEMPTS }
			: { allowed: true, attempt: state.attempt, maxAttempts: AUDIT_RETRY_MAX_ATTEMPTS };
	}

	private scheduleAuditWake(ctx: ExtensionContext, goal: GoalRecord, delayMs: number): void {
		if (this.auditRetryTimers.has(goal.id)) return;
		const generation = (this.auditRetryWakeGeneration.get(goal.id) ?? 0) + 1;
		this.auditRetryWakeGeneration.set(goal.id, generation);
		const timer = this.timers.setTimeout(() => {
			if (this.auditRetryWakeGeneration.get(goal.id) !== generation) return;
			this.auditRetryTimers.delete(goal.id);
			if (!this.hooks.isActionable(goal.id)) return;
			const currentGoal = this.hooks.getGoal();
			if (!currentGoal || currentGoal.id !== goal.id) return;
			// A recovery lease already dispatched an independent-work pivot. Do
			// not add a second hidden wake while audit admission remains blocked.
			if (this.auditRecoveryLeases.has(goal.id)) return;
			// Do not displace productive ordinary continuation work. The
			// admission gate still protects the next completion request.
			this.queueContinuation(ctx, currentGoal, false);
		}, delayMs);
		timer.unref?.();
		this.auditRetryTimers.set(goal.id, timer);
	}

	/**
	 * Give an audit-only turn one bounded pivot to independently actionable work.
	 * The lease stays active until productive work or explicit user input clears
	 * it, so a model repeating update_goal cannot create a hot loop.
	 */
	scheduleAuditRecovery(_ctx: ExtensionContext, goal: GoalRecord): boolean {
		if (goal.status !== "active" || !goal.autoContinue || this.auditRecoveryLeases.has(goal.id)) return false;
		this.auditRecoveryLeases.set(goal.id, { pending: true, issued: false, promptDelivered: false });
		return true;
	}

	/** Whether a recovery continuation is eligible for dispatch at settlement. */
	hasAuditRecoveryLease(goalId: string): boolean {
		return this.auditRecoveryLeases.get(goalId)?.pending === true;
	}

	/** Retire dispatch eligibility while retaining the issued lease for coaching. */
	issueAuditRecovery(goalId: string): boolean {
		const lease = this.auditRecoveryLeases.get(goalId);
		if (!lease?.pending) return false;
		lease.pending = false;
		lease.issued = true;
		return true;
	}

	consumeAuditRecoveryPrompt(goalId: string): boolean {
		const lease = this.auditRecoveryLeases.get(goalId);
		if (!lease?.issued || lease.promptDelivered) return false;
		lease.promptDelivered = true;
		return true;
	}

	clearAuditRecovery(goalId: string): void {
		this.auditRecoveryLeases.delete(goalId);
	}

	/** Record one goal-scoped audit infrastructure failure and schedule one recovery wake. */
	scheduleAuditRetry(ctx: ExtensionContext, goal: GoalRecord, _error: string): AuditRetryPlan | null {
		if (goal.status !== "active" || !goal.autoContinue) return null;
		const prior = this.auditRetryByGoal.get(goal.id);
		const attempt = (prior?.attempt ?? 0) + 1;
		if (attempt > AUDIT_RETRY_MAX_ATTEMPTS) {
			this.auditRetryByGoal.set(goal.id, { attempt: AUDIT_RETRY_MAX_ATTEMPTS, nextAt: Number.POSITIVE_INFINITY, exhausted: true });
			return null;
		}
		const delayMs = AUDIT_RETRY_DELAYS_MS[attempt - 1]!;
		this.auditRetryByGoal.set(goal.id, { attempt, nextAt: this.timers.now() + delayMs, exhausted: false });
		this.scheduleAuditWake(ctx, goal, delayMs);
		return { attempt, maxAttempts: AUDIT_RETRY_MAX_ATTEMPTS, delayMs };
	}

	/** Restore the latest audit cooldown after a session reload. */
	restoreAuditRetry(ctx: ExtensionContext, goal: GoalRecord, attempt: number, failedAt: string): void {
		if (this.auditRetryByGoal.has(goal.id) || goal.status !== "active" || !goal.autoContinue) return;
		const persistedAttempt = Math.max(1, Math.trunc(attempt));
		const safeAttempt = Math.min(AUDIT_RETRY_MAX_ATTEMPTS, persistedAttempt);
		const failedAtMs = Date.parse(failedAt);
		const delayMs = AUDIT_RETRY_DELAYS_MS[safeAttempt - 1]!;
		const nextAt = Number.isFinite(failedAtMs) ? failedAtMs + delayMs : Date.now();
		const exhausted = persistedAttempt > AUDIT_RETRY_MAX_ATTEMPTS;
		this.auditRetryByGoal.set(goal.id, { attempt: safeAttempt, nextAt, exhausted });
		if (!exhausted) this.scheduleAuditWake(ctx, goal, Math.max(0, nextAt - Date.now()));
	}

	/** Dispose audit wake timers without resetting durable attempt admission. */
	disposeAuditRetryTimers(): void {
		for (const [goalId, timer] of this.deferredWakeTimers) {
			this.timers.clearTimeout(timer);
			this.deferredWakeGeneration.set(goalId, (this.deferredWakeGeneration.get(goalId) ?? 0) + 1);
		}
		this.deferredWakeTimers.clear();
		for (const [goalId, timer] of this.auditRetryTimers) {
			this.timers.clearTimeout(timer);
			this.auditRetryWakeGeneration.set(goalId, (this.auditRetryWakeGeneration.get(goalId) ?? 0) + 1);
		}
		this.auditRetryTimers.clear();
	}

	/** Persist and arm one goal-owned deferred wake. */
	scheduleDeferredWake(ctx: ExtensionContext, goal: GoalRecord, state: GoalContinuationState): boolean {
		if (goal.status !== "active" || !goal.autoContinue || goal.continuation?.hold || !state.wake) return false;
		if (this.deferredWakeTimers.has(goal.id)) return false;
		if (!this.hooks.persistGoal || !this.hooks.persistGoal({ ...goal, continuation: state }, ctx)) return false;
		this.cancelContinuationFor(goal.id);
		this.armDeferredWake(ctx, { ...goal, continuation: state });
		return true;
	}

	private armDeferredWake(ctx: ExtensionContext, goal: GoalRecord): void {
		const wake = goal.continuation?.wake;
		if (!wake || this.deferredWakeTimers.has(goal.id)) return;
		const generation = (this.deferredWakeGeneration.get(goal.id) ?? 0) + 1;
		this.deferredWakeGeneration.set(goal.id, generation);
		const timer = this.timers.setTimeout(() => {
			if (this.deferredWakeGeneration.get(goal.id) !== generation) return;
			this.deferredWakeTimers.delete(goal.id);
			if (!this.hooks.isActionable(goal.id)) return;
			const current = this.hooks.getGoal();
			if (!current || current.id !== goal.id || current.continuation?.scope !== goal.continuation?.scope || current.continuation?.wake?.id !== wake.id) return;
			const remaining = Date.parse(wake.at) - this.timers.now();
			if (remaining > 0) {
				// Node timers cap one interval at ~24.8 days. A long wait is still
				// one lease: re-arm the remaining interval instead of dispatching at
				// the cap and pretending the criterion is due.
				this.armDeferredWake(ctx, current);
				return;
			}
			const retired = { ...current, continuation: current.continuation ? { ...current.continuation, wake: undefined } : undefined };
			// Retirement is the durable lease handoff. Dispatching before it is
			// persisted can leave the wake live on disk and duplicate work after a
			// reload. Keep the wake intact and fail closed on write failure.
			if (!this.hooks.persistGoal || !this.hooks.persistGoal(retired, ctx)) {
				this.hooks.onDeferredWakePersistenceFailure?.(ctx, current, "Deferred wake retirement was not persisted; the wake remains durable and the recheck was not dispatched.");
				return;
			}
			if (wake.kind === "review_recovery") this.requestProgressReview(goal.id);
			this.hooks.onDeferredWake?.(ctx, retired);
			this.queueContinuation(ctx, retired, true);
		}, Math.min(Math.max(0, Date.parse(wake.at) - this.timers.now()), DEFERRED_WAKE_MAX_MS));
		timer.unref?.();
		this.deferredWakeTimers.set(goal.id, timer);
	}

	restoreDeferredWake(ctx: ExtensionContext, goal: GoalRecord): void {
		if (goal.status !== "active" || !goal.autoContinue || !goal.continuation?.wake) return;
		if (goal.continuation.wake.kind !== "external_wait") {
			// Historical reviewer/execution recovery wakes are not allowed to revive
			// timer-driven activity after reload. Preserve their bounded evidence as
			// an incomplete hold instead.
			this.retainContinuationHold(ctx, goal, goal.continuation.scope, "Historical automatic recovery was suppressed; no justified retry remains.", goal.continuation.wake.evidence);
			return;
		}
		this.armDeferredWake(ctx, goal);
	}

	cancelDeferredWake(goalId: string): void {
		const timer = this.deferredWakeTimers.get(goalId);
		if (timer) this.timers.clearTimeout(timer);
		this.deferredWakeTimers.delete(goalId);
		this.deferredWakeGeneration.set(goalId, (this.deferredWakeGeneration.get(goalId) ?? 0) + 1);
	}

	retainReviewInstruction(ctx: ExtensionContext, goal: GoalRecord, scope: string, instruction: string): boolean {
		if (!this.hooks.persistGoal) return false;
		return this.hooks.persistGoal({ ...goal, continuation: { scope, instruction: instruction.slice(0, 2_000), executionRetries: goal.continuation?.executionRetries ?? 0, reviewFailures: goal.continuation?.reviewFailures ?? 0, wake: goal.continuation?.wake } }, ctx);
	}

	/** Persist an ACTIVE, incomplete hold without arming a retry timer. */
	retainContinuationHold(ctx: ExtensionContext, goal: GoalRecord, scope: string, reason: string, evidence: string[], admissionKey?: string): boolean {
		if (!this.hooks.persistGoal || goal.status !== "active" || !goal.autoContinue || goal.continuation?.wake?.kind === "external_wait") return false;
		const boundedEvidence = evidence.filter((item) => item.trim()).map((item) => item.trim().slice(0, 500)).slice(0, 8);
		if (boundedEvidence.length === 0) return false;
		const persisted = this.hooks.persistGoal({ ...goal, continuation: {
			scope: scope.slice(0, 200),
			instruction: reason.trim().slice(0, 2_000),
			executionRetries: goal.continuation?.executionRetries ?? 0,
			reviewFailures: goal.continuation?.reviewFailures ?? 0,
			hold: { reason: reason.trim().slice(0, 500), evidence: boundedEvidence, at: new Date(this.timers.now()).toISOString(), ...(admissionKey ? { admissionKey } : {}) },
		} }, ctx);
		if (persisted) { this.cancelContinuationFor(goal.id); this.cancelDeferredWake(goal.id); }
		return persisted;
	}

	/** Compatibility no-op: tool activity never clears retained strategic advice.
	 * A subsequent independent review replaces or resolves the advice. */
	clearRetainedReviewInstruction(_ctx: ExtensionContext, _goal: GoalRecord): void {}

	/** Compatibility entry point: ignored advice is now a durable hold, never a timer. */
	scheduleExecutionRecovery(ctx: ExtensionContext, goal: GoalRecord, scope: string, instruction: string): boolean {
		return this.retainContinuationHold(ctx, goal, scope, "The reviewed next action was not executed; no justified automatic retry remains.", [instruction]);
	}

	recordProgressReviewFailure(ctx: ExtensionContext, goal: GoalRecord, error: string, scope: string, admissionKey?: string): void {
		const failures = (goal.continuation?.reviewFailures ?? 0) + 1;
		const diagnostic = error.trim().slice(0, 500) || "unknown review infrastructure failure";
		// There is no retry owner after this call. Say so durably on the first
		// outage rather than imply two invisible future retries will occur.
		this.retainContinuationHold(ctx, { ...goal, continuation: {
			...(goal.continuation ?? { scope, instruction: "", executionRetries: 0, reviewFailures: 0 }), reviewFailures: failures,
		} }, scope, "Independent review is unavailable; no automatic retry is scheduled.", [diagnostic], admissionKey);
	}
	clearProgressReviewFailure(goalId: string): void { this.cancelDeferredWake(goalId); }

	/** Clear audit failure state after a user-requested reset or valid verdict. */
	clearAuditRetry(goalId: string): void {
		this.disposeAuditRetryTimer(goalId);
		this.auditRetryByGoal.delete(goalId);
		this.clearAuditRecovery(goalId);
	}

	private disposeAuditRetryTimer(goalId: string): void {
		const timer = this.auditRetryTimers.get(goalId);
		if (timer) clearTimeout(timer);
		this.auditRetryTimers.delete(goalId);
		this.auditRetryWakeGeneration.set(goalId, (this.auditRetryWakeGeneration.get(goalId) ?? 0) + 1);
	}

	/**
	 * Schedule the next bounded recovery after Pi's built-in provider retries
	 * have failed. The counter stays in memory and is cleared on a successful
	 * turn or any user-owned cancellation path.
	 */
	scheduleNetworkErrorRetry(ctx: ExtensionContext, goal: GoalRecord, policy?: NetworkErrorRecoveryPolicy): NetworkErrorBackoffPlan | null {
		if (goal.status !== "active" || !goal.autoContinue || goal.continuation?.hold || goal.continuation?.wake || this.networkErrorRetryTimer) return null;
		if (this.networkErrorRetryGoalId !== goal.id) {
			this.networkErrorRetryGoalId = goal.id;
			this.networkErrorRetryAttempt = 0;
		}
		const plan = networkErrorBackoffPlan(this.networkErrorRetryAttempt + 1, policy);
		if (!plan) return null;
		this.networkErrorRetryAttempt = plan.attempt;
		this.networkErrorRetryTimer = this.timers.setTimeout(() => {
			this.networkErrorRetryTimer = null;
			if (!this.hooks.isActionable(goal.id)) return;
			const currentGoal = this.hooks.getGoal();
			if (!currentGoal || currentGoal.id !== goal.id) return;
			this.queueContinuation(ctx, currentGoal, true);
		}, plan.delayMs);
		this.networkErrorRetryTimer.unref?.();
		return plan;
	}

	networkErrorRetryPendingFor(goalId: string): boolean {
		return this.networkErrorRetryGoalId === goalId && this.networkErrorRetryTimer !== null;
	}

	/** Cancel and forget all goal-level network-error recovery state. */
	clearNetworkErrorBackoff(): void {
		if (this.networkErrorRetryTimer) this.timers.clearTimeout(this.networkErrorRetryTimer);
		this.networkErrorRetryTimer = null;
		this.networkErrorRetryGoalId = null;
		this.networkErrorRetryAttempt = 0;
	}

	/**
	 * Issue #30: the delivered follow-up must trigger the turn, but it no longer
	 * carries goal state. The persisted content is a tiny v2 marker and the
	 * details are a bounded structured record; before_agent_start injects the
	 * authoritative full prompt once per turn.
	 */
	private sendQueuedContinuation(ctx: ExtensionContext, scheduledGoalId: string): void {
		this.continuationTimer = null;
		this.continuationScheduledFor = null;
		const admittedGoal = this.hooks.getGoal();
		if (!this.hooks.isActionable(scheduledGoalId) || admittedGoal?.continuation?.hold || admittedGoal?.continuation?.wake) {
			if (this.continuationQueuedFor === scheduledGoalId) this.continuationQueuedFor = null;
			return;
		}

		let ready: boolean;
		try {
			ready = !ctx.hasPendingMessages() && ctx.isIdle();
		} catch {
			if (this.continuationQueuedFor === scheduledGoalId) this.continuationQueuedFor = null;
			return;
		}

		if (!ready) {
			this.continuationScheduledFor = scheduledGoalId;
			this.continuationTimer = this.timers.setTimeout(() => this.sendQueuedContinuation(ctx, scheduledGoalId), CONTINUATION_IDLE_RETRY_MS);
			this.continuationTimer.unref?.();
			return;
		}
		const goal = this.hooks.getGoal();
		if (!goal || goal.id !== scheduledGoalId) {
			if (this.continuationQueuedFor === scheduledGoalId) this.continuationQueuedFor = null;
			return;
		}
		this.checkpointSeq += 1;
		this.continuationQueuedFor = goal.id;
		const details: GoalCheckpointDetailsV2 = {
			version: 2,
			kind: "checkpoint",
			goalId: goal.id,
			status: "active",
			revision: goal.revision ?? 0,
			checkpointSeq: this.checkpointSeq,
			timestamp: Date.now(),
		};
		this.hooks.sendFollowUp(checkpointTriggerPrompt(goal.id), details as unknown as Record<string, unknown>);
	}

	// ── turn-stop guard ──────────────────────────────────────────────────

	advanceTurn(): void {
		this.turnSeq += 1;
		if (this.turnStoppedFor?.turnSeq !== this.turnSeq) this.turnStoppedFor = null;
	}

	/** Mark the current turn stopped after a terminal/mutating goal tool. */
	markTurnStopped(goalId: string): void {
		this.turnStoppedFor = { goalId, turnSeq: this.turnSeq };
	}

	/** Goal id that stopped the current turn, or null. Stale markers are dropped. */
	currentTurnStoppedGoalId(): string | null {
		if (!this.turnStoppedFor) return null;
		if (this.turnStoppedFor.turnSeq !== this.turnSeq) {
			this.turnStoppedFor = null;
			return null;
		}
		return this.turnStoppedFor.goalId;
	}

	// ── stale checkpoint state ───────────────────────────────────────────

	setCheckpoint(goalId: string | null): void {
		this.checkpointGoalId = goalId;
	}

	getCheckpointGoalId(): string | null {
		return this.checkpointGoalId;
	}

	/** Tools blocked when a stale checkpoint triggered the current turn. */
	isStaleCheckpointBlocked(toolName: string): boolean {
		return !POST_STOP_ALLOWED.has(toolName);
	}

	// ── one-time steering reminders ──────────────────────────────────────

	armPostCompactReminder(): void {
		this.postCompactReminderPending = true;
	}

	/** Whether a post-compaction reminder is pending (read-only). */
	isPostCompactReminderPending(): boolean {
		return this.postCompactReminderPending;
	}

	clearPostCompactReminder(): void {
		this.postCompactReminderPending = false;
	}

	/** True once if a post-compaction reminder is pending; clears it. */
	consumePostCompactReminder(): boolean {
		if (!this.postCompactReminderPending) return false;
		this.postCompactReminderPending = false;
		return true;
	}

	armPostBudgetReminder(): void {
		this.postBudgetReminderPending = true;
	}

	/** True once if a post-budget-limit reminder is pending; clears it. */
	consumePostBudgetReminder(): boolean {
		if (!this.postBudgetReminderPending) return false;
		this.postBudgetReminderPending = false;
		return true;
	}
}
