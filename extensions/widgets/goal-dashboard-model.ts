/**
 * Shared dashboard view model (plan §6) — the single source of truth for the
 * persistent compact dashboard, the expanded dashboard, `/goal-status`, audit
 * transitions, golden tests, and documentation examples.
 *
 * Pure data derivation only: this module must never import TUI rendering
 * components. Width-safe truncation, borders, and color belong to the
 * renderer; everything factual here is derived from persisted goal state and
 * the durable ledger.
 */

import { displayObjectiveTitle, formatDuration } from "../goal-core.ts";
import type { GoalLedgerEvent } from "../goal-ledger.ts";
import type { GoalRecord, GoalTask } from "../goal-record.ts";
import { deriveGoalActivity, type GoalActivityItem } from "../goal-activity.ts";

// ---------------------------------------------------------------------------
// Types (plan §6)
// ---------------------------------------------------------------------------

export type DashboardStatusCode = "running" | "idle" | "paused" | "blocked" | "budget_limited" | "complete";

export interface GoalDashboardModel {
	goalId: string;
	title: string;

	status: {
		code: DashboardStatusCode;
		label: string;
		reason?: string;
		suggestedAction?: string;
	};

	focused: boolean;
	filePath?: string;

	usage: {
		activeSeconds: number;
		elapsedLabel: string;
		tokens: number;
		tokenLabel: string;
	};

	budget?: {
		used: number;
		total: number;
		percentage: number;
		remaining: number;
	};

	taskProgress?: {
		completed: number;
		total: number;
		percentage: number;
	};

	taskTree: DashboardTaskNode[];

	currentTask?: {
		id: string;
		title: string;
		depth: number;
		completedSubtasks: number;
		totalSubtasks: number;
		subtaskPercentage: number;
		verificationContract?: string;
		evidence?: string;
		/**
		 * True when no valid persisted currentTaskId existed and the current
		 * task was inferred from the first pending task for display only —
		 * never persisted (§7.4).
		 */
		inferred?: boolean;
	};

	goalVerificationContract?: string;
	otherOpenGoals: number;
	recentActivity: GoalActivityItem[];
}

export interface DashboardTaskNode {
	id: string;
	title: string;
	status: "pending" | "complete" | "skipped";
	depth: number;
	isCurrent: boolean;
	verificationContract?: string;
	evidence?: string;
}

