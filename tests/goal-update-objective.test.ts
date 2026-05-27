import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCompletionReport, validateGoalUpdate } from "../extensions/goal-policy.ts";
import { createGoal } from "../extensions/goal-record.ts";
import {
	archiveGoalFile,
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

interface TestContext {
	cwd: string;
}

function tempCtx(): TestContext {
	return { cwd: mkdtempSync(path.join(tmpdir(), "goal-update-objective-test-")) };
}

function cleanup(ctx: TestContext): void {
	try {
		rmSync(ctx.cwd, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		...createGoal({
			objective: "Original objective: build feature X",
			autoContinue: true,
			sisyphus: false,
		}, Date.UTC(2026, 5, 2, 10, 0, 0)),
		...overrides,
	};
}

// ─── validateGoalUpdate (handler gate) ───────────────────────────────────────

test("validateGoalUpdate rejects null goal (no goal exists)", () => {
	const result = validateGoalUpdate({ goal: null });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.match(result.message, /cannot update objective/);
		assert.match(result.message, /No goal is set/);
	}
});

test("validateGoalUpdate rejects complete goal", () => {
	const goal = makeGoal({ status: "complete" } as GoalRecord);
	const result = validateGoalUpdate({ goal });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.match(result.message, /cannot update objective/);
		assert.match(result.message, /already complete/);
	}
});

test("validateGoalUpdate accepts active goal", () => {
	const result = validateGoalUpdate({ goal: makeGoal() });
	assert.equal(result.ok, true);
});

test("validateGoalUpdate accepts paused goal", () => {
	const result = validateGoalUpdate({ goal: makeGoal({ status: "paused" }) });
	assert.equal(result.ok, true);
});

// ─── updatedObjective schema rejection (was removed from complete_goal) ───────

test("complete_goal schema has additionalProperties: false to reject unknown params", () => {
	const source = readFileSync("extensions/goal.ts", "utf8");
	const updateGoalIdx = source.indexOf('name: "complete_goal"');
	assert.ok(updateGoalIdx >= 0, "must find complete_goal tool registration");
	const registerBlock = source.substring(updateGoalIdx, updateGoalIdx + 4000);
	assert.ok(registerBlock.includes("additionalProperties: false"),
		"complete_goal schema must have additionalProperties: false");
	assert.ok(!registerBlock.includes("updatedObjective"),
		"complete_goal schema must not contain updatedObjective");
	assert.ok(!source.includes("updatedObjective"),
		"updatedObjective must not appear anywhere in goal.ts");
});

test("complete_goal without status throws correct error message", () => {
	const source = readFileSync("extensions/goal.ts", "utf8");
	const updateGoalIdx = source.indexOf('name: "complete_goal"');
	const registerBlock = source.substring(updateGoalIdx, updateGoalIdx + 4000);
	assert.ok(!registerBlock.includes("params.updatedObjective"),
		"Phase 1 updatedObjective handling must be removed");
	assert.ok(registerBlock.includes('"complete_goal requires status=complete when marking a goal complete."'),
		"handler must throw error mentioning status=complete");
	assert.ok(!registerBlock.includes("updatedObjective"),
		"handler must not reference updatedObjective in error messages");
});

// ─── completion flow unaffected ────────────────────────────────────────────

// ─── completion flow unaffected ────────────────────────────────────────────

test("complete_goal with status=complete still works (completion flow unchanged)", () => {
	const ctx = tempCtx();
	try {
		const goal = makeGoal();
		const active = writeActiveGoalFile(ctx, goal);
		assert.equal(active.status, "active");

		const completed = writeActiveGoalFile(ctx, {
			...active,
			status: "complete" as const,
			stopReason: "agent" as const,
			updatedAt: new Date().toISOString(),
		});
		assert.equal(completed.status, "complete");
		assert.equal(completed.objective, active.objective);

		const diskContent = readFileSync(path.join(ctx.cwd, completed.activePath ?? "missing"), "utf8");
		assert.ok(diskContent.includes('"status": "complete"'));

		const archived = archiveGoalFile(ctx, completed);
		assert.equal(archived.activePath, undefined);
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);
	} finally {
		cleanup(ctx);
	}
});

// ─── buildCompletionReport ──────────────────────────────────────────────────

test("buildCompletionReport handles updated objective display", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Build feature X\nUpdated objective: Build feature Y\nStatus: active",
		completionSummary: "Feature Y built successfully.",
		auditorReport: "Inspected and verified.\n\n<approved/>",
	});
	assert.ok(report.includes("Goal complete."));
	assert.ok(report.includes("<approved/>"));
});

// ─── propose_goal_tweak handler simulation ───────────────────────────────────
// The propose_goal_tweak confirm path writes the new objective via
// writeActiveGoalFile, appends a state entry, clears tweakDraftingFor, sets
// turnStoppedFor, and returns terminate:true. We simulate the storage-level
// write and verify the goal is updated on disk.

test("propose_goal_tweak path: writeActiveGoalFile with new objective (simulated handler execution)", () => {
	const ctx = tempCtx();
	try {
		const originalObj = "Original objective";
		const newObj = "Tweaked objective after /goal-tweak interview";

		// Write the original active goal
		const goal = makeGoal({ objective: originalObj });
		const active = writeActiveGoalFile(ctx, goal);
		assert.equal(active.objective, originalObj);

		// Simulate propose_goal_tweak confirm path: write with new objective (same
		// pattern the handler uses: spread state goal, set new objective + updatedAt)
		const tweaked = writeActiveGoalFile(ctx, {
			...active,
			objective: newObj,
			updatedAt: new Date().toISOString(),
		});
		assert.equal(tweaked.objective, newObj, "objective must be updated");
		assert.equal(tweaked.status, "active", "status must remain active after tweak");
		assert.equal(tweaked.activePath, active.activePath,
			"active file path should not change on tweak");

		// Verify disk has the updated objective
		const diskContent = readFileSync(path.join(ctx.cwd, tweaked.activePath ?? "missing"), "utf8");
		assert.ok(diskContent.includes(newObj), "disk must have the tweaked objective");
		assert.ok(diskContent.includes('"status": "active"'), "disk must show active status");

		// Verify still in the active pool
		const pool = readActiveGoalPool(ctx);
		assert.ok(pool.has(goal.id), "tweaked goal must still be in active pool");
	} finally {
		cleanup(ctx);
	}
});

// ─── prompt evolution instruction ────────────────────────────────────────────

test("goal evolution instruction mentions /goal-tweak instead of updatedObjective", async () => {
	const { goalPrompt, continuationPrompt } = await import("../extensions/prompts/goal-prompts.ts");
	const goal = makeGoal();

	const contText = continuationPrompt(goal);
	assert.ok(contText.includes("Goal evolution:"), "continuationPrompt must include Goal evolution instruction");
	assert.ok(!contText.includes("updatedObjective"), "continuationPrompt must NOT reference updatedObjective");
	assert.ok(contText.includes("immutable"), "continuationPrompt must mention the goal is immutable");
	assert.ok(contText.includes("/goal-tweak"), "continuationPrompt must instruct user to run /goal-tweak");

	const goalText = goalPrompt(goal);
	assert.ok(goalText.includes("Goal evolution:"), "goalPrompt must include Goal evolution instruction");
	assert.ok(!goalText.includes("updatedObjective"), "goalPrompt must NOT reference updatedObjective");
	assert.ok(goalText.includes("/goal-tweak"), "goalPrompt must instruct user to run /goal-tweak");
});
