export type GoalStatus = "active" | "paused" | "complete";
export type StopReason = "user" | "agent";
export type GoalEventKind = "checkpoint" | "stale" | "drafting";
export type DraftingFocus = "goal" | "sisyphus";
export type GoalFocusReason = "created" | "selected" | "resumed" | "completed" | "cleared" | "aborted" | "migrated";

export type TaskStatus = "pending" | "complete" | "skipped";

export interface GoalTask {
  id: string;
  title: string;
  status: TaskStatus;
  completedAt?: string;
  skippedAt?: string;
  evidence?: string;
  skipReason?: string;
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
	// Set by the agent's pause_goal tool. Cleared when the goal becomes active again.
	pauseReason?: string;
	pauseSuggestedAction?: string;
	taskList?: GoalTaskList;
}

export interface GoalStateEntry {
	version: 3;
	goal: GoalRecord | null;
}

export interface GoalFocusEntry {
	version: 1;
	focusedGoalId: string | null;
	reason: GoalFocusReason;
}

export interface GoalEventDetails {
	kind: GoalEventKind;
	goalId: string;
	status?: GoalStatus;
	objective?: string;
	timestamp?: number;
	currentGoalId?: string | null;
	currentStatus?: GoalStatus | null;
	focus?: DraftingFocus;
}

export interface GoalCreationConfig {
	objective: string;
	autoContinue: boolean;
	sisyphus: boolean;
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

export function cloneGoal(goal: GoalRecord): GoalRecord {
	return {
		...goal,
		usage: { ...goal.usage },
		taskList: goal.taskList
			? { ...goal.taskList, tasks: goal.taskList.tasks.map(t => ({ ...t })) }
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
		raw.reason === "created" || raw.reason === "selected" || raw.reason === "resumed" || raw.reason === "completed" || raw.reason === "cleared" || raw.reason === "aborted" || raw.reason === "migrated"
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

export function normalizeTaskList(value: unknown): GoalTaskList | undefined {
	const raw = asRecord(value);
	if (!raw) return undefined;
	const tasksRaw = raw.tasks;
	if (!Array.isArray(tasksRaw)) return undefined;
	const tasks: GoalTask[] = [];
	for (const item of tasksRaw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const t = item as Record<string, unknown>;
		const id = typeof t.id === "string" && t.id.trim() ? t.id.trim() : "";
		const title = typeof t.title === "string" ? t.title.trim() : "";
		if (!id || !title) continue;
		const status: TaskStatus = t.status === "complete" ? "complete" : t.status === "skipped" ? "skipped" : "pending";
		tasks.push({
			id,
			title,
			status,
			completedAt: typeof t.completedAt === "string" ? t.completedAt : undefined,
			skippedAt: typeof t.skippedAt === "string" ? t.skippedAt : undefined,
			evidence: typeof t.evidence === "string" ? t.evidence : undefined,
			skipReason: typeof t.skipReason === "string" ? t.skipReason : undefined,
		});
	}
	if (tasks.length === 0) return undefined;
	return {
		tasks,
		blockCompletion: raw.blockCompletion === true,
		proposedAt: typeof raw.proposedAt === "string" ? raw.proposedAt : nowIso(),
	};
}

export function normalizeGoalRecord(value: unknown): GoalRecord | null {
	const raw = asRecord(value);
	if (!raw) return null;
	const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
	if (!objective) return null;

	const timestamp = nowIso();
	const rawStatus = raw.status;
	let status: GoalStatus = rawStatus === "complete" ? "complete" : rawStatus === "paused" ? "paused" : "active";
	const autoContinue = typeof raw.autoContinue === "boolean" ? raw.autoContinue : true;
	const usage = normalizeUsage(raw.usage);
	const sisyphus = raw.sisyphus === true;

	if (status === "paused" && autoContinue) {
		status = "active";
	}

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
		taskList: normalizeTaskList(raw.taskList),
	};
}
