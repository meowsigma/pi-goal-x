import assert from "node:assert/strict";
import test from "node:test";

import {
	countTrailingNoProgressRuns,
	isGoalProgressToolName,
	isStandaloneClockProbe,
	ALL_REGISTERED_GOAL_TOOLS,
	CORE_GOAL_TOOL_NAMES,
	CORE_GOAL_TOOLS,
	CREATE_GOAL_TOOL_NAME,
	DRAFTING_GOAL_TOOLS,
	FIVE_GOAL_TOOLS,
	GET_GOAL_TOOL_NAME,
	GOAL_PROGRESS_TOOL_NAMES,
	GOAL_WORK_TOOL_NAMES,
	POST_STOP_ALLOWED_TOOLS,
	PROPOSE_DRAFT_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	QUESTION_TOOL_NAME,
	SET_GOAL_TASKS_TOOL_NAME,
	TASK_TOOL_NAMES,
	UPDATE_GOAL_TASK_TOOL_NAME,
	UPDATE_GOAL_TOOL_NAME,
} from "../extensions/goal-tool-names.ts";

const CORE = ["create_goal", "get_goal", "update_goal"];

// Drafting tools belong to the separate transient user-started draft profile,
// never to the steady three/five execution surface.
const DRAFTING = ["goal_question", "goal_questionnaire", "propose_goal_draft"];

// Removed steady-state lifecycle tools — none may exist in the module.
const REMOVED_STEADY = [
	"propose_goal_tweak", "step_complete", "abort_goal", "propose_task_list",
	"complete_task", "skip_task", "complete_goal", "pause_goal",
];

test("the five public tool names are preserved", () => {
	assert.equal(CREATE_GOAL_TOOL_NAME, "create_goal");
	assert.equal(GET_GOAL_TOOL_NAME, "get_goal");
	assert.equal(UPDATE_GOAL_TOOL_NAME, "update_goal");
	assert.equal(SET_GOAL_TASKS_TOOL_NAME, "set_goal_tasks");
	assert.equal(UPDATE_GOAL_TASK_TOOL_NAME, "update_goal_task");
});

test("fixed profiles: core three, task two, all five registered", () => {
	assert.deepEqual(CORE_GOAL_TOOL_NAMES, CORE);
	assert.deepEqual(TASK_TOOL_NAMES, ["set_goal_tasks", "update_goal_task"]);
	assert.deepEqual(FIVE_GOAL_TOOLS, [...CORE, ...TASK_TOOL_NAMES]);
	assert.deepEqual(CORE_GOAL_TOOLS, CORE);
	assert.deepEqual(DRAFTING_GOAL_TOOLS, DRAFTING);
	// The registry is the fixed five plus the transient drafting profile; the
	// INSTALLED profile (installGoalToolProfile) still only ever installs the
	// three/five execution set.
	assert.deepEqual(ALL_REGISTERED_GOAL_TOOLS, [...FIVE_GOAL_TOOLS, ...DRAFTING_GOAL_TOOLS]);
});

test("the module declares drafting names only in the transient profile", () => {
	assert.equal(QUESTION_TOOL_NAME, "goal_question");
	assert.equal(QUESTIONNAIRE_TOOL_NAME, "goal_questionnaire");
	assert.equal(PROPOSE_DRAFT_TOOL_NAME, "propose_goal_draft");
	// Drafting tools must never leak into the fixed execution profiles.
	for (const name of DRAFTING) {
		assert.equal(CORE_GOAL_TOOL_NAMES.includes(name as never), false, `${name} must not be a core tool`);
		assert.equal(TASK_TOOL_NAMES.includes(name as never), false, `${name} must not be a task tool`);
		assert.equal(GOAL_WORK_TOOL_NAMES.includes(name as never), false, `${name} must not be a work tool`);
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(name as never), false, `${name} must not be a progress tool`);
	}
});

test("no steady-state lifecycle tools or phase heuristics remain", async () => {
	const fs = await import("node:fs/promises");
	const source = await fs.readFile("extensions/goal-tool-names.ts", "utf8");
	for (const removed of REMOVED_STEADY) {
		assert.ok(!source.includes(`const ${removed.toUpperCase().replace(/-/g, "_")}_TOOL_NAME`),
			`removed constant ${removed} must not exist in goal-tool-names.ts`);
	}
	assert.ok(!source.includes("GoalToolPhase"), "GoalToolPhase must be gone");
	assert.ok(!source.includes("lifecycleToolNamesForGoalStatus"), "lifecycleToolNamesForGoalStatus must be gone");
	assert.ok(!source.includes("isQuestionLikeToolName"), "question heuristics must be gone");
});

