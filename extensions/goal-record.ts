export type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete";
export type StopReason = "user" | "agent";
export type GoalEventKind = "checkpoint" | "stale";
/** Goal creation mode used by the /goal and /sisyphus commands. */
export type GoalMode = "goal" | "sisyphus";
export type GoalFocusReason = "created" | "selected" | "tweaked" | "unfocused" | "resumed" | "completed" | "cleared" | "aborted" | "migrated";

export type TaskStatus = "pending" | "complete" | "skipped";

export interface GoalTask {
  id: string;
  title: string;
  status: TaskStatus;
  completedAt?: string;
  skippedAt?: string;
  evidence?: string;
  skipReason?: string;
  verificationContract?: string;
  lightweightSubtasks?: boolean;
  subtasks?: GoalTask[];
}

export interface GoalTaskList {
  tasks: GoalTask[];
  blockCompletion: boolean;
  proposedAt: string;
}

export interface GoalUsage {
	tokensUsed: number;
	activeSeconds: number;
}

export interface GoalContinuationWake {
	id: string;
	at: string;
	kind: "external_wait" | "execution_recovery" | "review_recovery";
	reason: string;
	evidence: string[];
}

export interface GoalContinuationHold {
	reason: string;
	evidence: string[];
	at: string;
	/** Relevant goal/configuration snapshot; missing legacy keys are baselined, not released. */
	admissionKey?: string;
}

export interface GoalOwnedWork {
	id: string;
	kind: "bg_run" | "subagent";
	scope: string;
	sessionId: string;
}

export interface GoalContinuationState {
	scope: string;
	instruction: string;
	executionRetries: number;
	reviewFailures: number;
	/** A durable incomplete hold; unlike a wake it admits no automatic work. */
	hold?: GoalContinuationHold;
	wake?: GoalContinuationWake;
}

export interface GoalRecord {
	id: string;
	objective: string;
	status: GoalStatus;
	autoContinue: boolean;
	usage: GoalUsage;
	sisyphus: boolean;
	createdAt: string;
	updatedAt: string;
	activePath?: string;
	archivedPath?: string;
	stopReason?: StopReason;
	// Set when the model reports the goal blocked. Cleared when the goal becomes active again.
	pauseReason?: string;
	pauseSuggestedAction?: string;
	skipAuditor?: boolean;
	/**
	 * Persisted monotonic mutation counter (follow-up Stage 4). Missing
	 * historical values normalize to zero. Cross-process writers compare the
	 * revision captured at reconciliation with the disk value under the
	 * per-goal lock; a mismatch is a typed conflict instead of a blind write.
	 */
	revision?: number;
	/** Optional token budget (whole tokens). When accounted usage reaches it, the runtime marks the goal budget_limited. */
	tokenBudget?: number;
	/**
	 * Execution focus: the id of the task (or subtask) the agent is working on.
	 * Optional for backward compatibility; normalized at load (only an existing
	 * pending task id is accepted; cleared on complete/skip/removal). Describes
	 * execution focus, not completion state — TaskStatus is unchanged.
	 */
	currentTaskId?: string;
	taskList?: GoalTaskList;
	/** Plain-text description of what verification evidence is required before completing this goal. */
	verificationContract?: string;
	/** Durable autonomous review/recheck state. Absent on historical records. */
	continuation?: GoalContinuationState;
	/** Successful async launches only; consumed once by a matching host notice. */
	ownedWork?: GoalOwnedWork[];
}

export interface GoalStateEntry {
	version: 3;
	goal: GoalRecord | null;
	/** E7: expandable tool-result detail line (e.g. full pause reason). */
	resultDetail?: string;
}

export interface GoalFocusEntry {
	version: 1;
	focusedGoalId: string | null;
	reason: GoalFocusReason;
}

/**
 * Issue #30 v2 checkpoint details: a tiny structured trigger record. Never
 * contains objective text, task text, verification contracts, budget strings,
 * or policy text — the authoritative state is injected once per turn by
 * before_agent_start from goal storage.
 */
export interface GoalCheckpointDetailsV2 {
	version: 2;
	kind: "checkpoint";
	goalId: string;
	status: "active";
	revision: number;
	checkpointSeq: number;
	timestamp: number;
}

/** Pre-v2 event details (full objective persisted). Read-only legacy shape. */
export interface LegacyGoalEventDetails {
	kind: GoalEventKind;
	goalId: string;
	status?: GoalStatus;
	objective?: string;
	timestamp?: number;
	currentGoalId?: string | null;
	currentStatus?: GoalStatus | null;
	/** Legacy-read-only creation mode on historical event entries; no writer emits it today. */
	focus?: GoalMode;
}

