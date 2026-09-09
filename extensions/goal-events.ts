import type { ExtensionContext, InputSource } from "@earendil-works/pi-coding-agent";
import {
	GOAL_EVENT_ENTRY,
	assistantTurnTokens,
	extractGoalIdFromInjectedMessage,
	goalEventMessageId,
	hasAbortedAssistantMessage,
	hasErrorAssistantMessage,
	hasNetworkErrorAssistantMessage,
	isAbortedAssistantMessage,
	isErrorAssistantMessage,
	isTerminalProviderError,
	isToolUseAssistantMessage,
} from "./goal-format.ts";
import { buildCompactionSummary, buildPostCompactionGoalDelta } from "./goal-compaction.ts";
import { latestAuditorResultForGoal, loadLedgerState, readGoalLedger, invalidateGoalLedgerCache } from "./goal-ledger.ts";
import { shouldArmPostCompactReminder, shouldInjectPostCompactReminder } from "./goal-policy.ts";
import { formatTokenValue } from "./goal-core.ts";
import { loadGoalSettings, invalidateGoalSettingsCache } from "./goal-settings.ts";
import { budgetLine, budgetRemaining } from "./goal-accounting.ts";
import { asRecord, nowIso, type AssistantMessageLike, type GoalRecord, type GoalOwnedWork } from "./goal-record.ts";
import { goalSelectorLabel } from "./goal-pool.ts";
import { invalidateGoalPoolCache } from "./storage/goal-files.ts";
import { checkpointTriggerPrompt } from "./prompts/goal-prompts.ts";
import { consumeOracleFollowupMarker, hasPendingOracleAdviceForFocusedGoal } from "./goal-oracle.ts";
import { countTrailingNoProgressRuns } from "./goal-tool-names.ts";
import { GoalProgressEvidenceTracker } from "./goal-progress-evidence.ts";
import {
	delegatedOwnershipFromMessages,
	isAsyncDelegationCall,
	ownedLaunchId,
	ownedTerminalIdentity,
	type DelegatedWakeKind,
} from "./goal-delegated-progress.ts";
import {
	goalPrompt,
	noProgressRecoveryPrompt,
	scheduledWaitPrompt,
	continuationHoldPrompt,
	currentGoalLifecycleSnapshot,
	staleContinuationPrompt,
	unfocusedOpenGoalsPrompt,
	untrustedObjectiveBlock,
} from "./prompts/goal-prompts.ts";
import { rehydrateDraft } from "./goal-drafting.ts";
import { syncTerminalInputPause } from "./goal-widget.ts";
import type { GoalCore } from "./goal-state.ts";
import { goalHoldAdmissionKey, goalReviewScope, runGoalProgressReviewFlow } from "./goal-review.ts";
import { diagnosticHash, GOAL_SOURCE_HASH, recordGoalDiagnostic, redactDiagnosticText } from "./goal-diagnostics.ts";
import { archiveCompletedGoal } from "./goal-archive.ts";
import { collectLatestUserDecisions, GOAL_USER_DECISION_ENTRY } from "./goal-user-decisions.ts";

export { collectLatestUserDecisions } from "./goal-user-decisions.ts";

/**
 * Issue #30: provider-context checkpoint compaction (pure helper).
 *
 * Every historical checkpoint message is redundant: its authoritative state is
 * reconstructed from goal storage and injected once per turn by
 * before_agent_start. Normal provider requests therefore retain at most ONE
 * checkpoint marker — the latest — rewritten to the tiny bounded v2 trigger
 * content. Keeping one user-role turn-start marker avoids provider edge cases
 * where removing it would leave the request ending on an assistant or tool
 * result. Audit events, user messages, assistant messages, and tool results
 * pass through untouched.
 */

export function compactGoalCheckpointContext(
	messages: readonly unknown[],
	currentGoal: GoalRecord | null,
): unknown[] | null {
	let lastCheckpointIndex = -1;
	for (let i = 0; i < messages.length; i += 1) {
		if (goalEventMessageId(messages[i] as { customType?: string; details?: unknown; content?: unknown }) !== null) {
			lastCheckpointIndex = i;
		}
	}
	if (lastCheckpointIndex < 0) return null;

	const output: unknown[] = [];
	for (let i = 0; i < messages.length; i += 1) {
		const message = messages[i] as { customType?: string; details?: unknown; content?: unknown };
		const checkpointGoalId = goalEventMessageId(message);
		if (checkpointGoalId === null) {
			output.push(messages[i]);
			continue;
		}
		// Every historical checkpoint is dropped entirely.
		if (i !== lastCheckpointIndex) continue;
		output.push({
			...(message as Record<string, unknown>),
			content: checkpointTriggerPrompt(checkpointGoalId),
			display: false,
			details: {
				version: 2,
				kind: currentGoal?.id === checkpointGoalId && currentGoal?.status === "active" ? "checkpoint" : "stale",
				goalId: checkpointGoalId,
				currentGoalId: currentGoal?.id ?? null,
				currentStatus: currentGoal?.status ?? null,
			},
		});
	}
	return output;
}

/**
 * The goal extension's lifecycle event handlers (context, turn_start,
 * tool_call, tool_execution_end, turn_end, message_end, session_start,
 * session_before_compact, session_compact, session_tree, before_agent_start,
 * agent_end, agent_settled, session_shutdown). All state flows through the
 * GoalCore.
 */
