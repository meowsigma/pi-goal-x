import assert from "node:assert/strict";
import test from "node:test";
import { GoalProgressEvidenceTracker } from "../extensions/goal-progress-evidence.ts";

const unchanged = { content: [{ type: "text", text: "6eb3723\nclean\n" }] };

test("unchanged observational results count once, not once per polling run", () => {
	const tracker = new GoalProgressEvidenceTracker();
	tracker.beginAgentRun();
	assert.equal(tracker.observeCall("first", "bash", { command: "git status --short", timeout: 60 }), false);
	assert.equal(tracker.observeResult("first", unchanged, false), true);

	tracker.beginAgentRun();
	assert.equal(tracker.observeCall("second", "bash", { command: "git status --short", timeout: 120 }), false,
		"timeout changes do not make the same command productive");
	assert.equal(tracker.observeResult("second", unchanged, false), false);
});

test("changed observational results count as new evidence", () => {
	const tracker = new GoalProgressEvidenceTracker();
	tracker.observeCall("first", "read", { path: "status.txt" });
	assert.equal(tracker.observeResult("first", { content: [{ type: "text", text: "old" }] }, false), true);
	tracker.beginAgentRun();
	tracker.observeCall("second", "read", { path: "status.txt" });
	assert.equal(tracker.observeResult("second", { content: [{ type: "text", text: "new" }] }, false), true);
});

test("failed observations never count as progress", () => {
	const tracker = new GoalProgressEvidenceTracker();
	tracker.observeCall("failed", "bash", { command: "git status --short" });
	assert.equal(tracker.observeResult("failed", { content: [{ type: "text", text: "provider error" }] }, true), false);
});

test("real mutations reset prior observation evidence", () => {
	for (const [toolName, input] of [
		["edit", { path: "src/app.ts" }],
		["set_goal_tasks", { tasks: [{ id: "ship", title: "Ship" }] }],
	] as const) {
		const tracker = new GoalProgressEvidenceTracker();
		tracker.observeCall(`${toolName}-first`, "bash", { command: "git status --short" });
		assert.equal(tracker.observeResult(`${toolName}-first`, unchanged, false), true);
		assert.equal(tracker.observeCall(`${toolName}-mutation`, toolName, input), true, `${toolName} is productive`);
		tracker.observeCall(`${toolName}-after`, "bash", { command: "git status --short" });
		assert.equal(tracker.observeResult(`${toolName}-after`, unchanged, false), true,
			`verification after ${toolName} starts a fresh evidence epoch`);
	}
});
