import assert from "node:assert/strict";
import test from "node:test";

import { showEscapeDialog } from "../extensions/widgets/goal-escape-dialog.ts";

test("showEscapeDialog returns continue_working in headless context", async () => {
	const ctx = { hasUI: false } as any;
	const result = await showEscapeDialog(ctx, "Test objective");
	assert.equal(result, "continue_working");
});

test("showEscapeDialog returns continue_working for empty objective", async () => {
	const ctx = { hasUI: false } as any;
	const result = await showEscapeDialog(ctx, "");
	assert.equal(result, "continue_working");
});

test("showEscapeDialog returns continue_working for long objective", async () => {
	const ctx = { hasUI: false } as any;
	const longObjective = "A".repeat(500);
	const result = await showEscapeDialog(ctx, longObjective);
	assert.equal(result, "continue_working");
});
