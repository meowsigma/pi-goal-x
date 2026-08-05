/**
 * Dashboard model tests (plan §19.1): pure derivation of the unified
 * dashboard view model from persisted goal state and the durable ledger.
 *
 * The model module must stay free of TUI imports; these tests exercise the
 * derivation rules only (status codes, top-level progress, tree flattening,
 * current-task resolution, subtask progress, budget, activity, formatting).
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { GoalLedgerEvent } from "../extensions/goal-ledger.ts";
import type { GoalRecord, GoalTask } from "../extensions/goal-record.ts";
import {
	deriveCurrentTask,
	deriveCurrentTaskSubtaskProgress,
	deriveGoalDashboardModel,
	deriveGoalStatus,
	deriveTopLevelTaskProgress,
	flattenTaskTree,
	formatBudget,
	formatCompactTokens,
	formatDashboardDuration,
	type DashboardTaskNode,
} from "../extensions/widgets/goal-dashboard-model.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function task(id: string, title: string, overrides: Partial<GoalTask> = {}): GoalTask {
	return { id, title, status: "pending", ...overrides };
}

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g1",
		objective: "Add CSV export to reports",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 18200, activeSeconds: 767 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function model(
	overrides: Partial<GoalRecord> = {},
	opts: Partial<{ focused: boolean; otherOpenGoals: number; ledgerEvents: GoalLedgerEvent[]; activityLimit: number }> = {},
) {
	const m = deriveGoalDashboardModel(goal(overrides), { focused: true, otherOpenGoals: 0, ...opts });
	if (!m) throw new Error("deriveGoalDashboardModel returned null for a non-null goal");
	return m;
}

/** Standard five-top-level-task tree from the plan's examples. */
function fiveTaskList(): GoalTask[] {
	return [
		task("t1", "Review reports page and data source", { status: "complete", evidence: "Reviewed source" }),
		task("t2", "Implement filtered CSV export", { status: "complete" }),
		task("t3", "Add the download button", {
			verificationContract: "The button downloads a CSV using the active filters.",
			subtasks: [
				task("t3.1", "Add loading state", { status: "complete", evidence: "Loading state added" }),
				task("t3.2", "Generate timestamped filename", { status: "complete" }),
				task("t3.3", "Add error handling"),
			],
		}),
		task("t4", "Add documentation"),
		task("t5", "Add and run tests"),
	];
}

function withTasks(taskList: GoalTask[]): Partial<GoalRecord> {
	return { taskList: { tasks: taskList, blockCompletion: false, proposedAt: "2026-01-01T00:00:00.000Z" } };
}

