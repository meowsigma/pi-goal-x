/**
 * Tests for task list policy helpers in goal-policy.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	buildTaskSummary,
	taskCompletionBlockWarning,
	validateTaskCompletion,
	validateTaskSkip,
	validateTaskListProposal,
} from "../extensions/goal-policy.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeGoal(taskOverrides: Array<Partial<{ id: string; title: string; status: "pending" | "complete" | "skipped" }>>) {
	const tasks = taskOverrides.map((t, i) => ({
		id: t.id ?? `task-${i + 1}`,
		title: t.title ?? `Task ${i + 1}`,
		status: t.status ?? "pending" as const,
	}));
	return {
		id: "goal-1",
		objective: "Test goal",
		status: "active" as const,
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		taskList: {
			tasks,
			blockCompletion: false,
			proposedAt: "2026-05-27T00:00:00.000Z",
		},
	};
}

// ── buildTaskSummary ─────────────────────────────────────────────────────────

test("buildTaskSummary: no tasks", () => {
	const result = buildTaskSummary({
		tasks: [],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, "No tasks");
});

test("buildTaskSummary: all pending", () => {
	const result = buildTaskSummary({
		tasks: [
			{ id: "t1", title: "Task 1", status: "pending" },
			{ id: "t2", title: "Task 2", status: "pending" },
		],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, "0/2 tasks complete");
});

test("buildTaskSummary: some complete", () => {
	const result = buildTaskSummary({
		tasks: [
			{ id: "t1", title: "Task 1", status: "complete" },
			{ id: "t2", title: "Task 2", status: "pending" },
			{ id: "t3", title: "Task 3", status: "pending" },
		],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, "1/3 tasks complete");
});

test("buildTaskSummary: some skipped", () => {
	const result = buildTaskSummary({
		tasks: [
			{ id: "t1", title: "Task 1", status: "complete" },
			{ id: "t2", title: "Task 2", status: "skipped" },
			{ id: "t3", title: "Task 3", status: "pending" },
		],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, "1/3 tasks complete (1 skipped)");
});

test("buildTaskSummary: all complete", () => {
	const result = buildTaskSummary({
		tasks: [
			{ id: "t1", title: "Task 1", status: "complete" },
			{ id: "t2", title: "Task 2", status: "complete" },
		],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, "2/2 tasks complete");
});

// ── taskCompletionBlockWarning ────────────────────────────────────────────────

test("taskCompletionBlockWarning: no blockCompletion returns null", () => {
	const result = taskCompletionBlockWarning({
		tasks: [{ id: "t1", title: "Task 1", status: "pending" }],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, null);
});

test("taskCompletionBlockWarning: blockCompletion but no pending returns null", () => {
	const result = taskCompletionBlockWarning({
		tasks: [{ id: "t1", title: "Task 1", status: "complete" }],
		blockCompletion: true,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.equal(result, null);
});

test("taskCompletionBlockWarning: blockCompletion with pending returns warning", () => {
	const result = taskCompletionBlockWarning({
		tasks: [
			{ id: "t1", title: "Task 1", status: "complete" },
			{ id: "t2", title: "Task 2", status: "pending" },
		],
		blockCompletion: true,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.ok(result);
	assert.match(result, /pending/);
	assert.match(result, /blockCompletion/);
});

test("taskCompletionBlockWarning: plural tasks", () => {
	const result = taskCompletionBlockWarning({
		tasks: [
			{ id: "t1", title: "Task 1", status: "pending" },
			{ id: "t2", title: "Task 2", status: "pending" },
		],
		blockCompletion: true,
		proposedAt: "2026-05-27T00:00:00.000Z",
	});
	assert.match(result!, /2 tasks/);
});

// ── validateTaskCompletion ────────────────────────────────────────────────────

test("validateTaskCompletion: no goal", () => {
	const result = validateTaskCompletion({ goal: null, taskId: "t1" });
	assert.equal(result.ok, false);
	assert.match(result.message, /No goal/);
});

test("validateTaskCompletion: no task list", () => {
	const goal = { ...makeGoal([]), taskList: undefined };
	const result = validateTaskCompletion({ goal: goal as any, taskId: "t1" });
	assert.equal(result.ok, false);
	assert.match(result.message, /no task list/);
});

test("validateTaskCompletion: unknown task", () => {
	const goal = makeGoal([{ id: "t1", title: "T1" }]);
	const result = validateTaskCompletion({ goal, taskId: "t2" });
	assert.equal(result.ok, false);
	assert.match(result.message, /not found/);
});

test("validateTaskCompletion: already complete", () => {
	const goal = makeGoal([{ id: "t1", title: "T1", status: "complete" }]);
	const result = validateTaskCompletion({ goal, taskId: "t1" });
	assert.equal(result.ok, false);
	assert.match(result.message, /already complete/);
});

test("validateTaskCompletion: already skipped", () => {
	const goal = makeGoal([{ id: "t1", title: "T1", status: "skipped" }]);
	const result = validateTaskCompletion({ goal, taskId: "t1" });
	assert.equal(result.ok, false);
	assert.match(result.message, /already skipped/);
});

test("validateTaskCompletion: valid pending task", () => {
	const goal = makeGoal([{ id: "t1", title: "T1", status: "pending" }]);
	const result = validateTaskCompletion({ goal, taskId: "t1" });
	assert.equal(result.ok, true);
});

// ── validateTaskSkip ──────────────────────────────────────────────────────────

test("validateTaskSkip: no goal", () => {
	const result = validateTaskSkip({ goal: null, taskId: "t1", reason: "irrelevant" });
	assert.equal(result.ok, false);
	assert.match(result.message, /No goal/);
});

test("validateTaskSkip: no task list", () => {
	const goal = { ...makeGoal([]), taskList: undefined };
	const result = validateTaskSkip({ goal: goal as any, taskId: "t1", reason: "irrelevant" });
	assert.equal(result.ok, false);
	assert.match(result.message, /no task list/);
});

test("validateTaskSkip: unknown task", () => {
	const goal = makeGoal([{ id: "t1", title: "T1" }]);
	const result = validateTaskSkip({ goal, taskId: "t2", reason: "irrelevant" });
	assert.equal(result.ok, false);
	assert.match(result.message, /not found/);
});

test("validateTaskSkip: already complete", () => {
	const goal = makeGoal([{ id: "t1", title: "T1", status: "complete" }]);
	const result = validateTaskSkip({ goal, taskId: "t1", reason: "irrelevant" });
	assert.equal(result.ok, false);
	assert.match(result.message, /already complete/);
});

test("validateTaskSkip: already skipped", () => {
	const goal = makeGoal([{ id: "t1", title: "T1", status: "skipped" }]);
	const result = validateTaskSkip({ goal, taskId: "t1", reason: "irrelevant" });
	assert.equal(result.ok, false);
	assert.match(result.message, /already skipped/);
});

test("validateTaskSkip: empty reason", () => {
	const goal = makeGoal([{ id: "t1", title: "T1", status: "pending" }]);
	const result = validateTaskSkip({ goal, taskId: "t1", reason: "" });
	assert.equal(result.ok, false);
	assert.match(result.message, /non-empty reason/);
});

test("validateTaskSkip: valid skip", () => {
	const goal = makeGoal([{ id: "t1", title: "T1", status: "pending" }]);
	const result = validateTaskSkip({ goal, taskId: "t1", reason: "No longer needed" });
	assert.equal(result.ok, true);
});

// ── validateTaskListProposal ──────────────────────────────────────────────────

test("validateTaskListProposal: no goal", () => {
	const result = validateTaskListProposal({ goal: null, tasks: [{ id: "t1", title: "T1" }] });
	assert.equal(result.ok, false);
	assert.match(result.message, /No goal/);
});

test("validateTaskListProposal: valid proposal", () => {
	const goal = makeGoal([]);
	const result = validateTaskListProposal({ goal, tasks: [{ id: "t1", title: "Task 1" }, { id: "t2", title: "Task 2" }] });
	assert.equal(result.ok, true);
});

test("validateTaskListProposal: duplicate ids", () => {
	const goal = makeGoal([]);
	const result = validateTaskListProposal({ goal, tasks: [{ id: "t1", title: "Task 1" }, { id: "t1", title: "Task 1 again" }] });
	assert.equal(result.ok, false);
	assert.match(result.message, /Duplicate/);
});

test("validateTaskListProposal: empty id", () => {
	const goal = makeGoal([]);
	const result = validateTaskListProposal({ goal, tasks: [{ id: "", title: "Task" }] });
	assert.equal(result.ok, false);
	assert.match(result.message, /non-empty id/);
});

test("validateTaskListProposal: empty title", () => {
	const goal = makeGoal([]);
	const result = validateTaskListProposal({ goal, tasks: [{ id: "t1", title: "" }] });
	assert.equal(result.ok, false);
	assert.match(result.message, /non-empty title/);
});

test("validateTaskListProposal: over 50 tasks", () => {
	const goal = makeGoal([]);
	const tasks = Array.from({ length: 51 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}` }));
	const result = validateTaskListProposal({ goal, tasks });
	assert.equal(result.ok, false);
	assert.match(result.message, /cannot exceed 50/);
});
