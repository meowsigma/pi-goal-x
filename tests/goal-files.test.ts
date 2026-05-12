import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createGoal } from "../extensions/goal-record.ts";
import {
	activePathForGoal,
	archiveGoalFile,
	archivedPathForGoal,
	parseGoalFile,
	serializeGoalFile,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";

function tempCtx(): { cwd: string } {
	return { cwd: mkdtempSync(path.join(tmpdir(), "pi-goal-files-")) };
}

function cleanup(ctx: { cwd: string }): void {
	rmSync(ctx.cwd, { recursive: true, force: true });
}

test("serializeGoalFile and parseGoalFile round-trip metadata while allowing prompt body edits", () => {
	const ctx = tempCtx();
	try {
		const goal = createGoal({
			objective: "=== Goal ===\nObjective: original",
			autoContinue: true,
			tokenBudget: null,
			sisyphus: false,
		}, Date.UTC(2026, 0, 2, 3, 4, 5));
		const filePath = path.join(ctx.cwd, "goal.md");
		const edited = serializeGoalFile(goal).replace(
			"=== Goal ===\nObjective: original\n\n## Progress",
			"=== Goal ===\nObjective: edited on disk\n\n## Progress",
		);
		writeFileSync(filePath, edited, "utf8");

		const parsed = parseGoalFile(filePath);
		assert.ok(parsed);
		assert.equal(parsed.id, goal.id);
		assert.equal(parsed.objective, "=== Goal ===\nObjective: edited on disk");
		assert.equal(parsed.status, "active");
	} finally {
		cleanup(ctx);
	}
});

test("goal file paths stay under active and archive roots even with unsafe metadata", () => {
	const ctx = tempCtx();
	try {
		const goal = createGoal({
			objective: "Persist safely",
			autoContinue: true,
			tokenBudget: null,
			sisyphus: true,
		}, Date.UTC(2026, 0, 2, 3, 4, 5));
		const unsafe = { ...goal, activePath: "../escape.md", archivedPath: ".pi/goals/not-archive.md" };

		assert.match(activePathForGoal(ctx, unsafe), /^\.pi\/goals\/active_goal_/);
		assert.match(archivedPathForGoal(ctx, unsafe), /^\.pi\/goals\/archived\/goal_/);

		const active = writeActiveGoalFile(ctx, unsafe);
		assert.match(active.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		const activeFile = path.join(ctx.cwd, active.activePath ?? "missing");
		assert.match(readFileSync(activeFile, "utf8"), /# Goal Prompt/);
		assert.equal(pathExists(path.join(ctx.cwd, "..", "escape.md")), false);

		const archived = archiveGoalFile(ctx, active);
		assert.equal(archived.activePath, undefined);
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);
	} finally {
		cleanup(ctx);
	}
});

function pathExists(filePath: string): boolean {
	try {
		readFileSync(filePath);
		return true;
	} catch {
		return false;
	}
}
