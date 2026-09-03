export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const GET_GOAL_TOOL_NAME = "get_goal";
export const UPDATE_GOAL_TOOL_NAME = "update_goal";
export const SET_GOAL_TASKS_TOOL_NAME = "set_goal_tasks";
export const UPDATE_GOAL_TASK_TOOL_NAME = "update_goal_task";
export const QUESTION_TOOL_NAME = "goal_question";
export const QUESTIONNAIRE_TOOL_NAME = "goal_questionnaire";
export const PROPOSE_DRAFT_TOOL_NAME = "propose_goal_draft";

/** The stable core model surface: three tools, installed without phase-dependent sync. */
export const CORE_GOAL_TOOL_NAMES = [CREATE_GOAL_TOOL_NAME, GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME] as const;

/** The two consolidated task tools advertised when tasks are enabled. */
export const TASK_TOOL_NAMES = [SET_GOAL_TASKS_TOOL_NAME, UPDATE_GOAL_TASK_TOOL_NAME] as const;

/** Fixed task-enabled profile: all five registered goal tools. */
export const FIVE_GOAL_TOOLS = [...CORE_GOAL_TOOL_NAMES, ...TASK_TOOL_NAMES] as const;

/** Fixed task-disabled profile: the three core tools. */
export const CORE_GOAL_TOOLS = CORE_GOAL_TOOL_NAMES;

/** User-started drafting uses a separate transient model profile. */
export const DRAFTING_GOAL_TOOLS = [
	QUESTION_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	PROPOSE_DRAFT_TOOL_NAME,
] as const;

/** Every goal tool this extension registers (used by installGoalToolProfile). */
export const ALL_REGISTERED_GOAL_TOOLS = [...FIVE_GOAL_TOOLS, ...DRAFTING_GOAL_TOOLS] as const;

/**
 * Goal tools that count as "real work" toward the active goal plus the common
 * host work tools. Used by the empty-turn continuation gate: if a non-tool-use
 * turn ends without any of these having been called, we do NOT queue the next
 * autoContinue.
 */
export const GOAL_WORK_TOOL_NAMES = [
	UPDATE_GOAL_TOOL_NAME,
	SET_GOAL_TASKS_TOOL_NAME,
	UPDATE_GOAL_TASK_TOOL_NAME,
	CREATE_GOAL_TOOL_NAME,
	GET_GOAL_TOOL_NAME,
	"write",
	"edit",
	"bash",
	"read",
	"grep",
	"find",
	"ls",
	"bg_logs",
] as const;

/**
 * The subset of GOAL_WORK_TOOL_NAMES that indicates actual progress (excludes
 * read-only surface tools such as get_goal and create_goal).
 */
const NON_PROGRESS_TOOL_NAMES = new Set([
	CREATE_GOAL_TOOL_NAME,
	GET_GOAL_TOOL_NAME,
	"bg_status",
]);

/** Host tools that are never progress, including polling that must not reset the breaker. */
export function isGoalProgressToolName(toolName: string, input?: unknown): boolean {
	if (NON_PROGRESS_TOOL_NAMES.has(toolName)) return false;
	if (toolName === "subagent") {
		const action = input && typeof input === "object" ? (input as Record<string, unknown>).action : undefined;
		if (typeof action === "string") {
			const normalized = action.toLowerCase();
			if (normalized === "status" || normalized === "list" || normalized === "models") return false;
		}
	}
	return true;
}

function entryMessage(entry: unknown): Record<string, unknown> | null {
	if (entry === null || typeof entry !== "object") return null;
	const raw = entry as Record<string, unknown>;
	const nested = raw.message;
	if (nested !== null && typeof nested === "object") return nested as Record<string, unknown>;
	return raw;
}

const GOAL_FOCUS_ENTRY = "pi-goal-focus";

function focusMarkerGoalId(entry: unknown): string | null | undefined {
	if (entry === null || typeof entry !== "object") return undefined;
	const raw = entry as Record<string, unknown>;
	if (raw.customType !== GOAL_FOCUS_ENTRY) return undefined;
	const data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
		? raw.data as Record<string, unknown>
		: raw.details && typeof raw.details === "object" && !Array.isArray(raw.details)
			? raw.details as Record<string, unknown>
			: null;
	if (!data || !Object.prototype.hasOwnProperty.call(data, "focusedGoalId")) return null;
	return typeof data.focusedGoalId === "string" ? data.focusedGoalId : null;
}

/** Count completed end_turn runs from the tail that used no progress-class tools. */
export function countTrailingNoProgressRuns(entries: readonly unknown[], currentGoalId?: string | null): number {
	let firstRelevantEntry = 0;
	if (currentGoalId !== undefined) {
		let lastFocusGoalId: string | null | undefined;
		let currentGoalMarker = -1;
		for (let index = 0; index < entries.length; index += 1) {
			const markerGoalId = focusMarkerGoalId(entries[index]);
			if (markerGoalId === undefined) continue;
			lastFocusGoalId = markerGoalId;
			if (markerGoalId === currentGoalId) currentGoalMarker = index;
		}
		// A missing or stale focus marker must not let another goal's historical
		// empty turns suppress this goal's first continuation after reload.
		if (currentGoalMarker < 0 || lastFocusGoalId !== currentGoalId) return 0;
		firstRelevantEntry = currentGoalMarker + 1;
	}

	const runs: string[][] = [];
	let tools: string[] = [];
	for (let index = firstRelevantEntry; index < entries.length; index += 1) {
		const entry = entries[index];
		const message = entryMessage(entry);
		if (!message) continue;
		const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
		if (message.role === "toolResult" && toolName) tools.push(toolName);
		if (message.role !== "assistant") continue;
		const stop = message.stopReason;
		if (stop === "error" || stop === "aborted" || stop === "toolUse") continue;
		runs.push(tools);
		tools = [];
	}
	let count = 0;
	for (let index = runs.length - 1; index >= 0; index -= 1) {
		const run = runs[index];
		if (!run || run.some((name) => isGoalProgressToolName(name))) break;
		count += 1;
	}
	return count;
}

export const GOAL_PROGRESS_TOOL_NAMES = [
	UPDATE_GOAL_TOOL_NAME,
	SET_GOAL_TASKS_TOOL_NAME,
	UPDATE_GOAL_TASK_TOOL_NAME,
	"write",
	"edit",
	"bash",
	"read",
	"grep",
	"find",
	"ls",
	"bg_logs",
] as const;

/** Tools the model may still call on a stopped turn (state reads only). */
export const POST_STOP_ALLOWED_TOOLS = ["get_goal"] as const;
