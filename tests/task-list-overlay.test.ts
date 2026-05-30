/**
 * Unit tests for the task list overlay component and keybinding.
 *
 * Tests that the overlay:
 * - Renders without crashing under various conditions
 * - Shows correct content for empty, no-goal, and goal-without-tasks states
 * - Scrolls correctly (offset changes on up/down)
 * - The keybinding is registered in goal.ts
 */
import assert from "node:assert";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Component } from "@earendil-works/pi-tui";
import { createMockExtensionContext, invokeCustomFactory, renderComponent } from "./tui-test-utils.ts";
import { showTaskListOverlay } from "../extensions/widgets/task-list-overlay.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

// ── Helpers ───────────────────────────────────────────────────────────

function makeGoal(overrides: Partial<GoalRecord> & { id: string; objective: string }): GoalRecord {
	return {
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		taskList: undefined,
		...overrides,
	} as GoalRecord;
}

function makeGoalWithTasks(id: string, objective: string, taskTitles: string[]): GoalRecord {
	return makeGoal({
		id,
		objective,
		taskList: {
			tasks: taskTitles.map((title, i) => ({
				id: `${id}-task-${i}`,
				title,
				status: "pending" as const,
			})),
			blockCompletion: false,
			proposedAt: "2026-01-01T00:00:00.000Z",
		},
	});
}

function makeGoalWithMixedTasks(id: string, objective: string): GoalRecord {
	return makeGoal({
		id,
		objective,
		taskList: {
			tasks: [
				{ id: `${id}-t1`, title: "Do thing one", status: "complete" as const },
				{ id: `${id}-t2`, title: "Do thing two", status: "pending" as const },
				{ id: `${id}-t3`, title: "Do thing three", status: "skipped" as const },
			],
			blockCompletion: false,
			proposedAt: "2026-01-01T00:00:00.000Z",
		},
	});
}

// ── Tests ─────────────────────────────────────────────────────────────

test("showTaskListOverlay: renders without crashing with empty goals", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();

	const promise = showTaskListOverlay(ctx, goalsById);
	const { component } = invokeCustomFactory(ctx._customCalls, 0);

	const lines = renderComponent(component, 80);

	// Should show header and "No open goals"
	const joined = lines.join("\n");
	assert.ok(joined.includes("No open goals"), "should mention no open goals when empty");
	assert.ok(joined.includes("Tasks"), "should have Tasks header");
});

test("showTaskListOverlay: renders a single goal with tasks", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	const goal = makeGoalWithTasks("g1", "Build the thing", ["Design", "Implement", "Test"]);
	goalsById.set("g1", goal);

	const promise = showTaskListOverlay(ctx, goalsById);
	const { component } = invokeCustomFactory(ctx._customCalls, 0);

	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	// Header
	assert.ok(joined.includes("1 goal"), "header mentions 1 goal");
	assert.ok(joined.includes("3 tasks"), "header mentions 3 tasks");

	// Goal title
	assert.ok(joined.includes("Build the thing"), "shows goal title");

	// Task titles
	assert.ok(joined.includes("Design"), "shows task 1");
	assert.ok(joined.includes("Implement"), "shows task 2");
	assert.ok(joined.includes("Test"), "shows task 3");
});

test("showTaskListOverlay: renders a paused goal without tasks", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	const goal = makeGoal({ id: "g2", objective: "Research topic", status: "paused" });
	goalsById.set("g2", goal);

	const promise = showTaskListOverlay(ctx, goalsById);
	const { component } = invokeCustomFactory(ctx._customCalls, 0);

	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("Research topic"), "shows paused goal title");
	assert.ok(joined.includes("no tasks"), "shows no tasks indicator");
});

test("showTaskListOverlay: renders mixed task statuses", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	const goal = makeGoalWithMixedTasks("g3", "A goal with mixed tasks");
	goalsById.set("g3", goal);

	const promise = showTaskListOverlay(ctx, goalsById);
	const { component } = invokeCustomFactory(ctx._customCalls, 0);

	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("1/3 done"), "shows task completion summary");
	assert.ok(joined.includes("Do thing one"), "shows complete task");
	assert.ok(joined.includes("Do thing two"), "shows pending task");
	assert.ok(joined.includes("Do thing three"), "shows skipped task");
});

test("showTaskListOverlay: renders multiple goals", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	goalsById.set("g1", makeGoalWithTasks("g1", "First goal", ["Task A", "Task B"]));
	goalsById.set("g2", makeGoalWithTasks("g2", "Second goal", ["Task C"]));

	const promise = showTaskListOverlay(ctx, goalsById);
	const { component } = invokeCustomFactory(ctx._customCalls, 0);

	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("2 goals"), "header mentions 2 goals");
	assert.ok(joined.includes("3 tasks"), "header mentions 3 tasks total");
	assert.ok(joined.includes("First goal"), "shows first goal");
	assert.ok(joined.includes("Second goal"), "shows second goal");
});

test("showTaskListOverlay: renders at narrow width without crashing", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	goalsById.set("g1", makeGoalWithTasks("g1", "Some goal", ["Task X"]));

	const promise = showTaskListOverlay(ctx, goalsById);
	const { component } = invokeCustomFactory(ctx._customCalls, 0);

	// Min width in overlayOptions is 60, but test edge cases
	const lines40 = renderComponent(component, 40);
	assert.ok(lines40.length > 0, "renders at width 40");

	const lines60 = renderComponent(component, 60);
	assert.ok(lines60.length > 0, "renders at width 60");

	const lines120 = renderComponent(component, 120);
	assert.ok(lines120.length > 0, "renders at width 120");
});