test("standalone date clock probes accept safe variants but not commands or mutations", () => {
	for (const command of [
		"date",
		"date -u",
		"date --utc",
		"date +%s",
		"  date   --utc   '+%Y-%m-%d %H:%M:%S UTC'  ",
		"'date' \"-u\" \"+%s\"",
	]) {
		assert.equal(isStandaloneClockProbe("bash", { command }), true, command);
	}
	for (const command of [
		"date && git status",
		"date -u '+%s' | cat",
		"date -s '2026-09-07 00:00:00'",
		"date --set='2026-09-07 00:00:00'",
		"timedatectl",
	]) {
		assert.equal(isStandaloneClockProbe("bash", { command }), false, command);
	}
	assert.equal(isStandaloneClockProbe("unknown", { command: "date" }), false);
});

test("progress tool set excludes read-only surface tools and workhorse includes them", () => {
	for (const name of ["get_goal", "create_goal"]) {
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(name as typeof GOAL_PROGRESS_TOOL_NAMES[number]), false, name);
	}
	for (const name of [UPDATE_GOAL_TOOL_NAME, SET_GOAL_TASKS_TOOL_NAME, UPDATE_GOAL_TASK_TOOL_NAME, "write", "edit", "bash", "read", "bg_logs"]) {
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(name as typeof GOAL_PROGRESS_TOOL_NAMES[number]), true, name);
	}
	assert.equal(isGoalProgressToolName("computer_use_linux_screenshot"), true);
	assert.equal(isGoalProgressToolName("computer_use_linux_press_key"), true);
	assert.equal(isGoalProgressToolName("reach_search"), true);
	assert.equal(isGoalProgressToolName("get_goal"), false);
	assert.equal(isGoalProgressToolName("bg_status"), false);
	assert.equal(isGoalProgressToolName("bash", { command: "date -u '+%Y-%m-%d %H:%M:%S UTC'" }), false);
	assert.equal(isGoalProgressToolName("bash", { command: "date -u '+%Y-%m-%d %H:%M:%S UTC' && git status" }), true);
	assert.equal(isGoalProgressToolName("subagent", { action: "status" }), false);
	assert.equal(isGoalProgressToolName("subagent", { action: "list" }), false);
});

test("work tool set covers the five goal tools plus common host work tools", () => {
	for (const name of FIVE_GOAL_TOOLS) {
		assert.ok(GOAL_WORK_TOOL_NAMES.includes(name as typeof GOAL_WORK_TOOL_NAMES[number]), `work set must include ${name}`);
	}
	for (const name of ["bash", "write", "read", "edit", "grep", "find", "ls", "bg_logs"]) {
		assert.ok(GOAL_WORK_TOOL_NAMES.includes(name as typeof GOAL_WORK_TOOL_NAMES[number]), `work set must include ${name}`);
	}
	for (const removed of REMOVED_STEADY) {
		assert.equal(GOAL_WORK_TOOL_NAMES.includes(removed as typeof GOAL_WORK_TOOL_NAMES[number]), false,
			`work set must not include ${removed}`);
	}
	for (const name of DRAFTING) {
		assert.equal(GOAL_WORK_TOOL_NAMES.includes(name as typeof GOAL_WORK_TOOL_NAMES[number]), false,
			`steady work set must not include drafting tool ${name}`);
	}
});

test("POST_STOP_ALLOWED_TOOLS only includes get_goal", () => {
	assert.equal(POST_STOP_ALLOWED_TOOLS.length, 1, "post-stop allowlist should be minimal");
	assert.equal(POST_STOP_ALLOWED_TOOLS[0], "get_goal");
});

