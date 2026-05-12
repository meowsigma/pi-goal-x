import assert from "node:assert/strict";
import test from "node:test";

import {
	ACTIVE_GOAL_TOOL_NAMES,
	CREATE_GOAL_TOOL_NAME,
	POST_STOP_ALLOWED_TOOLS,
	PROPOSE_DRAFT_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	QUESTION_TOOL_NAME,
	SISYPHUS_STEP_TOOL_NAME,
	SISYPHUS_WORK_TOOL_NAMES,
	TWEAK_APPLY_TOOL_NAME,
	isQuestionLikeToolName,
} from "../extensions/goal-tool-names.ts";

test("goal tool names are centralized and preserve published agent-facing names", () => {
	assert.equal(QUESTION_TOOL_NAME, "goal_question");
	assert.equal(QUESTIONNAIRE_TOOL_NAME, "goal_questionnaire");
	assert.equal(PROPOSE_DRAFT_TOOL_NAME, "propose_goal_draft");
	assert.equal(TWEAK_APPLY_TOOL_NAME, "apply_goal_tweak");
	assert.equal(SISYPHUS_STEP_TOOL_NAME, "step_complete");
	assert.equal(CREATE_GOAL_TOOL_NAME, "create_goal");
	assert.deepEqual(ACTIVE_GOAL_TOOL_NAMES, ["get_goal", "update_goal", "pause_goal"]);
	assert.deepEqual(POST_STOP_ALLOWED_TOOLS, ["get_goal"]);
});

test("sisyphus work tool set keeps question tools and workhorse tools visible to continuation gating", () => {
	for (const toolName of [
		SISYPHUS_STEP_TOOL_NAME,
		TWEAK_APPLY_TOOL_NAME,
		CREATE_GOAL_TOOL_NAME,
		PROPOSE_DRAFT_TOOL_NAME,
		QUESTION_TOOL_NAME,
		QUESTIONNAIRE_TOOL_NAME,
		"get_goal",
		"bash",
		"write",
	]) {
		assert.equal(SISYPHUS_WORK_TOOL_NAMES.includes(toolName as typeof SISYPHUS_WORK_TOOL_NAMES[number]), true);
	}
});

test("isQuestionLikeToolName allows dialogue tools but not workhorse tools", () => {
	for (const name of [QUESTION_TOOL_NAME, QUESTIONNAIRE_TOOL_NAME, "question", "questionnaire", "ask_user", "clarify_scope", "confirm_choice"]) {
		assert.equal(isQuestionLikeToolName(name), true, name);
	}
	for (const name of ["bash", "read", "write", "edit", "grep", "find", "ls", "step_complete", "pause_goal"]) {
		assert.equal(isQuestionLikeToolName(name), false, name);
	}
});
