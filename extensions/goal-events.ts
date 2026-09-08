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
	isToolUseAssistantMessage,
} from "./goal-format.ts";
import { buildCompactionSummary, buildPostCompactionGoalDelta } from "./goal-compaction.ts";
import { latestAuditorResultForGoal, loadLedgerState, readGoalLedger, invalidateGoalLedgerCache } from "./goal-ledger.ts";
import { shouldArmPostCompactReminder, shouldInjectPostCompactReminder } from "./goal-policy.ts";
import { formatTokenValue } from "./goal-core.ts";
import { loadGoalSettings, invalidateGoalSettingsCache } from "./goal-settings.ts";
import { budgetLine, budgetRemaining } from "./goal-accounting.ts";
import { asRecord, nowIso, type AssistantMessageLike, type GoalRecord } from "./goal-record.ts";
import { goalSelectorLabel } from "./goal-pool.ts";
import { invalidateGoalPoolCache } from "./storage/goal-files.ts";
import { checkpointTriggerPrompt } from "./prompts/goal-prompts.ts";
import { consumeOracleFollowupMarker, hasPendingOracleAdviceForFocusedGoal } from "./goal-oracle.ts";
import { countTrailingNoProgressRuns } from "./goal-tool-names.ts";
import { GoalProgressEvidenceTracker } from "./goal-progress-evidence.ts";
import {
	delegatedOwnershipFromMessages,
	isAsyncDelegationCall,
	type DelegatedWakeKind,
} from "./goal-delegated-progress.ts";
import {
	goalPrompt,
	noProgressRecoveryPrompt,
	scheduledWaitPrompt,
	staleContinuationPrompt,
	unfocusedOpenGoalsPrompt,
	untrustedObjectiveBlock,
} from "./prompts/goal-prompts.ts";
import { rehydrateDraft } from "./goal-drafting.ts";
import { syncTerminalInputPause } from "./goal-widget.ts";
import type { GoalCore } from "./goal-state.ts";
import { runGoalProgressReviewFlow } from "./goal-review.ts";
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
	let consecutiveNoProgressTurns = 0;
	let noProgressRecoveryAttempt = 0;
	let noProgressScopeGoalId: string | null = null;
	let noProgressScopeEpoch = 0;
	let delegatedWakeThisRun: DelegatedWakeKind | null = null;
	let pendingInputSource: InputSource | null = null;
	let pendingInputText = "";
	const pendingAsyncDelegations = new Set<string>();
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
	const progressEvidence = new GoalProgressEvidenceTracker();
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

	pi.on("context", async (event) => {
		const ownership = delegatedOwnershipFromMessages(event.messages);
		if (ownership) delegatedWakeThisRun = ownership;
		const messages = compactGoalCheckpointContext(event.messages, core.state.goal);
		// Reference equality means no goal-event messages existed at all.
		return messages === null ? undefined : { messages: messages as typeof event.messages };
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
		if (isAsyncDelegationCall(event.toolName, toolInput) && typeof eventRecord?.toolCallId === "string") {
			pendingAsyncDelegations.add(eventRecord.toolCallId);
		}
		if (progressEvidence.observeCall(eventRecord?.toolCallId, event.toolName, toolInput)) {
			recordMeaningfulWorkAttempt(ctx, event.toolName);
		}
		return;
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const eventRecord = asRecord(event);
		const toolCallId = eventRecord?.toolCallId;
		if (typeof toolCallId === "string" && pendingAsyncDelegations.delete(toolCallId) && eventRecord?.isError !== true) {
			recordMeaningfulWorkAttempt(ctx, "subagent");
			delegatedWakeThisRun = "awaiting";
		}
		if (progressEvidence.observeResult(toolCallId, eventRecord?.result, eventRecord?.isError)) {
			recordMeaningfulWorkAttempt(ctx, typeof eventRecord?.toolName === "string" ? eventRecord.toolName : "observational-tool");
		}
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
		core.queueContinuation(ctx, true);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		core.advanceTurnSeq();
		// event.systemPrompt is the SDK's current-turn chain. ctx.getSystemPrompt()
		// is the previous effective prompt and would accumulate stale lifecycle frames.
		const currentSystemPrompt = () => event.systemPrompt;
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
			const preserveWait = Boolean(waitingGoal?.continuation?.wake) && !explicitWaitOverride(inputText);
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
		const currentScopeGoalId = core.state.goal.id;
		const currentScopeEpoch = core.continuationEpoch;
		if (noProgressScopeGoalId !== currentScopeGoalId || noProgressScopeEpoch !== currentScopeEpoch) {
			// A new goal, focus epoch, or successful tweak must not inherit the
			// previous goal/revision's empty-turn coaching state.
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
			core.runtime.clearRetainedReviewInstruction(ctx, core.state.goal);
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
		const retainedReviewAction = core.state.goal.continuation?.instruction && !core.state.goal.continuation.wake;
		if (retainedReviewAction && !productiveRun && !explicitReviewRequest && !auditRecoveryRun) {
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
			await runGoalProgressReviewFlow(core, ctx, { reason: "Two consecutive settled runs produced no meaningful work.", latestUserDecisions: latestUserDecisions(ctx, reviewGoalId) });
			return;
		}
		if (executionRecoveryGoalId && core.isActionableContinuationGoal(executionRecoveryGoalId)) {
			const current = core.state.goal;
			const continuation = current?.id === executionRecoveryGoalId ? current.continuation : undefined;
			if (current && continuation && !continuation.wake) {
				core.runtime.scheduleExecutionRecovery(ctx, current, continuation.scope, continuation.instruction);
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
		// Only reachable under a configured bounded cap (maxAttempts > 0).
		ctx.ui.notify(
			"Provider network errors persisted after all recovery attempts. The goal remains active; resume it when the provider is healthy.",
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