export interface GoalDashboardModelOptions {
	focused: boolean;
	otherOpenGoals: number;
	ledgerEvents?: readonly GoalLedgerEvent[];
	activityLimit?: number;
	/** §9.5: omit task sections when tasks are disabled by settings. */
	tasksDisabled?: boolean;
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

export interface DashboardGoalStatus {
	code: DashboardStatusCode;
	label: string;
	reason?: string;
	suggestedAction?: string;
}

/**
 * Map the persisted lifecycle status to a display code. Labels are explicit
 * words so the dashboard stays understandable without status symbols (§5.2).
 */
export function deriveGoalStatus(goal: GoalRecord): DashboardGoalStatus {
	switch (goal.status) {
		case "active":
			return goal.autoContinue
				? { code: "running", label: "In progress" }
				: { code: "idle", label: "Idle" };
		case "paused": {
			const who = goal.stopReason === "agent" ? " (agent)" : goal.stopReason === "user" ? " (user)" : "";
			const status: DashboardGoalStatus = { code: "paused", label: `Paused${who}` };
			if (goal.pauseReason) status.reason = goal.pauseReason;
			if (goal.pauseSuggestedAction) status.suggestedAction = goal.pauseSuggestedAction;
			return status;
		}
		case "blocked": {
			const status: DashboardGoalStatus = { code: "blocked", label: "Blocked" };
			if (goal.pauseReason) status.reason = goal.pauseReason;
			if (goal.pauseSuggestedAction) status.suggestedAction = goal.pauseSuggestedAction;
			return status;
		}
		case "budget_limited":
			return { code: "budget_limited", label: "Budget limited" };
		case "complete":
			return { code: "complete", label: "Complete" };
	}
}

// ---------------------------------------------------------------------------
// Task progress (plan §9)
// ---------------------------------------------------------------------------

export interface TaskProgress {
	completed: number;
	total: number;
	percentage: number;
}

/**
 * Overall progress across TOP-LEVEL tasks only (§9.1): a top-level task
 * counts as done when it is complete or skipped, keeping the main percentage
 * aligned with major milestones.
 */
export function deriveTopLevelTaskProgress(goal: GoalRecord): TaskProgress | undefined {
	const tasks = goal.taskList?.tasks;
	if (!tasks || tasks.length === 0) return undefined;
	const completed = tasks.filter((t) => t.status === "complete" || t.status === "skipped").length;
	return { completed, total: tasks.length, percentage: percentageOf(completed, tasks.length) };
}

function percentageOf(done: number, total: number): number {
	if (total <= 0) return 0;
	return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

// ---------------------------------------------------------------------------
// Task tree (plan §9.2)
// ---------------------------------------------------------------------------

/**
 * Flatten the recursive task tree into display rows. `currentTaskId` marks
 * the current node; pass the EFFECTIVE current id (persisted, or inferred)
 * so the tree and the current-task block always agree.
 */
export function flattenTaskTree(tasks: readonly GoalTask[] | undefined, currentTaskId?: string): DashboardTaskNode[] {
	const nodes: DashboardTaskNode[] = [];
	if (!tasks) return nodes;
	const walk = (list: readonly GoalTask[], depth: number): void => {
		for (const t of list) {
			nodes.push({
				id: t.id,
				title: t.title,
				status: t.status,
				depth,
				isCurrent: t.id === currentTaskId,
				verificationContract: t.verificationContract,
				evidence: t.evidence,
			});
			if (t.subtasks && t.subtasks.length > 0) walk(t.subtasks, depth + 1);
		}
	};
	walk(tasks, 0);
	return nodes;
}

// ---------------------------------------------------------------------------
// Current task (plan §7.2, §9.3)
// ---------------------------------------------------------------------------

export interface CurrentTaskSubtaskProgress {
	completedSubtasks: number;
	totalSubtasks: number;
	subtaskPercentage: number;
}

/**
 * Subtask progress for the current task (§9.3 preferred rule): for a parent
 * task, direct-child completion; for a leaf task, all-zero so the renderer
 * can omit the ratio rather than show something confusing.
 */
export function deriveCurrentTaskSubtaskProgress(current: { id: string }, tasks: readonly GoalTask[]): CurrentTaskSubtaskProgress {
	const parent = findTask(tasks, current.id);
	const children = parent?.subtasks;
	if (!children || children.length === 0) {
		return { completedSubtasks: 0, totalSubtasks: 0, subtaskPercentage: 0 };
	}
	const completed = children.filter((c) => c.status === "complete" || c.status === "skipped").length;
	return {
		completedSubtasks: completed,
		totalSubtasks: children.length,
		subtaskPercentage: percentageOf(completed, children.length),
	};
}

export interface DashboardCurrentTask extends CurrentTaskSubtaskProgress {
	id: string;
	title: string;
	depth: number;
	verificationContract?: string;
	evidence?: string;
	inferred?: boolean;
}

/**
 * Resolve the current task: the persisted currentTaskId when it references an
 * existing pending task; otherwise (missing, invalid, or removed) fall back
 * to the first pending task in tree order, marked `inferred` so the fallback
 * is never persisted (§7.4). `currentTaskId` may point at any tree node —
 * top-level task or subtask (§7.2).
 */
export function deriveCurrentTask(goal: GoalRecord, nodes: DashboardTaskNode[]): DashboardCurrentTask | undefined {
	const tasks = goal.taskList?.tasks;
	if (!tasks || tasks.length === 0 || nodes.length === 0) return undefined;
	let node: DashboardTaskNode | undefined;
	if (goal.currentTaskId) {
		node = nodes.find((n) => n.id === goal.currentTaskId && n.status === "pending");
	}
	const inferred = node === undefined;
	if (inferred) node = nodes.find((n) => n.status === "pending");
	if (!node) return undefined;
	const subtaskProgress = deriveCurrentTaskSubtaskProgress(node, tasks);
	return {
		id: node.id,
		title: node.title,
		depth: node.depth,
		...subtaskProgress,
		verificationContract: node.verificationContract,
		evidence: node.evidence,
		...(inferred ? { inferred: true } : {}),
	};
}

function findTask(tasks: readonly GoalTask[], id: string): GoalTask | undefined {
	for (const t of tasks) {
		if (t.id === id) return t;
		if (t.subtasks && t.subtasks.length > 0) {
			const found = findTask(t.subtasks, id);
			if (found) return found;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Activity (re-exported from the durable-ledger mapping, §12)
// ---------------------------------------------------------------------------

export { deriveGoalActivity };
export type { GoalActivityItem, GoalActivityKind } from "../goal-activity.ts";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Compact elapsed duration, e.g. `12m47s` (shared formatter from goal-core). */
export function formatDashboardDuration(seconds: number): string {
	return formatDuration(seconds);
}

/** Audit header duration label from milliseconds (§15.3). */
export function formatAuditElapsed(elapsedMs: number): string {
	return formatDuration(Math.floor(Math.max(0, elapsedMs) / 1000));
}

/**
 * Compact token count, e.g. `18.2K`, `2.5M`, `999`. Shared display label for
 * the dashboard header and budget rows.
 */
export function formatCompactTokens(value: number): string {
	const safe = Math.max(0, Math.floor(value));
	if (safe >= 1_000_000) return `${trimZero((safe / 1_000_000).toFixed(1))}M`;
	if (safe >= 1_000) return `${trimZero((safe / 1_000).toFixed(1))}K`;
	return String(safe);
}

function trimZero(value: string): string {
	return value.replace(/\.0$/, "");
}

/** Budget summary, e.g. `18.2K / 50K · 36%`. */
export function formatBudget(used: number, total: number): string {
	const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0;
	return `${formatCompactTokens(used)} / ${formatCompactTokens(total)} · ${pct}%`;
}

// ---------------------------------------------------------------------------
// Whole-model derivation
// ---------------------------------------------------------------------------

/**
 * Derive the unified dashboard model for one goal. Returns null when there is
 * no goal record; surfaces that need the "no goal / focus required" panel
 * (plan §4.3) render that from their own context with `otherOpenGoals`.
 */
export function deriveGoalDashboardModel(
	goal: GoalRecord | null,
	options: GoalDashboardModelOptions,
): GoalDashboardModel | null {
	if (!goal) return null;
	const { focused, otherOpenGoals, ledgerEvents = [], activityLimit, tasksDisabled = false } = options;

	const status = deriveGoalStatus(goal);
	// §9.5: with tasks disabled, omit task sections entirely (status,
	// verification, usage, path, and focus remain).
	const taskProgress = tasksDisabled ? undefined : deriveTopLevelTaskProgress(goal);
	const tree = tasksDisabled ? [] : flattenTaskTree(goal.taskList?.tasks, undefined);
	const currentTask = tasksDisabled ? undefined : deriveCurrentTask(goal, tree);
	const effectiveCurrentId = currentTask?.id;
	const taskTree = tree.map((n) => (n.id === effectiveCurrentId ? { ...n, isCurrent: true } : n));

	const budget =
		goal.tokenBudget !== undefined
			? {
					used: goal.usage.tokensUsed,
					total: goal.tokenBudget,
					percentage: percentageOf(goal.usage.tokensUsed, goal.tokenBudget),
					remaining: Math.max(0, goal.tokenBudget - goal.usage.tokensUsed),
				}
			: undefined;

	const taskTitles = new Map(taskTree.map((n) => [n.id, n.title]));
	const recentActivity = deriveGoalActivity(ledgerEvents, goal.id, { taskTitles, limit: activityLimit });

	return {
		goalId: goal.id,
		title: displayObjectiveTitle(goal.objective),
		status,
		focused,
		filePath: goal.activePath ?? goal.archivedPath,
		usage: {
			activeSeconds: goal.usage.activeSeconds,
			elapsedLabel: formatDashboardDuration(goal.usage.activeSeconds),
			tokens: goal.usage.tokensUsed,
			tokenLabel: `${formatCompactTokens(goal.usage.tokensUsed)} tok`,
		},
		budget,
		taskProgress,
		taskTree,
		currentTask,
		goalVerificationContract: goal.verificationContract,
		otherOpenGoals,
		recentActivity,
	};
}