test("trailing no-progress runs ignore earlier work and count empty end_turns", () => {
	const entries = [
		{ message: { role: "assistant", stopReason: "toolUse" } },
		{ message: { role: "toolResult", toolName: "reach_search" } },
		{ message: { role: "assistant", stopReason: "end_turn" } },
		{ message: { role: "assistant", stopReason: "end_turn" } },
		{ message: { role: "toolResult", toolName: "get_goal" } },
		{ message: { role: "assistant", stopReason: "end_turn" } },
		{ message: { role: "assistant", stopReason: "end_turn" } },
	];
	assert.equal(countTrailingNoProgressRuns(entries), 3);
});

test("goal-scoped trailing counts ignore empty turns from a prior focused goal", () => {
	const entries = [
		{ type: "custom", customType: "pi-goal-focus", data: { version: 1, focusedGoalId: "old-goal", reason: "created" } },
		{ message: { role: "assistant", stopReason: "end_turn" } },
		{ message: { role: "assistant", stopReason: "end_turn" } },
		{ message: { role: "assistant", stopReason: "end_turn" } },
		{ type: "custom", customType: "pi-goal-focus", data: { version: 1, focusedGoalId: "new-goal", reason: "created" } },
		{ message: { role: "assistant", stopReason: "end_turn" } },
	];

	assert.equal(countTrailingNoProgressRuns(entries, "new-goal"), 1);
	assert.equal(countTrailingNoProgressRuns(entries, "old-goal"), 0, "a stale goal cannot claim the current tail");
	assert.equal(countTrailingNoProgressRuns(entries, "missing-goal"), 0, "a goal without a marker starts fresh");
});

test("history pairs bash arguments with results before crediting progress", () => {
	const clockCommand = "date -u '+%Y-%m-%d %H:%M:%S UTC'";
	const entries = [
		{ type: "custom", customType: "pi-goal-focus", data: { version: 1, focusedGoalId: "goal" } },
		{ message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "clock-1", name: "bash", arguments: { command: clockCommand } }] } },
		{ message: { role: "toolResult", toolCallId: "clock-1", toolName: "bash", content: [{ type: "text", text: "2026-09-07 00:00:00 UTC" }] } },
		{ message: { role: "assistant", stopReason: "end_turn" } },
		{ message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "clock-2", name: "bash", arguments: { command: clockCommand } }] } },
		{ message: { role: "toolResult", toolCallId: "clock-2", toolName: "bash", content: [{ type: "text", text: "2026-09-07 00:00:01 UTC" }] } },
		{ message: { role: "assistant", stopReason: "end_turn" } },
	];
	assert.equal(countTrailingNoProgressRuns(entries, "goal"), 2);

	const productive = [
		...entries.slice(0, 1),
		{ message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "compound", name: "bash", arguments: { command: `${clockCommand} && git status --short` } }] } },
		{ message: { role: "toolResult", toolCallId: "compound", toolName: "bash", content: [{ type: "text", text: " M file.ts" }] } },
		{ message: { role: "assistant", stopReason: "end_turn" } },
		{ message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "unknown", name: "desktop_research", arguments: { query: "new evidence" } }] } },
		{ message: { role: "toolResult", toolCallId: "unknown", toolName: "desktop_research", content: [{ type: "text", text: "evidence" }] } },
		{ message: { role: "assistant", stopReason: "end_turn" } },
	];
	assert.equal(countTrailingNoProgressRuns(productive, "goal"), 0);

	const missingArguments = [
		{ type: "custom", customType: "pi-goal-focus", data: { version: 1, focusedGoalId: "goal" } },
		{ message: { role: "toolResult", toolCallId: "unpaired", toolName: "bash", content: [{ type: "text", text: "2026-09-07 00:00:02 UTC" }] } },
		{ message: { role: "assistant", stopReason: "end_turn" } },
	];
	assert.equal(countTrailingNoProgressRuns(missingArguments, "goal"), 0, "missing arguments cannot be invented as a clock probe");

	for (const [index, command] of ["date", "date -u", "date --utc", "date +%s", "'date' \"--utc\" \"+%s\""].entries()) {
		const callId = `variant-${index}`;
		assert.equal(countTrailingNoProgressRuns([
			{ type: "custom", customType: "pi-goal-focus", data: { version: 1, focusedGoalId: "goal" } },
			{ message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command } }] } },
			{ message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: `clock-${index}` }] } },
			{ message: { role: "assistant", stopReason: "end_turn" } },
		], "goal"), 1, `history uses the standalone clock classification for ${command}`);
	}
});