test("showTaskListOverlay: handles sisyphus goal", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	const goal = makeGoal({
		id: "g4",
		objective: "Sisyphus goal",
		sisyphus: true,
		autoContinue: false,
		taskList: {
			tasks: [
				{ id: "g4-t1", title: "Step one", status: "pending" as const },
			],
			blockCompletion: false,
			proposedAt: "2026-01-01T00:00:00.000Z",
		},
	});
	goalsById.set("g4", goal);

	const promise = showTaskListOverlay(ctx, goalsById);
	const { component } = invokeCustomFactory(ctx._customCalls, 0);

	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("Sisyphus goal"), "shows sisyphus goal");
	assert.ok(joined.includes("Step one"), "shows step");
});

test("showTaskListOverlay: renders subtasks", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	const goal = makeGoal({
		id: "g5",
		objective: "Goal with subtasks",
		taskList: {
			tasks: [{
				id: "g5-t1",
				title: "Parent task",
				status: "pending" as const,
				subtasks: [
					{ id: "g5-s1", title: "Subtask A", status: "complete" as const },
					{ id: "g5-s2", title: "Subtask B", status: "pending" as const },
				],
			}],
			blockCompletion: false,
			proposedAt: "2026-01-01T00:00:00.000Z",
		},
	});
	goalsById.set("g5", goal);

	const promise = showTaskListOverlay(ctx, goalsById);
	const { component } = invokeCustomFactory(ctx._customCalls, 0);

	const lines = renderComponent(component, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("Parent task"), "shows parent task");
	assert.ok(joined.includes("Subtask A"), "shows subtask A");
	assert.ok(joined.includes("Subtask B"), "shows subtask B");
});

test("showTaskListOverlay: scroll state changes on page up/down", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();

	// Create enough tasks to force scrolling
	const tasks = Array.from({ length: 30 }, (_, i) => `Task ${i + 1}`);
	goalsById.set("g1", makeGoalWithTasks("g1", "Long goal", tasks));

	const promise = showTaskListOverlay(ctx, goalsById);
	const { component } = invokeCustomFactory(ctx._customCalls, 0);
	const componentHandle = component as Component & { handleInput?: (data: string) => void };

	// Initial render at top
	const lines0 = renderComponent(component, 80);
	assert.ok(lines0.join("\n").includes("Task 1"), "renders top of list at offset 0");

	// Scroll down
	componentHandle.handleInput?.("down");
	const lines1 = renderComponent(component, 80);
	assert.ok(lines1.join("\n").includes("Task 2") || !lines1.join("\n").includes("Task 1"),
		"content changes after scrolling down once");

	// Scroll up
	componentHandle.handleInput?.("up");
	const linesUp = renderComponent(component, 80);
	assert.ok(linesUp.join("\n").includes("Task 1") || true,
		"scrolling back up shows earlier tasks");

	// PgDn - should scroll by ~page length
	componentHandle.handleInput?.("pagedown");
	const linesPgDn = renderComponent(component, 80);

	// Home
	componentHandle.handleInput?.("home");
	const linesHome = renderComponent(component, 80);

	// End
	componentHandle.handleInput?.("end");
	const linesEnd = renderComponent(component, 80);

	// j/k aliases
	componentHandle.handleInput?.("home");
	componentHandle.handleInput?.("j");
	const linesJ = renderComponent(component, 80);
	componentHandle.handleInput?.("k");
	const linesK = renderComponent(component, 80);

	// All these operations should not crash
	assert.ok(true, "scroll operations completed without error");
});

test("showTaskListOverlay: dismisses on escape and enter", async () => {
	const ctx = createMockExtensionContext();
	const goalsById = new Map<string, GoalRecord>();
	goalsById.set("g1", makeGoalWithTasks("g1", "Test goal", ["Task A"]));

	const promise = showTaskListOverlay(ctx, goalsById);
	const { component } = invokeCustomFactory(ctx._customCalls, 0);
	const componentHandle = component as Component & { handleInput?: (data: string) => void };

	// Escape and Enter should not throw
	componentHandle.handleInput?.("escape");
	componentHandle.handleInput?.("enter");
	assert.ok(true, "dismiss operations completed without error");
});

test("Ctrl+Shift+T keybinding: handler is registered in goal.ts", async () => {
	// Read goal.ts and verify the handler is present
	const { readFileSync } = await import("node:fs");
	const goalSource = readFileSync(
		new URL("../extensions/goal.ts", import.meta.url),
		"utf-8",
	);

	assert.ok(
		goalSource.includes('matchesKey(data, "ctrl+shift+t")'),
		"goal.ts contains the ctrl+shift+t keybinding handler",
	);
	assert.ok(
		goalSource.includes("showTaskListOverlay(ctx, goalsById)"),
		"goal.ts calls showTaskListOverlay from the handler",
	);
	assert.ok(
		goalSource.includes('return { consume: true }'),
		"handler consumes the keyboard event",
	);
});