/** Historical "stale" rewrite of a checkpoint that no longer matches the goal. */
export interface GoalStaleDetails {
	kind: "stale";
	goalId: string;
	currentGoalId?: string | null;
	currentStatus?: GoalStatus | null;
}

/** Everything that can appear in a persisted pi-goal-event entry's details. */
export type GoalEventEntryDetails = GoalCheckpointDetailsV2 | LegacyGoalEventDetails | GoalStaleDetails;

/**
 * Legacy normalized renderer shape. Kept as the stable contract for
 * renderGoalEvent / registerMessageRenderer; v2 entries normalize into it.
 */
export type GoalEventDetails = LegacyGoalEventDetails;

export interface GoalCreationConfig {
	objective: string;
	autoContinue: boolean;
	sisyphus: boolean;
	taskList?: GoalTaskList;
	/** User-chosen per-draft auditor bypass, persisted on the created goal. */
	skipAuditor?: boolean;
}

export interface AssistantUsage {
	input?: number;
	output?: number;
}

export interface AssistantMessageLike {
	role?: string;
	stopReason?: string;
	usage?: AssistantUsage;
}

export function nowIso(now = Date.now()): string {
	return new Date(now).toISOString();
}

export function safeIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "goal";
}

export function newGoalId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeRelPath(relPath: string): string {
	return relPath.split(/[\\/]+/).join("/");
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function emptyUsage(): GoalUsage {
	return { tokensUsed: 0, activeSeconds: 0 };
}

function cloneGoalTask(task: GoalTask): GoalTask {
	return {
		...task,
		subtasks: task.subtasks ? task.subtasks.map(cloneGoalTask) : undefined,
	};
}

export function cloneGoal(goal: GoalRecord): GoalRecord {
	return {
		...goal,
		usage: { ...goal.usage },
		taskList: goal.taskList
			? { ...goal.taskList, tasks: goal.taskList.tasks.map(cloneGoalTask) }
			: undefined,
		ownedWork: goal.ownedWork?.map((work) => ({ ...work })),
		continuation: goal.continuation
			? { ...goal.continuation, hold: goal.continuation.hold ? { ...goal.continuation.hold, evidence: [...goal.continuation.hold.evidence] } : undefined, wake: goal.continuation.wake ? { ...goal.continuation.wake, evidence: [...goal.continuation.wake.evidence] } : undefined }
			: undefined,
	};
}

export function goalFocusDetails(focusedGoalId: string | null, reason: GoalFocusReason): GoalFocusEntry {
	return {
		version: 1,
		focusedGoalId: focusedGoalId ? safeIdPart(focusedGoalId) : null,
		reason,
	};
}

export function normalizeGoalFocusEntry(value: unknown): GoalFocusEntry | null {
	const raw = asRecord(value);
	if (!raw || raw.version !== 1) return null;
	const focusedGoalId = typeof raw.focusedGoalId === "string" && raw.focusedGoalId.trim()
		? safeIdPart(raw.focusedGoalId)
		: null;
	const reason: GoalFocusReason =
		raw.reason === "created" || raw.reason === "selected" || raw.reason === "tweaked" || raw.reason === "unfocused" || raw.reason === "resumed" || raw.reason === "completed" || raw.reason === "cleared" || raw.reason === "aborted" || raw.reason === "migrated"
			? raw.reason
			: "selected";
	return { version: 1, focusedGoalId, reason };
}

export function createGoal(config: GoalCreationConfig, now = Date.now()): GoalRecord {
	const timestamp = nowIso(now);
	return {
		id: newGoalId(),
		objective: config.objective,
		status: "active",
		autoContinue: config.autoContinue,
		usage: emptyUsage(),
		sisyphus: config.sisyphus,
		skipAuditor: config.skipAuditor === true ? true : undefined,
		revision: 0,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

export function normalizeUsage(value: unknown): GoalUsage {
	const raw = asRecord(value);
	if (!raw) return emptyUsage();
	const tokensUsed = typeof raw.tokensUsed === "number" && Number.isFinite(raw.tokensUsed) ? Math.max(0, Math.floor(raw.tokensUsed)) : 0;
	const activeSeconds = typeof raw.activeSeconds === "number" && Number.isFinite(raw.activeSeconds) ? Math.max(0, Math.floor(raw.activeSeconds)) : 0;
	return { tokensUsed, activeSeconds };
}

export function normalizeTaskItem(raw: Record<string, unknown>): GoalTask | undefined {
	const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
	const title = typeof raw.title === "string" ? raw.title.trim() : "";
	if (!id || !title) return undefined;
	const status: TaskStatus = raw.status === "complete" ? "complete" : raw.status === "skipped" ? "skipped" : "pending";
	const subtasksRaw = raw.subtasks;
	let subtasks: GoalTask[] | undefined;
	if (Array.isArray(subtasksRaw)) {
		subtasks = subtasksRaw
			.map((item) => (item && typeof item === "object" ? normalizeTaskItem(item as Record<string, unknown>) : undefined))
			.filter((t): t is GoalTask => !!t);
		if (subtasks.length === 0) subtasks = undefined;
	}
	return {
		id,
		title,
		status,
		completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
		skippedAt: typeof raw.skippedAt === "string" ? raw.skippedAt : undefined,
		evidence: typeof raw.evidence === "string" ? raw.evidence : undefined,
		skipReason: typeof raw.skipReason === "string" ? raw.skipReason : undefined,
		verificationContract: typeof raw.verificationContract === "string" ? raw.verificationContract : undefined,
		lightweightSubtasks: raw.lightweightSubtasks === true ? true : undefined,
		subtasks,
	};
}

export function normalizeTaskList(value: unknown): GoalTaskList | undefined {
	const raw = asRecord(value);
	if (!raw) return undefined;
	const tasksRaw = raw.tasks;
	if (!Array.isArray(tasksRaw)) return undefined;
	const tasks: GoalTask[] = tasksRaw
		.map((item) => (item && typeof item !== "object" || Array.isArray(item) ? undefined : normalizeTaskItem(item as Record<string, unknown>)))
		.filter((t): t is GoalTask => !!t);
	if (tasks.length === 0) return undefined;
	return {
		tasks,
		blockCompletion: raw.blockCompletion === true,
		proposedAt: typeof raw.proposedAt === "string" ? raw.proposedAt : nowIso(),
	};
}

/**
 * Shared positive-safe-integer normalization for persisted numeric values such
 * as tokenBudget. Non-finite, fractional, zero, negative, and unsafe numbers
 * normalize to absent rather than silently changing meaning. Live tool input
 * is validated separately (rejected with a user-facing message); this handles
 * persisted legacy values.
 */
/**
 * Live-input validation for token_budget (shared by slash-command parsing, tool
 * execution, and record creation). Tool callers are untrusted, so the schema
 * Type.Integer bound is double-checked at runtime with Number.isSafeInteger.
 */
export function validateTokenBudgetInput(value: unknown): { ok: true; value: number } | { ok: false; message: string } {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return { ok: false, message: "token_budget must be a number." };
	}
	if (!Number.isSafeInteger(value)) {
		return { ok: false, message: "token_budget must be a whole safe integer (fractional values are not accepted)." };
	}
	if (value < 1) {
		return { ok: false, message: "token_budget must be at least 1." };
	}
	return { ok: true, value };
}

function normalizeContinuation(value: unknown): GoalContinuationState | undefined {
	const raw = asRecord(value);
	if (!raw || typeof raw.scope !== "string" || !raw.scope.trim() || typeof raw.instruction !== "string" || !raw.instruction.trim()) return undefined;
	const evidence = Array.isArray(raw.evidence) ? raw.evidence.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, 8) : [];
	const state: GoalContinuationState = {
		scope: raw.scope.trim().slice(0, 200),
		instruction: raw.instruction.trim().slice(0, 2_000),
		executionRetries: typeof raw.executionRetries === "number" && Number.isSafeInteger(raw.executionRetries) ? Math.max(0, raw.executionRetries) : 0,
		reviewFailures: typeof raw.reviewFailures === "number" && Number.isSafeInteger(raw.reviewFailures) ? Math.max(0, raw.reviewFailures) : 0,
	};
	const hold = asRecord(raw.hold);
	const holdEvidence = hold && Array.isArray(hold.evidence)
		? hold.evidence.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, 500)).slice(0, 8)
		: [];
	if (hold && typeof hold.reason === "string" && hold.reason.trim() && typeof hold.at === "string" && Number.isFinite(Date.parse(hold.at)) && holdEvidence.length > 0) {
		state.hold = { reason: hold.reason.trim().slice(0, 500), evidence: holdEvidence, at: new Date(hold.at).toISOString(), ...(typeof hold.admissionKey === "string" && /^[a-f0-9]{64}$/u.test(hold.admissionKey) ? { admissionKey: hold.admissionKey } : {}) };
	}
	const wake = asRecord(raw.wake);
	const wakeEvidence = wake && Array.isArray(wake.evidence)
		? wake.evidence.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()).slice(0, 8)
		: [];
	// Overdue wakes are valid (they are recovered immediately on return), but a
	// malformed timestamp/evidence must never be surfaced as a scheduled wake.
	const wakeAt = wake && typeof wake.at === "string" ? wake.at : "";
	const parsedWakeAt = Date.parse(wakeAt);
	const utcShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(wakeAt);
	const validUtc = utcShape && Number.isFinite(parsedWakeAt) && new Date(parsedWakeAt).toISOString().slice(0, 19) === wakeAt.slice(0, 19);
	if (wake && typeof wake.id === "string" && wake.id.trim() && validUtc && (wake.kind === "external_wait" || wake.kind === "execution_recovery" || wake.kind === "review_recovery") && typeof wake.reason === "string" && wake.reason.trim() && wakeEvidence.length > 0) {
		state.wake = { id: wake.id.trim().slice(0, 120), at: new Date(wakeAt).toISOString(), kind: wake.kind, reason: wake.reason.trim().slice(0, 500), evidence: wakeEvidence };
	}
	return state;
}