function ev(type: string, at: string, extra: Record<string, unknown> = {}): GoalLedgerEvent {
	return { type, goalId: "g1", at, ...extra } as unknown as GoalLedgerEvent;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

test("formatDashboardDuration renders compact h/m/s labels", () => {
	assert.equal(formatDashboardDuration(0), "0s");
	assert.equal(formatDashboardDuration(767), "12m47s");
	assert.equal(formatDashboardDuration(3661), "1h01m01s");
});

test("formatCompactTokens renders compact token labels", () => {
	assert.equal(formatCompactTokens(0), "0");
	assert.equal(formatCompactTokens(999), "999");
	assert.equal(formatCompactTokens(1200), "1.2K");
	assert.equal(formatCompactTokens(18200), "18.2K");
	assert.equal(formatCompactTokens(2_500_000), "2.5M");
});

test("formatBudget summarizes used/total/percentage", () => {
	assert.equal(formatBudget(18200, 50000), "18.2K / 50K · 36%");
	assert.equal(formatBudget(0, 0), "0 / 0 · 0%");
});

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

test("status maps lifecycle states to explicit display codes", () => {
	assert.deepEqual(deriveGoalStatus(goal()), { code: "running", label: "In progress" });
	assert.deepEqual(deriveGoalStatus(goal({ autoContinue: false })), { code: "idle", label: "Idle" });
	assert.deepEqual(deriveGoalStatus(goal({ status: "paused", stopReason: "agent" })), { code: "paused", label: "Paused (agent)" });
	assert.deepEqual(deriveGoalStatus(goal({ status: "paused", stopReason: "user" })), { code: "paused", label: "Paused (user)" });
	assert.deepEqual(
		deriveGoalStatus(goal({ status: "blocked", pauseReason: "Build fails", pauseSuggestedAction: "Run npm test" })),
		{ code: "blocked", label: "Blocked", reason: "Build fails", suggestedAction: "Run npm test" },
	);
	assert.deepEqual(deriveGoalStatus(goal({ status: "budget_limited" })), { code: "budget_limited", label: "Budget limited" });
	assert.deepEqual(deriveGoalStatus(goal({ status: "complete" })), { code: "complete", label: "Complete" });
});

// ---------------------------------------------------------------------------
// Top-level progress (§9.1)
// ---------------------------------------------------------------------------

test("active goal without tasks has no progress sections", () => {
	const m = model();
	assert.equal(m.title, "Add CSV export to reports");
	assert.equal(m.status.code, "running");
	assert.equal(m.taskProgress, undefined);
	assert.deepEqual(m.taskTree, []);
	assert.equal(m.currentTask, undefined);
});

test("partial tasks derive 3/5 · 60% with skipped counted as done", () => {
	const tasks = fiveTaskList();
	tasks.push(task("t6", "Legacy fallback", { status: "skipped" }));
	const m = model(withTasks(tasks));
	assert.deepEqual(m.taskProgress, { completed: 3, total: 6, percentage: 50 });
	// skipped is tracked separately in the tree but counts toward progress
	const skipped = m.taskTree.find((n) => n.id === "t6");
	assert.equal(skipped?.status, "skipped");
});

test("all top-level tasks complete derive 100% and no current task", () => {
	const tasks = fiveTaskList().map((t) => ({
		...t,
		status: "complete" as const,
		subtasks: t.subtasks?.map((s) => ({ ...s, status: "complete" as const })),
	}));
	const m = model(withTasks(tasks));
	assert.deepEqual(m.taskProgress, { completed: 5, total: 5, percentage: 100 });
	assert.equal(m.currentTask, undefined);
});

test("top-level progress counts only top-level tasks", () => {
	const tasks = [task("a", "A", { status: "complete" }), task("b", "B", { subtasks: [task("b.1", "B1", { status: "complete" })] })];
	assert.deepEqual(deriveTopLevelTaskProgress(goal(withTasks(tasks))), { completed: 1, total: 2, percentage: 50 });
});

// ---------------------------------------------------------------------------
// Task tree flattening (§9.2)
// ---------------------------------------------------------------------------

test("flattenTaskTree walks the tree recursively with depth and current marker", () => {
	const nodes = flattenTaskTree(fiveTaskList(), "t3.3");
	const ids = nodes.map((n) => n.id);
	assert.deepEqual(ids, ["t1", "t2", "t3", "t3.1", "t3.2", "t3.3", "t4", "t5"]);
	assert.equal(nodes.find((n) => n.id === "t3.3")?.depth, 1);
	assert.equal(nodes.find((n) => n.id === "t3")?.depth, 0);
	assert.equal(nodes.find((n) => n.id === "t3.3")?.isCurrent, true);
	assert.equal(nodes.filter((n) => n.isCurrent).length, 1);
});

test("flattenTaskTree with no tasks returns an empty tree", () => {
	assert.deepEqual(flattenTaskTree(undefined), []);
	assert.deepEqual(flattenTaskTree([]), []);
});

test("tree nodes carry verification contracts and evidence", () => {
	const nodes = flattenTaskTree(fiveTaskList());
	const t1 = nodes.find((n) => n.id === "t1");
	const t3 = nodes.find((n) => n.id === "t3");
	assert.equal(t1?.evidence, "Reviewed source");
	assert.equal(t3?.verificationContract, "The button downloads a CSV using the active filters.");
});

// ---------------------------------------------------------------------------
// Current task resolution (§7.2, §7.4, §9.3)
// ---------------------------------------------------------------------------

test("persisted current top-level task is resolved without inference", () => {
	const m = model({ ...withTasks(fiveTaskList()), currentTaskId: "t3" });
	assert.equal(m.currentTask?.id, "t3");
	assert.equal(m.currentTask?.title, "Add the download button");
	assert.equal(m.currentTask?.depth, 0);
	assert.equal(m.currentTask?.inferred, undefined);
	const t3 = m.taskTree.find((n) => n.id === "t3");
	assert.equal(t3?.isCurrent, true);
});

test("current nested subtask is resolved with its depth", () => {
	const m = model({ ...withTasks(fiveTaskList()), currentTaskId: "t3.3" });
	assert.equal(m.currentTask?.id, "t3.3");
	assert.equal(m.currentTask?.depth, 1);
	assert.equal(m.taskTree.find((n) => n.id === "t3.3")?.isCurrent, true);
});

test("current parent task shows direct-child subtask progress", () => {
	const m = model({ ...withTasks(fiveTaskList()), currentTaskId: "t3" });
	assert.deepEqual(
		{
			completed: m.currentTask?.completedSubtasks,
			total: m.currentTask?.totalSubtasks,
			pct: m.currentTask?.subtaskPercentage,
		},
		{ completed: 2, total: 3, pct: 67 },
	);
});

test("current leaf task omits subtask progress (all-zero totals)", () => {
	const m = model({ ...withTasks(fiveTaskList()), currentTaskId: "t4" });
	assert.equal(m.currentTask?.totalSubtasks, 0);
	assert.equal(m.currentTask?.subtaskPercentage, 0);
});

test("invalid currentTaskId falls back to the first pending task and is marked inferred", () => {
	const m = model({ ...withTasks(fiveTaskList()), currentTaskId: "t999" });
	assert.equal(m.currentTask?.inferred, true);
	assert.equal(m.currentTask?.id, "t3"); // first pending in tree order
	assert.equal(m.currentTask?.completedSubtasks, 2); // subtask progress still derives
});

test("removed current task falls back to first pending", () => {
	const tasks = [task("a", "A", { status: "complete" }), task("b", "B")];
	const m = model({ ...withTasks(tasks), currentTaskId: "vanished" });
	assert.equal(m.currentTask?.id, "b");
	assert.equal(m.currentTask?.inferred, true);
});

test("currentTaskId pointing at a completed task is not accepted", () => {
	const tasks = [task("a", "A", { status: "complete" }), task("b", "B")];
	const m = model({ ...withTasks(tasks), currentTaskId: "a" });
	assert.equal(m.currentTask?.id, "b");
});

test("deriveCurrentTask returns undefined when nothing is pending", () => {
	const tasks = [task("a", "A", { status: "complete" })];
	const nodes: DashboardTaskNode[] = flattenTaskTree(tasks);
	assert.equal(deriveCurrentTask(goal(withTasks(tasks)), nodes), undefined);
});

// ---------------------------------------------------------------------------
// Subtask progress rule (§9.3)
// ---------------------------------------------------------------------------

test("deriveCurrentTaskSubtaskProgress uses direct children of the parent", () => {
	const tasks = fiveTaskList();
	const progress = deriveCurrentTaskSubtaskProgress({ id: "t3" }, tasks);
	assert.deepEqual(progress, { completedSubtasks: 2, totalSubtasks: 3, subtaskPercentage: 67 });
});

test("deriveCurrentTaskSubtaskProgress omits the ratio for a leaf", () => {
	const tasks = fiveTaskList();
	assert.deepEqual(deriveCurrentTaskSubtaskProgress({ id: "t4" }, tasks), { completedSubtasks: 0, totalSubtasks: 0, subtaskPercentage: 0 });
});

// ---------------------------------------------------------------------------
// Verification visibility (§11)
// ---------------------------------------------------------------------------

test("goal-level and task-level verification contracts are surfaced", () => {
	const m = model({
		...withTasks(fiveTaskList()),
		verificationContract: "Run npm test with zero failures.",
		currentTaskId: "t3",
	});
	assert.equal(m.goalVerificationContract, "Run npm test with zero failures.");
	assert.equal(m.currentTask?.verificationContract, "The button downloads a CSV using the active filters.");
});

// ---------------------------------------------------------------------------
// Open goals / focus / path
// ---------------------------------------------------------------------------

test("other open goals and focus state are reflected", () => {
	const m = model(withTasks(fiveTaskList()), { focused: false, otherOpenGoals: 2 });
	assert.equal(m.focused, false);
	assert.equal(m.otherOpenGoals, 2);
});

test("filePath prefers the active path and falls back to the archive path", () => {
	const m = model({ activePath: ".pi/goals/active_goal_g1.md" });
	assert.equal(m.filePath, ".pi/goals/active_goal_g1.md");
	const archived = model({ status: "complete", activePath: undefined, archivedPath: ".pi/goals/archived/goal_g1.md" });
	assert.equal(archived.filePath, ".pi/goals/archived/goal_g1.md");
});

test("no goal record derives a null model", () => {
	assert.equal(deriveGoalDashboardModel(null, { focused: false, otherOpenGoals: 0 }), null);
});

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

test("token budget derives used/total/percentage/remaining", () => {
	const m = model({ tokenBudget: 50000 });
	assert.deepEqual(m.budget, { used: 18200, total: 50000, percentage: 36, remaining: 31800 });
});

test("budget percentage clamps to 100 and remaining to zero", () => {
	const m = model({ tokenBudget: 10000 });
	assert.deepEqual(m.budget, { used: 18200, total: 10000, percentage: 100, remaining: 0 });
});

test("no budget means no budget section", () => {
	assert.equal(model().budget, undefined);
});

// ---------------------------------------------------------------------------
// Usage labels
// ---------------------------------------------------------------------------

test("usage derives elapsed and compact token labels", () => {
	const m = model();
	assert.equal(m.usage.activeSeconds, 767);
	assert.equal(m.usage.elapsedLabel, "12m47s");
	assert.equal(m.usage.tokens, 18200);
	assert.equal(m.usage.tokenLabel, "18.2K tok");
});

// ---------------------------------------------------------------------------
// Activity (§12 via the model)
// ---------------------------------------------------------------------------

test("recent activity is derived from the durable ledger", () => {
	const events = [
		ev("goal_created", "2026-01-01T09:00:00.000Z", { objective: "x", sisyphus: false, autoContinue: true }),
		ev("task_complete", "2026-01-01T09:05:00.000Z", { taskId: "t2", evidence: "Done" }),
		ev("task_started", "2026-01-01T09:06:00.000Z", { taskId: "t3" }),
	];
	const m = model(withTasks(fiveTaskList()), { ledgerEvents: events });
	assert.deepEqual(
		m.recentActivity.map((a) => a.text),
		["Created and focused the goal.", "Completed “Implement filtered CSV export”. — Done", "Started “Add the download button”."],
	);
});

test("activity respects the configured limit and excludes other goals", () => {
	const events = [
		ev("goal_created", "2026-01-01T09:00:00.000Z", { objective: "x", sisyphus: false, autoContinue: true }),
		ev("task_complete", "2026-01-01T09:05:00.000Z", { taskId: "t1" }),
		ev("task_complete", "2026-01-01T09:06:00.000Z", { taskId: "t2" }),
		{ ...ev("goal_created", "2026-01-01T09:01:00.000Z", { objective: "other", sisyphus: false, autoContinue: true }), goalId: "g2" },
	];
	const m = model(withTasks(fiveTaskList()), { ledgerEvents: events, activityLimit: 2 });
	assert.deepEqual(
		m.recentActivity.map((a) => a.text),
		["Completed “Review reports page and data source”.", "Completed “Implement filtered CSV export”."],
	);
});