export function registerGoalEvents(core: GoalCore): void {
	const { pi } = core;
	let continuationAfterSettleFor: string | null = null;
	let reviewAfterSettleFor: string | null = null;
	let networkErrorRecoveryAfterSettleFor: string | null = null;
	let executionRecoveryAfterSettleFor: string | null = null;
	let providerRetryEnabled = false;
	let providerRetryContext: ExtensionContext | undefined;
	let providerRetryOwner: { retryId: number; goalId: string; epoch: number; scope: string; sessionId: string; ctx: ExtensionContext } | undefined;
	pi.events?.on?.("pi-retry:state", (payload) => {
		providerRetryEnabled = asRecord(payload)?.effectiveEnabled === true;
		if (providerRetryEnabled) core.runtime.clearNetworkErrorBackoff();
	});
	pi.events?.on?.("pi-retry:started", (payload) => {
		const retryId = asRecord(payload)?.retryId;
		const goal = core.state.goal;
		const ctx = providerRetryContext;
		const sessionId = ctx?.sessionManager?.getSessionId?.();
		if (typeof retryId !== "number" || !Number.isSafeInteger(retryId) || !goal || !ctx || !sessionId) return;
		providerRetryOwner = { retryId, goalId: goal.id, epoch: core.continuationEpoch, scope: goalReviewScope(goal), sessionId, ctx };
		core.runtime.clearNetworkErrorBackoff();
	});
	const providerRetrySettled = (payload: unknown): void => {
		const result = asRecord(payload);
		const owner = providerRetryOwner;
		if (!owner || result?.retryId !== owner.retryId) return;
		providerRetryOwner = undefined;
		const goal = core.state.goal;
		if (result.reason !== "bounded_recovery_exhausted" || !goal || goal.id !== owner.goalId || core.continuationEpoch !== owner.epoch || goalReviewScope(goal) !== owner.scope || providerRetryContext?.sessionManager?.getSessionId?.() !== owner.sessionId || goal.continuation?.hold || goal.continuation?.wake || !core.isActionableContinuationGoal(goal.id)) return;
		core.runtime.retainContinuationHold(owner.ctx, goal, owner.scope, "Three non-traffic provider reissues exhausted; no automatic retry is scheduled.", ["The originating native retry owner exhausted its bounded admission."], goalHoldAdmissionKey(goal, owner.ctx, pi.getThinkingLevel?.()));
		core.updateUI(owner.ctx);
	};
	pi.events?.on?.("pi-retry:completed", providerRetrySettled);
	pi.events?.on?.("pi-retry:cancelled", providerRetrySettled);
	pi.events?.emit?.("pi-retry:state-request", {});
	let consecutiveNoProgressTurns = 0;
	let toolCyclesSinceReview = 0;
	const falsePausedReconciliationIssued = new Set<string>();
	const recentReviewEvidence: string[] = [];
	let noProgressRecoveryAttempt = 0;
	let noProgressScopeGoalId: string | null = null;
	let noProgressScopeEpoch = 0;
	let delegatedWakeThisRun: DelegatedWakeKind | null = null;
	let pendingInputSource: InputSource | null = null;
	let pendingInputText = "";
	const pendingAsyncDelegations = new Map<string, Omit<GoalOwnedWork, "id"> & { goalId: string }>();
	const explicitWaitOverride = (text: string): boolean => {
		const normalized = text.trim();
		if (!normalized) return false;
		// Status/polling and ambiguous prose must not discard a durable wait.
		// Only unmistakable lifecycle or scope commands supersede its lease.
		if (/[?？]/u.test(normalized) || /\b(?:not|never|don't|don’t|do\s+not)\b/iu.test(normalized)) return false;
		return /^\/goal-(?:resume|pause|cancel|clear|focus|unfocus|tweak|budget)(?:\s|$)/iu.test(normalized)
			|| /^(?:please\s+)?(?:resume|pause|cancel|stop|abort|focus|unfocus)(?:\s+(?:(?:the|this|my)\s+)?(?:goal|work|task))?(?:\s+now)?[.!]?$/iu.test(normalized)
			|| /^(?:please\s+)?(?:tweak|revise|change|replace|retarget)\s+(?:(?:the|this|my)\s+)?(?:goal|objective|scope|task|requirement|criteria)\b/iu.test(normalized)
			|| /^(?:please\s+)?(?:increase|raise|change|reset|remove)\s+(?:(?:the|this|my)\s+)?(?:budget|token limit)\b/iu.test(normalized);
	};
	const explicitHoldInstruction = (text: string): boolean => explicitWaitOverride(text)
		|| (!/[?？]/u.test(text) && !/\b(?:not|never|don't|don’t)\b/iu.test(text)
			&& /^(?:please\s+)?(?:inspect|read|check|compare|evaluate|investigate|test|run|retry|use|implement|fix|continue|proceed)\b/iu.test(text.trim()));
	const progressEvidence = new GoalProgressEvidenceTracker();
	const rememberReviewEvidence = (entry: string): void => {
		const bounded = redactDiagnosticText(entry.trim(), 600);
		if (!bounded) return;
		recentReviewEvidence.push(bounded);
		while (recentReviewEvidence.length > 8) recentReviewEvidence.shift();
	};
	const assistantText = (message: unknown): string => {
		const raw = asRecord(message);
		if (raw?.role !== "assistant") return "";
		if (typeof raw.content === "string") return raw.content;
		return Array.isArray(raw.content) ? raw.content.filter((part) => asRecord(part)?.type === "text").map((part) => String(asRecord(part)?.text ?? "")).join("\n") : "";
	};
	const claimsPaused = (messages: unknown[]): boolean => {
		// Inspect the final assistant text, not quoted history or old tool turns.
		const last = [...messages].reverse().map(assistantText).find((text) => text.trim());
		return Boolean(last?.split(/\r?\n/u).some((line) => {
			if (/^\s*[>"'`]/u.test(line) || /[?？]/u.test(line)) return false;
			if (/\b(?:not|never|no longer|was|were|previously|earlier|yesterday|historical|said|claimed|if|when)\b/iu.test(line)) return false;
			return /\b(?:the\s+)?(?:goal|work|session)\s+(?:is|remains)\s+(?:currently\s+|still\s+)?paused\b/iu.test(line);
		}));
	};
	const actualReviewEvidence = (reason?: string): string => [...recentReviewEvidence, reason ? `Review admission: ${reason}` : ""].filter(Boolean).join("\n").slice(-4_000);
	const latestUserDecisions = (ctx: ExtensionContext, goalId: string): string => collectLatestUserDecisions(ctx.sessionManager?.getBranch?.() ?? [], goalId);
	const recordMeaningfulWorkAttempt = (ctx: ExtensionContext, toolName: string): void => {
		core.goalWorkToolCalledThisTurn = true;
		if (toolName !== "update_goal") {
			core.goalWorkToolProductiveThisTurn = true;
			const recoveryGoalId = core.state.goal?.id;
			if (recoveryGoalId) core.runtime.clearAuditRecovery(recoveryGoalId);
		}
		// Issue #26: record a meaningful work attempt against armed Oracle advice.
		const focusedId = core.focusedGoalId;
		if (!focusedId || !hasPendingOracleAdviceForFocusedGoal(focusedId)) return;
		const armed = consumeOracleFollowupMarker(focusedId);
		if (!armed) return;
		try {
			core.goalService.appendEvents(ctx, [{
				type: "oracle_followup_attempted",
				goalId: armed.goalId,
				fingerprint: armed.fingerprint,
				adviceId: armed.adviceId,
				firstToolName: toolName,
				at: nowIso(),
			}]);
		} catch { /* best-effort ledger append */ }
	};

	const refreshHeldAdmission = (ctx: ExtensionContext): void => {
		const goal = core.state.goal;
		const hold = goal?.continuation?.hold;
		if (!goal || !core.isActionableContinuationGoal(goal.id)) return;
		if (!hold && (goal.continuation?.wake || !core.runtime.isProgressReviewExhausted?.(goal))) return;
		invalidateGoalSettingsCache();
		const key = goalHoldAdmissionKey(goal, ctx, pi.getThinkingLevel?.());
		if (!hold) {
			core.runtime.retainContinuationHold(ctx, goal, goalReviewScope(goal), "Earlier independent reviews exhausted their admission; no automatic retry is scheduled.", ["Legacy review-exhaustion state was restored without a continuation owner."], key);
			return;
		}
		if (hold.admissionKey === key) return;
		const changed = Boolean(hold.admissionKey);
		const outcome = core.goalService.apply(ctx, {
			focusToken: core.focusedOperationToken(goal.id),
			mutate: (current) => ({ ...current, continuation: changed ? undefined : { ...current.continuation!, hold: { ...hold, admissionKey: key } } }),
		});
		if (outcome.ok && changed) {
			rememberReviewEvidence("Relevant goal scope or selected configuration changed; independently review the held work again.");
			core.runtime.requestProgressReview(goal.id);
		}
	};
	const consumeOwnedTerminal = (ctx: ExtensionContext, message: unknown): void => {
		const terminal = ownedTerminalIdentity(message);
		const goal = core.state.goal;
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (!terminal || !goal || !sessionId || !core.isActionableContinuationGoal(goal.id)) return;
		const owned = goal.ownedWork?.find((work) => work.id === terminal.id && work.kind === terminal.kind && work.sessionId === sessionId && work.scope === goalReviewScope(goal));
		if (!owned) return;
		const held = Boolean(goal.continuation?.hold) && !goal.continuation?.wake;
		const outcome = core.goalService.apply(ctx, {
			focusToken: core.focusedOperationToken(goal.id),
			mutate: (current) => ({ ...current, ownedWork: current.ownedWork?.filter((work) => work.id !== owned.id || work.kind !== owned.kind), ...(held ? { continuation: undefined } : {}) }),
		});
		if (!outcome.ok) return;
		rememberReviewEvidence(`Owned ${owned.kind} ${owned.id} has a terminal receipt. Inspect its result; this does not prove criterion success.`);
		delegatedWakeThisRun = "terminal";
		if (held) core.runtime.requestProgressReview(goal.id);
	};

	pi.on("input", (event) => {
		// The SDK's input source is the provenance boundary: interactive and RPC
		// are user-originated, while extension prompts include NQA/background wakes.
		pendingInputSource = event.source;
		pendingInputText = event.text;
		const goal = core.state.goal;
		if (goal && core.focusedGoalId === goal.id && (event.source === "interactive" || event.source === "rpc") && event.text.trim()) {
			core.markUserDecision();
			try {
				core.pi.appendEntry(GOAL_USER_DECISION_ENTRY, {
					version: 1,
					goalId: goal.id,
					focusEpoch: core.continuationEpoch,
					focusGoalId: goal.id,
					source: event.source,
					kind: "message",
					text: event.text.slice(0, 2_000),
				});
			} catch {
				// Provenance is fail-closed: an unrecorded input is never inferred
				// from the ordinary user transcript by the reviewer.
			}
		}
	});

	pi.on("context", async (event, ctx) => {
		core.reconcileFocusedGoalFromDisk(ctx, { preserveMemoryUsage: true });
		const ownership = delegatedOwnershipFromMessages(event.messages);
		if (ownership) delegatedWakeThisRun = ownership;
		consumeOwnedTerminal(ctx, event.messages.at(-1));
		refreshHeldAdmission(ctx);
		const snapshot = currentGoalLifecycleSnapshot(core.state.goal);
		const messages = (compactGoalCheckpointContext(event.messages, core.state.goal) ?? event.messages)
			.filter((message) => asRecord(message)?.customType !== "pi-goal-current-lifecycle");
		recordGoalDiagnostic(ctx, { type: "request_context", stage: "context-hook-not-final-wire", lifecycle: snapshot, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, effort: pi.getThinkingLevel?.(), promptHash: diagnosticHash(ctx.getSystemPrompt?.() ?? "") });
		return { messages: [...messages, {
			role: "custom", customType: "pi-goal-current-lifecycle", display: false, timestamp: Date.now(),
			content: `${snapshot}\nThis is the current host-owned lifecycle frame. It supersedes historical prose and turn-start state. Only ACTIVE without a hold/wait and with auto-continuation enabled admits autonomous work; otherwise preserve the recorded lifecycle and continuation owner.`,
		}] as typeof event.messages };
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload = asRecord(event.payload);
		const prompt = payload?.instructions ?? payload?.system ?? (Array.isArray(payload?.messages) ? payload.messages.filter((message) => ["system", "developer"].includes(String(asRecord(message)?.role))) : undefined);
		recordGoalDiagnostic(ctx, { type: "provider_request", stage: "before_provider_request-hook-not-final-wire", lifecycle: currentGoalLifecycleSnapshot(core.state.goal), model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, effort: pi.getThinkingLevel?.(), payloadModel: typeof payload?.model === "string" ? payload.model : undefined, promptHash: prompt === undefined ? undefined : diagnosticHash(prompt) });
	});

	pi.on("agent_start", async () => {
		// A Pi agent run may contain many provider turns while tools execute. Reset
		// progress once per run so work from an earlier tool turn survives the
		// final text-only provider turn and reaches the no-progress coach.
		core.goalWorkToolCalledThisTurn = false;
		core.goalWorkToolProductiveThisTurn = false;
		core.goalWorkToolDeniedThisTurn = false;
		if (delegatedWakeThisRun !== "awaiting") delegatedWakeThisRun = null;
		pendingAsyncDelegations.clear();
		progressEvidence.beginAgentRun();
	});

	pi.on("turn_start", async (_event, ctx) => {
		core.advanceTurnSeq();
		core.beginAccounting();
		core.goalService.beginTurn(ctx, core.focusedGoalId); // P1-3 transaction buffer
		core.touchGoalActivity(); // F5
		core.updateUI(ctx);
	});

	// #4 + C9 fix + Phase 5 C3: gate in-turn tool calls based on lifecycle state.
	pi.on("tool_call", async (event, ctx) => {
		toolCyclesSinceReview += 1;
		if (toolCyclesSinceReview >= 12 && core.state.goal?.status === "active" && core.state.goal.autoContinue && !core.state.goal.continuation?.wake && !core.state.goal.continuation?.hold) {
			// Periodic review is admission at a settled boundary, not a stopping
			// rule: productive tool cycles cannot postpone whole-goal inspection forever.
			core.runtime.requestProgressReview(core.state.goal.id);
		}
		rememberReviewEvidence(`tool ${event.toolName} invoked`);
		const stoppedGoalId = core.currentTurnStoppedGoalId();
		// Post-stop in-turn block: after update_goal / set_goal_tasks (or a user
		// lifecycle command) fires in this turn, block all subsequent tool calls
		// except read-only inspection.
		if (stoppedGoalId !== null && core.runtime.isStaleCheckpointBlocked(event.toolName)) {
			return {
				block: true,
				reason: `The goal was already stopped earlier in this turn (goalId=${stoppedGoalId}). ` +
					`Do not call more tools; end the turn with a brief summary and yield to the user.`,
			};
		}
		// Stale checkpoint guard: if the turn was triggered by a queued continuation
		// for a goal that is no longer active/autoContinue, block work tools.
		const checkpointGoalId = core.runtime.getCheckpointGoalId();
		if (checkpointGoalId !== null && !core.isActionableContinuationGoal(checkpointGoalId) && core.isStaleCheckpointBlockedToolCall(event.toolName)) {
			// Block the tool call with a stale-checkpoint message.
			return {
				block: true,
				reason: `Cannot call ${event.toolName}: the goal checkpoint that triggered this turn is no longer active. ` +
					`Goal ${checkpointGoalId} has been paused, cleared, or replaced. ` +
					`End the turn with a brief summary and yield to the user.`,
			};
		}
		// Track for #4 empty-turn gate. Mutation tools are credited at call time;
		// observational tools are credited only after a changed successful result.
		const eventRecord = asRecord(event);
		const toolInput = eventRecord?.input ?? eventRecord?.args;
		const launchGoal = core.state.goal;
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (isAsyncDelegationCall(event.toolName, toolInput) && typeof eventRecord?.toolCallId === "string" && launchGoal && sessionId && core.isActionableContinuationGoal(launchGoal.id)) {
			pendingAsyncDelegations.set(eventRecord.toolCallId, { goalId: launchGoal.id, kind: event.toolName as "bg_run" | "subagent", scope: goalReviewScope(launchGoal), sessionId });
		}
		if (progressEvidence.observeCall(eventRecord?.toolCallId, event.toolName, toolInput)) {
			recordMeaningfulWorkAttempt(ctx, event.toolName);
		}
		return;
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const eventRecord = asRecord(event);
		const toolCallId = eventRecord?.toolCallId;
		const launch = typeof toolCallId === "string" ? pendingAsyncDelegations.get(toolCallId) : undefined;
		if (typeof toolCallId === "string") pendingAsyncDelegations.delete(toolCallId);
		if (launch && eventRecord?.isError !== true && asRecord(eventRecord?.result)?.isError !== true) {
			recordMeaningfulWorkAttempt(ctx, "subagent");
			delegatedWakeThisRun = "awaiting";
			const id = ownedLaunchId(eventRecord?.result, launch.kind);
			if (id && core.isActionableContinuationGoal(launch.goalId)) core.goalService.apply(ctx, {
				focusToken: core.focusedOperationToken(launch.goalId),
				mutate: (current) => ({ ...current, ownedWork: [...(current.ownedWork ?? []).filter((work) => work.id !== id || work.kind !== launch.kind), { id, kind: launch.kind, scope: launch.scope, sessionId: launch.sessionId }].slice(-32) }),
			});
		}
		if (progressEvidence.observeResult(toolCallId, eventRecord?.result, eventRecord?.isError)) {
			recordMeaningfulWorkAttempt(ctx, typeof eventRecord?.toolName === "string" ? eventRecord.toolName : "observational-tool");
		}
		const outcomeName = typeof eventRecord?.toolName === "string" ? eventRecord.toolName : "tool";
		let outcome = "(no output captured)";
		try {
			const rawOutcome = eventRecord?.result;
			const rawContent = rawOutcome && typeof rawOutcome === "object" ? (rawOutcome as Record<string, unknown>).content : undefined;
			const content = Array.isArray(rawContent)
				? rawContent
					.filter((part: unknown) => asRecord(part)?.type === "text")
					.map((part: unknown) => String(asRecord(part)?.text ?? ""))
					.join(" ")
				: typeof rawOutcome === "string" ? rawOutcome : JSON.stringify(rawOutcome ?? "");
			outcome = redactDiagnosticText(content, 400);
		} catch { /* evidence capture is best effort */ }
		rememberReviewEvidence(`${outcomeName} ${eventRecord?.isError === true ? "failed" : "completed"}: ${outcome}`);
		core.touchGoalActivity(); // F5
		core.accountProgress(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message as AssistantMessageLike;
		const tokens = assistantTurnTokens(message);
		core.touchGoalActivity(); // F5
		core.accountProgress(ctx, { completedTurnTokens: tokens });

		if (isAbortedAssistantMessage(message)) {
			// Pause only on a genuine user abort (signal fired). A provider- or
			// transport-side abort without the signal routes into recovery via
			// agent_end instead of stranding the goal.
			if (ctx.signal?.aborted) core.pauseActiveGoal(ctx);
			return;
		}
		// Provider failures are not completed work: do not turn one failed turn
		// into an unbounded auto-continue retry storm. Keep the display
		// reconciled (and accounting already ran above), but never queue a
		// continuation for an error turn (danim47c pattern).
		if (isErrorAssistantMessage(message)) {
			core.refreshGoalDisplayFromDisk(ctx);
			core.updateUI(ctx);
			return;
		}
		core.refreshGoalDisplayFromDisk(ctx);

		// Completion can happen from the post-settlement reviewer, so the
		// deferred archival operation is shared with the normal turn_end path.
		if (core.state.goal?.status === "complete" && !core.state.goal?.archivedPath) {
			if (!archiveCompletedGoal(core, ctx)) {
				ctx.ui.notify(`Failed to archive completed goal. The complete record remains at ${core.state.goal.activePath ?? "(unknown)"}.`, "warning");
			}
			core.updateUI(ctx);
		}

		// If the assistant ended a turn without queuing more tool calls, push a continuation right away.
		// #4: only queue if some real work was done this turn — otherwise the model is
		// just chatting and we should not keep firing turns on noise.
		const productiveRun = core.goalWorkToolCalledThisTurn
			&& (!core.goalWorkToolDeniedThisTurn || core.goalWorkToolProductiveThisTurn);
		if (
			!isToolUseAssistantMessage(message)
			&& core.state.goal?.status === "active"
			&& core.state.goal.autoContinue
			&& productiveRun
		) {
			core.queueContinuation(ctx);
		}
		core.goalService.endTurn(ctx); // P1-3: single flush (lock + write + ledger batch)
	});

	pi.on("message_end", async (event, ctx) => {
		// Signal-aware: see turn_end — only user aborts pause; provider-side
		// aborts are handled by agent_end's recovery path.
		if (isAbortedAssistantMessage(event.message) && ctx.signal?.aborted) core.pauseActiveGoal(ctx);
		const raw = asRecord(event.message);
		if (raw?.role === "custom" && raw.customType === GOAL_EVENT_ENTRY && raw.display !== false) {
			return { message: { ...event.message, display: false } as typeof event.message };
		}
	});

	pi.on("session_start", async (event, ctx) => {
		providerRetryContext = ctx;
		providerRetryOwner = undefined;
		pi.events?.emit?.("pi-retry:state-request", {});
		recordGoalDiagnostic(ctx, { type: "initialization", component: "pi-goal-x", stage: "source-snapshot-at-module-initialization", sourceHash: GOAL_SOURCE_HASH });
		// NAF: the zero-op read caches are session-scoped — a new session always
		// re-reads settings/pool/ledger fresh from disk (cross-process and
		// hand-edited changes are picked up at the session boundary).
		invalidateGoalSettingsCache();
		invalidateGoalPoolCache();
		invalidateGoalLedgerCache();
		core.goalService.flushTurn(ctx); // P1-3: persist any buffered transaction before reload
		await core.loadState(ctx);
		core.installGoalToolProfile(!loadGoalSettings(ctx.cwd).disableTasks);
		rehydrateDraft(core, ctx);
		syncTerminalInputPause(core, ctx);
		if (event.reason === "resume" && !core.state.goal && !core.hasExplicitSessionFocus && core.openGoals().length > 1 && ctx.hasUI) {
			// Prompt the user to pick which open goal to focus (mirrors /goal-focus).
			const open = core.openGoals();
			const labels = open.map((item) => goalSelectorLabel(item, core.focusedGoalId));
			const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
			core.enterGoalModal();
			try {
				const selected = await ctx.ui.select("Focus open goal", labels);
				const selectedId = selected ? byLabel.get(selected) : undefined;
				if (selectedId) {
					core.setFocusedGoalId(selectedId, ctx, "selected");
					core.armFocusedContinuation(ctx);
				}
			} finally {
				core.exitGoalModal();
			}
		}
		// Codex behavior: prompt before reactivating a paused goal on resume.
		if (event.reason === "resume" && core.state.goal?.status === "paused" && ctx.hasUI) {
			const current = core.state.goal;
			const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${current.objective}`);
			if (shouldResume) {
				core.setGoal({ ...current, status: "active", autoContinue: true, stopReason: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
			}
		}
		if (core.state.goal?.status === "active" && core.state.goal.autoContinue) {
			const auditHistory = readGoalLedger(ctx).events.filter((entry) =>
				(entry.type === "audit_result" || entry.type === "audit_retry_reset") && entry.goalId === core.state.goal!.id,
			);
			let lastReset = -1;
			for (let index = auditHistory.length - 1; index >= 0; index -= 1) {
				if (auditHistory[index]?.type === "audit_retry_reset") {
					lastReset = index;
					break;
				}
			}
			const auditResults = auditHistory.slice(lastReset + 1).filter((entry) => entry.type === "audit_result");
			const latestResult = auditResults.at(-1);
			if (latestResult?.type === "audit_result" && latestResult.verdict === "error") {
				let attempts = 0;
				for (let index = auditResults.length - 1; index >= 0; index -= 1) {
					const entry = auditResults[index];
					if (!entry || entry.type !== "audit_result" || entry.verdict !== "error") break;
					attempts += 1;
				}
				core.runtime.restoreAuditRetry(ctx, core.state.goal, attempts, latestResult.at);
			}
		}
		core.beginAccounting();
		noProgressScopeGoalId = core.state.goal?.id ?? null;
		noProgressScopeEpoch = core.continuationEpoch;
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		consecutiveNoProgressTurns = countTrailingNoProgressRuns(branch, core.focusedGoalId);
		if (consecutiveNoProgressTurns > 0) noProgressRecoveryAttempt = consecutiveNoProgressTurns;
		refreshHeldAdmission(ctx);
		core.queueContinuation(ctx, true);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		core.accountProgress(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		core.goalService.flushTurn(ctx); // P1-3: persist any buffered transaction before reload
		if (core.state.goal) core.persist(ctx);
		core.beginAccounting();
		noProgressScopeGoalId = core.state.goal?.id ?? null;
		noProgressScopeEpoch = core.continuationEpoch;
		// Arm a deterministic compaction summary for the next agent turn.
		// This replaces the generic reminder with artifact-backed state.
		if (shouldArmPostCompactReminder(core.state.goal)) {
			core.runtime.armPostCompactReminder();
		}
		const compactBranch = ctx.sessionManager?.getBranch?.() ?? [];
		consecutiveNoProgressTurns = countTrailingNoProgressRuns(compactBranch, core.focusedGoalId);
		if (consecutiveNoProgressTurns > 0) noProgressRecoveryAttempt = consecutiveNoProgressTurns;
		refreshHeldAdmission(ctx);
		core.queueContinuation(ctx, true);
	});

	pi.on("session_tree", async (_event, ctx) => {
		core.goalService.flushTurn(ctx); // P1-3: persist any buffered transaction before reload
		await core.loadState(ctx);
		rehydrateDraft(core, ctx);
		syncTerminalInputPause(core, ctx);
		core.beginAccounting();
		noProgressScopeGoalId = core.state.goal?.id ?? null;
		noProgressScopeEpoch = core.continuationEpoch;
		const treeBranch = ctx.sessionManager?.getBranch?.() ?? [];
		consecutiveNoProgressTurns = countTrailingNoProgressRuns(treeBranch, core.focusedGoalId);
		if (consecutiveNoProgressTurns > 0) noProgressRecoveryAttempt = consecutiveNoProgressTurns;
		refreshHeldAdmission(ctx);
		core.queueContinuation(ctx, true);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		providerRetryContext = ctx;
		core.advanceTurnSeq();
		// event.systemPrompt is the SDK's current-turn chain. ctx.getSystemPrompt()
		// is the previous effective prompt and would accumulate stale lifecycle frames.
		let effectiveSystemPrompt = event.systemPrompt;
		const currentSystemPrompt = () => effectiveSystemPrompt;
		const incomingGoalId = extractGoalIdFromInjectedMessage(event.prompt ?? "");
		const inputSource = pendingInputSource;
		const inputText = pendingInputText;
		pendingInputSource = null;
		pendingInputText = "";
		const explicitUserInput = inputSource === "interactive" || inputSource === "rpc";
		// Several prompt enrichments may need the same ledger snapshot. Keep one
		// local read for this hook instead of repeatedly traversing the cached
		// ledger when rejection and post-compaction steering overlap.
		let promptLedger: ReturnType<typeof readGoalLedger> | undefined;
		const getPromptLedger = () => promptLedger ??= readGoalLedger(ctx);

		// If this turn was triggered by a hidden goal checkpoint that no longer
		// matches the active goal, abort the whole turn instead of letting the
		// model act on a stale instruction.
		if (incomingGoalId !== null) {
			// Reconcile from disk to pick up any external state changes before
			// evaluating whether the checkpoint is actionable.
			core.reconcileFocusedGoalFromDisk(ctx);
			core.runtime.setCheckpoint(incomingGoalId);
			// This can be the hidden checkpoint dispatched by the network-error
			// timer. Clear ordinary continuation bookkeeping but retain the
			// consecutive recovery count for a later failed retry.
			core.clearContinuationState(false);
			if (!core.isActionableContinuationGoal(incomingGoalId)) {
				try {
					ctx.abort?.();
				} catch {}
				core.updateUI(ctx);
				return {
					systemPrompt: `${currentSystemPrompt()}\n\n${staleContinuationPrompt(incomingGoalId, core.state.goal)}`,
				};
			}
			core.runtime.setCheckpoint(null);
		} else if (explicitUserInput) {
			const waitingGoal = core.state.goal;
			const preserveWait = waitingGoal?.continuation?.wake ? !explicitWaitOverride(inputText)
				: Boolean(waitingGoal?.continuation?.hold) && !explicitHoldInstruction(inputText);
			core.reviewAbortController?.abort();
			// Only the SDK's interactive/RPC input provenance is user-owned. An
			// extension-originated prompt (NQA, a tool, or a background wake) must
			// not reset audit admission or compete with its recovery lease. Ordinary
			// status questions retain the durable wait; clear it only for an explicit
			// lifecycle/scope override.
			core.runtime.setCheckpoint(null);
			if (!preserveWait) core.clearContinuationState();
			if (!preserveWait && waitingGoal?.continuation?.wake) {
				core.runtime.cancelDeferredWake(waitingGoal.id);
				core.goalService.apply(ctx, {
					reconcile: false,
					focusToken: core.focusedOperationToken(waitingGoal.id),
					mutate: (current) => ({ ...current, continuation: undefined, updatedAt: nowIso() }),
				});
			} else if (!preserveWait && waitingGoal?.continuation?.hold) {
				// A genuine new instruction re-admits review/work. Status queries do
				// not reach this branch and therefore preserve the durable hold.
				core.goalService.apply(ctx, {
					reconcile: false,
					focusToken: core.focusedOperationToken(waitingGoal.id),
					mutate: (current) => ({ ...current, continuation: undefined, updatedAt: nowIso() }),
				});
			}
			if (core.state.goal && !preserveWait) {
				core.runtime.clearAuditRetry(core.state.goal.id);
				try {
					core.goalService.appendEvents(ctx, [{ type: "audit_retry_reset", goalId: core.state.goal.id, reason: "user_input", at: nowIso() }]);
				} catch {
					// A reset marker is best effort; the in-memory admission is still cleared.
				}
			}
			networkErrorRecoveryAfterSettleFor = null;
			consecutiveNoProgressTurns = 0;
			noProgressRecoveryAttempt = 0;
		}

		if (!core.state.goal) {
			core.runningGoalId = null;
			const openCount = core.openGoals().length;
			if (openCount > 0) {
				return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			}
			return;
		}
		core.reconcileFocusedGoalFromDisk(ctx);
		if (!core.state.goal) {
			core.runningGoalId = null;
			const openCount = core.openGoals().length;
			if (openCount > 0) return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			return;
		}
		refreshHeldAdmission(ctx);
		const currentScopeGoalId = core.state.goal!.id;
		const currentScopeEpoch = core.continuationEpoch;
		// This snapshot is derived from reconciled goal storage in this hook, not
		// from prior assistant prose or checkpoint content.
		effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${currentGoalLifecycleSnapshot(core.state.goal)}\nThe latest host-owned pi-goal-current-lifecycle context frame supersedes this turn-start snapshot if state changes during tools.`;
		if (noProgressScopeGoalId !== currentScopeGoalId || noProgressScopeEpoch !== currentScopeEpoch) {
			// A new goal, focus epoch, or successful tweak must not inherit the
			// previous goal/revision's empty-turn coaching state.
			toolCyclesSinceReview = 0;
			recentReviewEvidence.length = 0;
			falsePausedReconciliationIssued.clear();
			consecutiveNoProgressTurns = 0;
			noProgressRecoveryAttempt = 0;
		}
		noProgressScopeGoalId = currentScopeGoalId;
		noProgressScopeEpoch = currentScopeEpoch;
		core.runningGoalId = core.state.goal.status === "active" ? core.state.goal.id : null;
		if (core.state.goal.status === "complete") return;
		if (core.state.goal.status === "paused") {
			const current = core.state.goal;
			const pauseExtras: string[] = [];
			if (current.stopReason === "agent") {
				pauseExtras.push("");
				pauseExtras.push(`Pause reason: ${current.pauseReason ?? "(unknown)"}`);
				if (current.pauseSuggestedAction) pauseExtras.push(`Suggested action: ${current.pauseSuggestedAction}`);
			}
				// Inject durable auditor feedback if available
				let auditorExtra = "";
				try {
					const ledger = getPromptLedger();
				const auditorResult = latestAuditorResultForGoal(ledger.events, current.id);
				if (auditorResult && auditorResult.verdict === "disapproved") {
					auditorExtra = `\n\n[AUDITOR REJECTION] An independent auditor previously rejected a completion request for this goal. Reason: ${auditorResult.report.slice(0, 300)}\nAddress the auditor's objections before requesting completion again.`;
				}
			} catch {
				// Ledger read failure should not break the prompt
			}
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL PAUSED goalId=${current.id}]\n${untrustedObjectiveBlock(current)}${pauseExtras.join("\n")}${auditorExtra}\n\nThe goal is paused. Do not autonomously continue substantive work while this lifecycle state is paused. If an explicit incoming instruction resumes completion and the objective is already satisfied based on available evidence, you may call update_goal({status: "complete"}). Do not report the goal blocked in response to a pause.`,
			};
		}
		if (core.state.goal.status === "blocked") {
			const current = core.state.goal;
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL BLOCKED goalId=${current.id}]\n${untrustedObjectiveBlock(current)}\n\nBlocker: ${current.pauseReason ?? "(unknown)"}\n\nThe goal is blocked. Do not autonomously continue substantive work or treat it as active. Preserve the blocker; only an explicit lifecycle transition may resume or revise this goal.`,
			};
		}
		// Token-budget-limited goals get one-time wrap-up steering: summarize,
		// do not start new substantive work, never claim completion unless real.
		if (core.state.goal?.status === "budget_limited") {
			const limitedGoal = core.state.goal;
			const budgetText = budgetLine(limitedGoal);
			// E4: surface the remaining-vs-overshoot fact in the wrap-up steering.
			const remaining = budgetRemaining(limitedGoal);
			const balanceText = typeof remaining === "number"
				? remaining < 0
					? ` — ${formatTokenValue(-remaining)} over the budget`
					: ` — ${formatTokenValue(remaining)} remaining`
				: "";
			const reminder = core.runtime.consumePostBudgetReminder()
				? `\n\n[TOKEN BUDGET REACHED goalId=${limitedGoal.id}]\nThe goal's token budget has been reached${budgetText ? ` (${budgetText}${balanceText})` : ""}. Wrap up the current work in one final response: summarize what was accomplished and what remains, do not start new substantive work, and do not claim the goal is complete unless it actually is. To continue, the user must raise or remove the budget and resume the goal.`
				: "";
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL BUDGET LIMITED goalId=${limitedGoal.id}]\n${untrustedObjectiveBlock(limitedGoal)}${budgetText ? `\n${budgetText}` : ""}${reminder}`,
			};
		}
		const activeGoal = core.state.goal;
		if (activeGoal.continuation?.wake) {
			return { systemPrompt: `${currentSystemPrompt()}\n\n${scheduledWaitPrompt(activeGoal)}` };
		}
		if (activeGoal.continuation?.hold) {
			return { systemPrompt: `${currentSystemPrompt()}\n\n${continuationHoldPrompt(activeGoal)}` };
		}
		const settings = loadGoalSettings(ctx.cwd);
		let prompt = goalPrompt(activeGoal, settings);
		// F5: [GOAL STALLED] steering note when the detector fired.
		const stalledNote = core.checkStall(ctx);
		if (stalledNote) prompt += stalledNote;
		// Inject durable auditor feedback if the latest result was a rejection
		try {
			const ledger = getPromptLedger();
			const auditorResult = latestAuditorResultForGoal(ledger.events, activeGoal.id);
			if (auditorResult && auditorResult.verdict === "disapproved" && ledger.events.some((e) => e.type === "completion_requested" && e.goalId === activeGoal.id)) {
				prompt = `${prompt}\n\n[AUDITOR REJECTION goalId=${activeGoal.id}]\nAn independent auditor previously rejected a completion request for this goal. Reason: ${auditorResult.report.slice(0, 300)}\nAddress the auditor's objections before requesting completion again.`;
			}
		} catch {
			// Ledger read failure should not break the prompt
		}
		if (core.runtime.consumeAuditRecoveryPrompt(activeGoal.id)) {
			prompt = `${prompt}\n\n[AUDIT RECOVERY PIVOT goalId=${activeGoal.id}]\nThe completion auditor is unavailable or exhausted. Do not request completion again during this cooldown/exhaustion window. Continue with an independently actionable pending task now; preserve the unmet completion criteria and record evidence. A NOT PROVEN criterion is not success, and task skipping is allowed only for explicit user direction or a hard contradiction.`;
		}
		if (activeGoal.continuation?.instruction) {
			prompt = `${prompt}\n\n[RETAINED GOAL REVIEW ACTION goalId=${activeGoal.id}]\n${activeGoal.continuation.instruction}\nExecute this action or a stronger evidence-backed alternative; do not merely report status.`;
		}
		if (noProgressRecoveryAttempt > 0) {
			prompt = `${prompt}\n\n${noProgressRecoveryPrompt(noProgressRecoveryAttempt)}`;
			noProgressRecoveryAttempt = 0;
		}
		if (core.runtime.isPostCompactReminderPending() && shouldInjectPostCompactReminder({ pending: true, goal: activeGoal })) {
			core.runtime.clearPostCompactReminder();
			// PR E §62: post-compaction DELTA — the active system goal block already
			// carries objective/policy/task gate/contract; inject only what
			// compaction may have lost. Falls back to a generic note on ledger
			// read failure.
			try {
				const ledger = getPromptLedger();
				const otherOpenCount = core.openGoals().filter((g) => g.id !== activeGoal.id).length;
				const delta = buildPostCompactionGoalDelta({ goal: activeGoal, ledgerEvents: ledger.events, otherOpenCount });
				prompt = `${prompt}\n\n${delta}`;
			} catch {
				prompt = `${prompt}\n\n[POST-COMPACTION RESYNC goalId=${core.state.goal.id}]\nThe conversation was just compacted. Re-read the objective and continue from the actual artifacts/state; do not rely on memory of the prior chat.`;
			}
		}
		return { systemPrompt: `${currentSystemPrompt()}\n\n${prompt}` };
	});

	pi.on("agent_end", async (event, ctx) => {
		const endedGoalId = core.runningGoalId;
		core.runningGoalId = null;
		continuationAfterSettleFor = null;
		reviewAfterSettleFor = null;
		executionRecoveryAfterSettleFor = null;
		networkErrorRecoveryAfterSettleFor = null;

		// Account for any tokens from aborted in-flight assistant messages so
		// they are not silently lost (but charge them to the original goal).
		const abortedTokens = event.messages
			.filter(isAbortedAssistantMessage)
			.reduce((sum, message) => sum + assistantTurnTokens(message), 0);
		if (abortedTokens > 0 && endedGoalId && core.state.goal?.id === endedGoalId) {
			core.accountProgress(ctx, { completedTurnTokens: abortedTokens });
		}

		// Keep any prior recovery attempt while Pi finishes its own automatic
		// retries. A user-driven path resets it through the default argument.
		core.runtime.clearContinuationState(false);
		if (!core.state.goal || core.state.goal.status !== "active" || !core.state.goal.autoContinue) return;
		if (endedGoalId && core.state.goal.id !== endedGoalId) return;
		if (!core.reconcileFocusedGoalFromDisk(ctx)) return;
		// A genuine user abort pauses the goal. An assistant message with
		// stopReason "aborted" WITHOUT a user abort signal is a provider- or
		// transport-side termination (e.g. after Pi exhausts its retries) —
		// pausing there stranded goals during outages, so it routes into the
		// same bounded recovery as classified transient errors instead.
		if (ctx.signal?.aborted) {
			core.pauseActiveGoal(ctx);
			return;
		}
		// Provider failures are not completed work: persist and refresh the
		// display, but never queue a continuation for a run whose messages
		// include an assistant error (danim47c pattern).
		if (event.messages.some(isTerminalProviderError)) {
			const goal = core.state.goal;
			const failed = asRecord(event.messages.find(isTerminalProviderError));
			const diagnostic = redactDiagnosticText(String(failed?.errorMessage ?? failed?.rawStopReason ?? "terminal provider refusal"));
			core.runtime.retainContinuationHold(ctx, goal, goalReviewScope(goal), "The provider refused this request; no automatic retry is justified.", [diagnostic], goalHoldAdmissionKey(goal, ctx, pi.getThinkingLevel?.()));
			recordGoalDiagnostic(ctx, { type: "terminal_provider_failure", goalId: goal.id, error: diagnostic });
			core.updateUI(ctx);
			return;
		}
		if (hasNetworkErrorAssistantMessage(event.messages) || hasAbortedAssistantMessage(event.messages)) {
			core.persist(ctx);
			core.updateUI(ctx);
			networkErrorRecoveryAfterSettleFor = core.state.goal.id;
			return;
		}
		if (hasErrorAssistantMessage(event.messages)) {
			core.persist(ctx);
			core.updateUI(ctx);
			return;
		}
		core.runtime.clearNetworkErrorBackoff();
		core.persist(ctx);
		core.updateUI(ctx);
		// A model's claim that an active goal is paused is unproductive historical
		// prose, not lifecycle authority. Admit one precise reconciliation review;
		// never replay the correction on every subsequent response.
		const activeForReconciliation = core.state.goal;
		if (activeForReconciliation && !activeForReconciliation.continuation?.wake && !activeForReconciliation.continuation?.hold
			&& !core.goalWorkToolProductiveThisTurn && !core.goalWorkToolCalledThisTurn && claimsPaused(event.messages) && !falsePausedReconciliationIssued.has(activeForReconciliation.id)) {
			falsePausedReconciliationIssued.add(activeForReconciliation.id);
			rememberReviewEvidence("Lifecycle contradiction: the final unproductive response claimed paused, but reconciled goal storage is ACTIVE. Use current state and choose a justified action or incomplete hold.");
			core.runtime.requestProgressReview(activeForReconciliation.id);
		}
		// While an asynchronous delegate is active, its own notification is the
		// continuation owner. Do not race it with a goal checkpoint or classify
		// the supervising parent as stalled merely because work happened remotely.
		if (delegatedWakeThisRun === "awaiting") {
			consecutiveNoProgressTurns = 0;
			noProgressRecoveryAttempt = 0;
			return;
		}
		if (delegatedWakeThisRun === "terminal") {
			delegatedWakeThisRun = null;
			core.goalWorkToolCalledThisTurn = true;
		}
		// A successful provider response is not necessarily productive. Without
		// this gate, a model can emit the same status-only answer every few
		// seconds and agent_end will keep queuing checkpoints forever.
		const productiveRun = core.goalWorkToolCalledThisTurn
			&& (!core.goalWorkToolDeniedThisTurn || core.goalWorkToolProductiveThisTurn);
		const continuationRun = !core.goalWorkToolDeniedThisTurn || core.goalWorkToolProductiveThisTurn;
		if (productiveRun) {
			consecutiveNoProgressTurns = 0;
			noProgressRecoveryAttempt = 0;
			// Activity alone does not erase retained strategic advice; only a later
			// independent review judges whether that advice was actually executed.
		} else {
			consecutiveNoProgressTurns += 1;
			noProgressRecoveryAttempt = consecutiveNoProgressTurns;
		}
		// agent_end runs before pi finishes retries, compaction, terminating-tool
		// settlement, and queued messages. Starting the continuation timer here
		// can poll a stale busy context for minutes on pi 0.84. agent_settled is
		// available in both supported SDK lines (0.83 and 0.84) and is the first
		// point where pi guarantees no automatic work remains.
		const auditRecoveryRun = core.runtime.hasAuditRecoveryLease(core.state.goal.id);
		const explicitReviewRequest = core.runtime.consumeProgressReviewRequest(core.state.goal.id);
		const reviewExhausted = core.runtime.isProgressReviewExhausted?.(core.state.goal) ?? false;
		const retainedReviewAction = core.state.goal.continuation?.instruction && !core.state.goal.continuation.wake && !core.state.goal.continuation.hold;
		if (core.state.goal.continuation?.hold || core.state.goal.continuation?.wake) {
			// A durable hold is quiet incomplete state, not permission to queue work.
			continuationAfterSettleFor = null;
			executionRecoveryAfterSettleFor = null;
		} else if (explicitReviewRequest && !reviewExhausted) {
			reviewAfterSettleFor = core.state.goal.id;
			continuationAfterSettleFor = null;
		} else if (retainedReviewAction && !productiveRun && !explicitReviewRequest && !auditRecoveryRun) {
			// The same actionable advice was already delivered once. Do not buy the
			// identical review again when it is ignored; recover quietly instead.
			executionRecoveryAfterSettleFor = core.state.goal.id;
			continuationAfterSettleFor = null;
		} else if ((explicitReviewRequest || consecutiveNoProgressTurns >= 2) && !productiveRun && !auditRecoveryRun && !reviewExhausted) {
			// Two complete empty cycles are the review threshold, not permission to
			// buy another ordinary checkpoint. Review is invoked at settlement.
			reviewAfterSettleFor = core.state.goal.id;
			// The request was consumed above. Do not re-add it after this settled
			// review: ignored advice must enter quiet execution recovery, not buy
			// the same independent review on every empty lifecycle cycle.
			continuationAfterSettleFor = null;
		} else if ((explicitReviewRequest || consecutiveNoProgressTurns >= 2) && !productiveRun && !auditRecoveryRun && reviewExhausted) {
			// Provider exhaustion is not reset by empty or productive executor
			// turns. Retained continuation state owns any quiet safe-work recovery.
			executionRecoveryAfterSettleFor = core.state.goal.id;
			continuationAfterSettleFor = null;
		} else {
			continuationAfterSettleFor = continuationRun || auditRecoveryRun ? core.state.goal.id : null;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const reviewGoalId = reviewAfterSettleFor;
		reviewAfterSettleFor = null;
		const executionRecoveryGoalId = executionRecoveryAfterSettleFor;
		executionRecoveryAfterSettleFor = null;
		if (reviewGoalId && core.isActionableContinuationGoal(reviewGoalId)) {
			toolCyclesSinceReview = 0;
			await runGoalProgressReviewFlow(core, ctx, { reason: actualReviewEvidence("Periodic or lifecycle review admitted at settlement."), latestUserDecisions: latestUserDecisions(ctx, reviewGoalId) });
			return;
		}
		if (executionRecoveryGoalId && core.isActionableContinuationGoal(executionRecoveryGoalId)) {
			// Retained advice was given one execution chance. If the next settled
			// cycle did not execute it, convert it to a durable quiet hold rather
			// than starting a timer-driven second owner.
			const current = core.state.goal;
			const continuation = current?.id === executionRecoveryGoalId ? current.continuation : undefined;
			if (current && continuation && !continuation.hold) {
				core.runtime.retainContinuationHold?.(ctx, current, continuation.scope, "The reviewed next action was not executed; no justified automatic retry remains.", [continuation.instruction], goalHoldAdmissionKey(current, ctx, pi.getThinkingLevel?.()));
			}
			return;
		}
		const goalId = continuationAfterSettleFor;
		continuationAfterSettleFor = null;
		const networkErrorGoalId = networkErrorRecoveryAfterSettleFor;
		networkErrorRecoveryAfterSettleFor = null;
		if (goalId && core.isActionableContinuationGoal(goalId)) {
			core.runtime.issueAuditRecovery(goalId);
			core.queueContinuation(ctx, true);
			return;
		}
		if (!networkErrorGoalId || !core.isActionableContinuationGoal(networkErrorGoalId)) return;
		if (providerRetryEnabled || providerRetryOwner) return; // Existing transport owner, not a competing Goal retry.
		if (core.state.goal?.continuation?.wake || core.state.goal?.continuation?.hold || core.runtime.networkErrorRetryPendingFor?.(networkErrorGoalId)) return;
		const recovery = loadGoalSettings(ctx.cwd).networkRecovery;
		const policy = recovery
			? { maxAttempts: recovery.maxAttempts, maxDelayMs: recovery.maxDelayMs }
			: undefined;
		const plan = core.runtime.scheduleNetworkErrorRetry(ctx, core.state.goal!, policy);
		if (plan) {
			const cap = plan.maxAttempts > 0 ? `/${plan.maxAttempts}` : ", unbounded";
			ctx.ui.notify(
				`Provider network error. Retrying the goal in ${Math.round(plan.delayMs / 1000)}s (recovery ${plan.attempt}${cap}).`,
				"warning",
			);
			return;
		}
		// A configured cap is an honest durable hold, not a reset-on-reload loop.
		const exhaustedGoal = core.state.goal!;
		core.runtime.retainContinuationHold(ctx, exhaustedGoal, goalReviewScope(exhaustedGoal), "Bounded provider recovery is exhausted; no automatic retry is scheduled.", ["The configured transient-retry admission returned no further attempt."], goalHoldAdmissionKey(exhaustedGoal, ctx, pi.getThinkingLevel?.()));
		ctx.ui.notify(
			"Provider recovery is exhausted. The goal remains ACTIVE and incomplete on a quiet hold.",
			"warning",
		);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		pendingInputSource = null;
		core.runtime.disposeAuditRetryTimers();
		continuationAfterSettleFor = null;
		networkErrorRecoveryAfterSettleFor = null;
		consecutiveNoProgressTurns = 0;
		noProgressRecoveryAttempt = 0;
		noProgressScopeGoalId = null;
		noProgressScopeEpoch = 0;
		core.accountProgress(ctx);
		core.clearContinuationState();
		core.terminalInputUnsubscribe?.();
		core.terminalInputUnsubscribe = null;
		if (core.state.goal) core.persist(ctx);
	});
}