export function normalizePositiveSafeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/**
 * §7.4: a persisted currentTaskId is accepted only when it references an
 * existing PENDING task (top-level or nested). It is cleared when the task is
 * complete, skipped, or no longer exists; absent for historical files. The
 * caller decides whether to persist the normalized value — normalization
 * itself never rewrites old files.
 */
export function currentTaskIdIsPending(tasks: readonly GoalTask[] | undefined, id: string | undefined): boolean {
	if (!id || !tasks) return false;
	for (const t of tasks) {
		if (t.id === id) return t.status === "pending";
		if (t.subtasks && currentTaskIdIsPending(t.subtasks, id)) return true;
	}
	return false;
}

export function normalizeGoalRecord(value: unknown): GoalRecord | null {
	const raw = asRecord(value);
	if (!raw) return null;
	const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
	if (!objective) return null;

	const timestamp = nowIso();
	// Persisted lifecycle status is authoritative. autoContinue is an execution
	// preference only: it must never rewrite status during reads or migration.
	const rawStatus = raw.status;
	const status: GoalStatus = rawStatus === "complete"
		? "complete"
		: rawStatus === "paused"
			? "paused"
			: rawStatus === "budget_limited"
				? "budget_limited"
				: rawStatus === "blocked"
					? "blocked"
					: "active";
	// autoContinue normalizes independently of status.
	const autoContinue = typeof raw.autoContinue === "boolean" ? raw.autoContinue : true;
	const usage = normalizeUsage(raw.usage);
	const sisyphus = raw.sisyphus === true;
	const taskList = normalizeTaskList(raw.taskList);
	// §7.4: accept a persisted currentTaskId only when it references an existing
	// pending task; otherwise leave it absent. Historical files stay absent and
	// are never rewritten just because the field is missing.
	const currentTaskId =
		typeof raw.currentTaskId === "string" && currentTaskIdIsPending(taskList?.tasks, raw.currentTaskId.trim())
			? raw.currentTaskId.trim()
			: undefined;

	return {
		id: typeof raw.id === "string" && raw.id ? safeIdPart(raw.id) : newGoalId(),
		objective,
		status,
		autoContinue,
		usage,
		sisyphus,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : timestamp,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : timestamp,
		activePath: typeof raw.activePath === "string" ? raw.activePath : undefined,
		archivedPath: typeof raw.archivedPath === "string" ? raw.archivedPath : undefined,
		stopReason: raw.stopReason === "agent" || raw.stopReason === "user" ? raw.stopReason : undefined,
		pauseReason: typeof raw.pauseReason === "string" && raw.pauseReason.trim() ? raw.pauseReason : undefined,
		pauseSuggestedAction: typeof raw.pauseSuggestedAction === "string" && raw.pauseSuggestedAction.trim() ? raw.pauseSuggestedAction : undefined,
		skipAuditor: raw.skipAuditor === true ? true : undefined,
		revision: Number.isSafeInteger(raw.revision) && (raw.revision as number) >= 0 ? (raw.revision as number) : 0,
		tokenBudget: normalizePositiveSafeInteger(raw.tokenBudget),
		taskList,
		currentTaskId,
		verificationContract: typeof raw.verificationContract === "string" ? raw.verificationContract : undefined,
		...(normalizeContinuation(raw.continuation) ? { continuation: normalizeContinuation(raw.continuation) } : {}),
		...(Array.isArray(raw.ownedWork) ? { ownedWork: raw.ownedWork.flatMap((entry) => {
			const work = asRecord(entry);
			return work && (work.kind === "bg_run" || work.kind === "subagent") && [work.id, work.scope, work.sessionId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 200)
				? [{ id: work.id as string, kind: work.kind, scope: work.scope as string, sessionId: work.sessionId as string } as GoalOwnedWork] : [];
		}).slice(-32) } : {}),
	};
}
