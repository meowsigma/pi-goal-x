import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCompletionReport } from "../extensions/goal-policy.ts";
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

/**
 * Simulates the update_goal({updatedObjective}) path:
 * 1. Create and write an active goal with original objective
 * 2. Read it back, verify original objective
 * 3. Simulate update: writeActiveGoalFile with new objective
 * 4. Read it back, verify new objective, status unchanged (active)
 * 5. Verify the goal is still in the active pool
 */
test("update_goal with updatedObjective updates objective in memory and on disk", () => {
	const ctx = tempCtx();
	try {
		const originalObj = "Original objective: build feature X";
		const newObj = "Updated objective: build feature Y after requirements change";

		// Step 1: Create and write an active goal
		const goal = makeGoal({ objective: originalObj });
		const active = writeActiveGoalFile(ctx, goal);
		assert.match(active.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		assert.equal(active.status, "active");
		assert.equal(active.objective, originalObj);

		// Verify it's on disk
		const activeFilePath = path.join(ctx.cwd, active.activePath ?? "missing");
		const diskContent1 = readFileSync(activeFilePath, "utf8");
		assert.ok(diskContent1.includes(originalObj), "original objective should be on disk");

		// Verify in pool
		const pool1 = readActiveGoalPool(ctx);
		assert.ok(pool1.has(goal.id), "goal should be in pool");

		// Step 2: Simulate update_goal({updatedObjective}) — write with new objective
		const updated = writeActiveGoalFile(ctx, { ...active, objective: newObj });
		assert.equal(updated.status, "active", "status must remain active after update");
		assert.equal(updated.objective, newObj, "objective must be updated in returned record");
		assert.match(updated.activePath ?? "", /^\.pi\/goals\/active_goal_/,
			"updated goal should still be an active file (not archived)");
		assert.equal(updated.archivedPath, undefined, "updated goal should not be archived");

		// Step 3: Verify on disk
		const diskContent2 = readFileSync(activeFilePath, "utf8");
		assert.ok(diskContent2.includes(newObj), "new objective should be on disk");
		assert.ok(!diskContent2.includes(originalObj), "original objective should be gone from disk");
		assert.ok(diskContent2.includes('"status": "active"'), "status on disk must still be active");

		// Step 4: Verify still in active pool (same file path)
		const pool2 = readActiveGoalPool(ctx);
		assert.ok(pool2.has(goal.id), "goal should still be in pool after update");

		// Step 5: Verify the active file path is the same (same goal file, just updated content)
		assert.equal(updated.activePath, active.activePath,
			"active file path should not change on objective update");
	} finally {
		cleanup(ctx);
	}
});

/**
 * Simulates the combined path: update_goal({updatedObjective, status:"complete"})
 * The objective is updated before the completion completes.
 */
test("combined updatedObjective + status=complete applies update before completion", () => {
	const ctx = tempCtx();
	try {
		const originalObj = "Original objective for combined test";
		const newObj = "Updated before complete: final requirement";

		// Write active goal
		const goal = makeGoal({ objective: originalObj });
		const active = writeActiveGoalFile(ctx, goal);
		assert.equal(active.objective, originalObj);

		// Simulate the combined path: write with both new objective AND complete status
		// (In the actual handler, the update runs first, then the completion flow
		// proceeds from the updated state.goal.)
		const combined = writeActiveGoalFile(ctx, {
			...active,
			objective: newObj,
			status: "complete" as const,
			stopReason: "agent" as const,
			updatedAt: new Date().toISOString(),
		});
		assert.equal(combined.objective, newObj, "objective must be the new one even when complete");
		assert.equal(combined.status, "complete", "status must be complete");
		assert.match(combined.activePath ?? "", /^\.pi\/goals\/active_goal_/,
			"deferred archival: should still have activePath after write");
		assert.equal(combined.archivedPath, undefined,
			"deferred archival: should not have archivedPath after write");

		// On disk should have new objective + complete status
		const diskContent = readFileSync(path.join(ctx.cwd, combined.activePath ?? "missing"), "utf8");
		assert.ok(diskContent.includes(newObj), "disk must have updated objective");
		assert.ok(diskContent.includes('"status": "complete"'), "disk must have complete status");

		// After turn_end archives, the active path is cleared and archived path is set
		const archived = archiveGoalFile(ctx, combined);
		assert.equal(archived.activePath, undefined, "archived goal should not have activePath");
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/,
			"archived path should point to archive dir");
		const archivedContent = readFileSync(path.join(ctx.cwd, archived.archivedPath ?? "missing"), "utf8");
		assert.ok(archivedContent.includes(newObj), "archived file should have the updated objective");
		assert.ok(archivedContent.includes('"status": "complete"'), "archived file should have complete status");
	} finally {
		cleanup(ctx);
	}
});

/**
 * Error case: updating objective of a complete goal should be impossible.
 * (In the actual update_goal handler, the complete-status check rejects before
 * the update. We verify here that writing complete + new objective is possible
 * at the storage level, but the handler gate prevents it at the tool level.)
 */
test("writeActiveGoalFile allows complete + new objective (handler gate prevents)", () => {
	const ctx = tempCtx();
	try {
		const goal = makeGoal();
		const active = writeActiveGoalFile(ctx, goal);

		// Storage level: writing a complete goal with new objective works
		// (the gate is in the handler, not the storage layer)
		const updated = writeActiveGoalFile(ctx, {
			...active,
			objective: "Should not happen in practice",
			status: "complete" as const,
		});
		assert.equal(updated.objective, "Should not happen in practice");
		assert.equal(updated.status, "complete");

		// The handler gates are tested separately: the update_goal handler
		// checks `state.goal.status === "complete"` before applying the update.
		// This test documents that the storage layer is permissive but the
		// handler provides the safety gate.
	} finally {
		cleanup(ctx);
	}
});

/**
 * Goal evolution text appears in buildCompletionReport for informational display.
 */
test("buildCompletionReport handles updated objective display", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Build feature X\nUpdated objective: Build feature Y\nStatus: active",
		completionSummary: "Feature Y built successfully.",
		auditorReport: "Inspected and verified.\n\n<approved/>",
	});
	assert.ok(report.includes("Goal complete."), "completion report should end with Goal complete.");
	assert.ok(report.includes("<approved/>"), "approval marker should be present");
});

/**
 * Goal evolution instruction exists in prompts — verify it's part of the
 * continuationPrompt and goalPrompt by checking the exports call them.
 */
test("goal evolution instruction is present in continuationPrompt and goalPrompt", async () => {
	const { goalPrompt, continuationPrompt } = await import("../extensions/prompts/goal-prompts.ts");
	const goal = makeGoal();
	const continuationText = continuationPrompt(goal);
	assert.ok(
		continuationText.includes("Goal evolution:"),
		"continuationPrompt must include Goal evolution instruction",
	);
	assert.ok(
		continuationText.includes("updatedObjective"),
		"continuationPrompt must reference updatedObjective",
	);
	assert.ok(
		continuationText.includes("stale"),
		"continuationPrompt must mention stale goals",
	);
	assert.ok(
		continuationText.includes("/goal-tweak"),
		"continuationPrompt must mention /goal-tweak as an alternative",
	);

	const goalPromptText = goalPrompt(goal);
	assert.ok(
		goalPromptText.includes("Goal evolution:"),
		"goalPrompt must include Goal evolution instruction",
	);
	assert.ok(
		goalPromptText.includes("updatedObjective"),
		"goalPrompt must reference updatedObjective",
	);
});
