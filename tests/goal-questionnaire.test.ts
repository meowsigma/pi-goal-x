import assert from "node:assert/strict";
import test from "node:test";

import { createMockExtensionContext, createMockTheme, createMockTUI } from "./tui-test-utils.ts";
import {
	computeDialogLineLimit,
	formatQuestionnaireAnswers,
	isHeadlessQuestionSufficientForDraft,
	normalizeQuestionnaireQuestions,
	proposalDialogFailureMessage,
	proposalDecisionFromQuestionnaireResult,
	runGoalQuestionnaire,
	shouldAutoConfirmProposal,
	type GoalQuestionnaireResult,
} from "../extensions/goal-questionnaire.ts";

test("normalizeQuestionnaireQuestions trims ids, de-duplicates, filters options, and validates recommended", () => {
	assert.deepEqual(
		normalizeQuestionnaireQuestions([
			{ id: " scope ", question: "Scope?", options: [" A ", "", "B"], recommended: 1 },
			{ id: "scope", question: "Again?", options: ["X"], recommended: 2, allowCustom: false },
			{ id: "  ", question: "Empty id?", options: [], recommended: 0 },
		]),
		[
			{ id: "scope", question: "Scope?", options: [" A ", "B"], recommended: 1, allowCustom: true },
			{ id: "scope-2", question: "Again?", options: ["X"], recommended: undefined, allowCustom: false },
			{ id: "q3", question: "Empty id?", options: [], recommended: undefined, allowCustom: true },
		],
	);
});

test("dialog line limit supports pi 0.83 frames and pi 0.84 docked/fullscreen frames", () => {
	assert.equal(computeDialogLineLimit({ terminalRows: 46, baseFrameLines: 38 }), 10);
	assert.equal(computeDialogLineLimit({ terminalRows: 46, baseFrameLines: 20 }), 27);
	assert.equal(computeDialogLineLimit({ terminalRows: 46 }), 42);
	assert.equal(computeDialogLineLimit({ terminalRows: 8 }), 4);
	assert.equal(computeDialogLineLimit({ terminalRows: 8, baseFrameLines: 20 }), 8);
	assert.equal(computeDialogLineLimit({ terminalRows: 3 }), 3);
	assert.equal(computeDialogLineLimit({}), undefined);
});

test("formatQuestionnaireAnswers emits stable Q/A records with context and options", () => {
	const result: GoalQuestionnaireResult = {
		cancelled: false,
		questions: [
			{ id: "scope", question: "Scope?", context: "Pick one", options: ["A", "B"], allowCustom: true },
			{ id: "notes", question: "Notes?", options: [], allowCustom: true },
		],
		answers: [
			{ id: "scope", question: "Scope?", answer: "A", wasCustom: false },
			{ id: "notes", question: "Notes?", answer: "Custom", wasCustom: true },
		],
	};

	assert.equal(
		formatQuestionnaireAnswers(result),
		"**Q:** Scope?\nPick one\nOptions: A / B\n**A:** A\n\n---\n\n**Q:** Notes?\n**A:** Custom",
	);
});

test("headless question sufficiency blocks vague-topic default fabrication", () => {
	assert.equal(isHeadlessQuestionSufficientForDraft({
		topic: "整理笔记",
		questionText: "你的笔记目前存放在哪里，是什么格式？输出为什么形式？",
	}), false);
	assert.equal(isHeadlessQuestionSufficientForDraft({
		topic: "在 sandbox 当前目录创建 hello.txt，内容为 Hello, Goal!，不要修改其他文件。",
		questionText: "如果 hello.txt 已存在，应该覆盖还是停止？",
	}), true);
});

// Realistic repro content from the reported bug: the agent asked "via uv too?"
// while the goal panel + chat frame (19 lines) left only 10 dialog rows on a
// 24-row terminal; the option labels wrap over multiple lines.
const REPRO_QUESTION_TEXT = "via uv too?";
const REPRO_OPTION_LABELS = [
	"Dev toolchain only (recommended): pyproject.toml with [tool.uv] package=false, [dependency-groups] dev (pytest, pytest-benchmark), pytest config moved in; committed uv.lock; `uv sync` + `uv run pytest benchmarks/`; requirements-dev.txt and pytest.ini removed; runtime/zipapp/battery stay stdlib-only and uv-free",
	"Also pin a dev Python via uv (.python-version, e.g. 3.12) while the runtime floor stays >=3.9",
	"Also manage the built artifact with uv (uv tool install of the zipapp) — note: the zipapp is self-contained, uv adds nothing there",
	"Write your own answer...",
];

/**
 * Open a single-question goal_question dialog against a TUI that exposes
 * terminal.rows and previousLines (pi's regular-renderer frame cache), so the
 * terminal-height churn guard actually engages, and return the rendered lines.
 */
function renderGoalQuestionDialog(args: { rows: number; baseFrameLines: number }, width = 100): string[] {
	const ctx = createMockExtensionContext();
	void runGoalQuestionnaire(ctx, [{
		id: "question",
		question: REPRO_QUESTION_TEXT,
		options: REPRO_OPTION_LABELS,
		recommended: 0,
	}]);
	const record = ctx._customCalls[0];
	assert.ok(record, "goal_question opens a custom dialog");
	const { tui } = createMockTUI();
	const augmented = Object.assign(tui, {
		terminal: { rows: args.rows },
		previousLines: Array.from({ length: args.baseFrameLines }, () => "x"),
	});
	const theme = createMockTheme();
	const component = record.factory(augmented, theme, {}, () => {});
	return (component as { render(w: number): string[] }).render(width);
}

test("regression: agent question stays readable when the goal panel leaves little room (rows=24, baseFrame=19)", () => {
	// Reported repro: a goal_question dialog opened while the pi-goal-x goal
	// panel + chat frame consumed 19 rows of a 24-row terminal. The churn guard
	// bounds the dialog to 10 lines and tail-slices it — which dropped the top
	// border AND the question text, leaving only option fragments + footer.
	const lines = renderGoalQuestionDialog({ rows: 24, baseFrameLines: 19 });
	assert.ok(lines.length <= 10, "dialog stays within the terminal-height bound");
	assert.match(lines[0], /^─+$/, "top border must be visible");
	assert.ok(lines.some((l) => l.includes(REPRO_QUESTION_TEXT)), "question text must be visible");
	assert.ok(lines.some((l) => l.includes("Dev toolchain only")), "recommended first option must be visible");
	assert.match(lines[lines.length - 1], /^─+$/, "bottom border must be visible");
});

test("proposal confirmation helpers keep headless and cancel semantics stable", () => {
	assert.equal(shouldAutoConfirmProposal({ hasUI: false }), true);
	assert.equal(shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "1" }), true);
	assert.equal(shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "0" }), false);
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: true, answer: "Confirm — create this goal now" }), "continue");
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Confirm — create this goal now" }), "confirm");
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Continue chatting — keep refining" }), "continue");
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Cancel — discard this draft" }), "cancel");
	assert.match(proposalDialogFailureMessage(new Error("boom")), /NOT created/);
	assert.match(proposalDialogFailureMessage(new Error("boom")), /drafting remains active/);
});
