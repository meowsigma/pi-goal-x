import assert from "node:assert/strict";
import test from "node:test";

import { createMockExtensionContext, createMockTheme, createMockTUI } from "./tui-test-utils.ts";
import { buildDraftConfirmationText } from "../extensions/goal-draft.ts";
import type { GoalTask } from "../extensions/goal-record.ts";
import { renderConfirmationTasks } from "../extensions/goal-task-confirmation.ts";
import {
	computeDialogLineLimit,
	findProposalPresentationSegments,
	fitDialogLines,
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

// Proposal confirmation repro: the goal confirmation dialog (showProposalDialog)
// renders the full draft — objective box + "Tasks proposed for confirmation:" +
// task lines + auditor line — as question context. The draft text is built with
// the real production helpers (buildDraftConfirmationText + renderConfirmationTasks)
// exactly as proposalText() does for a new draft.
const PROPOSAL_TOPIC = "Goal draft is not presenting tasks";
const PROPOSAL_OBJECTIVE = [
	"=== Goal ===",
	"Objective: Fix the pi-goal-x bug where the goal draft is not presenting tasks.",
	"Success criteria: the tasks section is visible in the confirmation dialog.",
	"Boundaries: in scope: extensions; out of scope: pi-tui API changes.",
	"Constraints: the dialog frame must never exceed the terminal height.",
	"Verification contract: npm run check (0 errors); npm test (0 failures).",
	"If blocked: stop and ask the user.",
].join("\n");
// Two tasks: at rows=24/baseFrame=19 the churn guard allows exactly 10 dialog
// lines — head (2) + tasks header + every task line + options + footer + border
// must all stay in-frame; a longer list still relies on scrollback completeness.
const PROPOSAL_TASKS: GoalTask[] = [
	{ id: "task-1", title: "Add the failing render-level regression test", status: "pending" },
	{ id: "task-2", title: "Add the failing flow-level regression test", status: "pending" },
];
const PROPOSAL_CONFIRM_OPTIONS = [
	"Confirm — create this goal now",
	"Continue chatting — keep refining",
	"Cancel — discard this draft",
];

function buildProposalConfirmationContext(tasks: readonly GoalTask[], auditorEnabled: boolean): string {
	const base = buildDraftConfirmationText({ focus: "goal", originalTopic: PROPOSAL_TOPIC, objective: PROPOSAL_OBJECTIVE, autoContinue: true });
	const tasksText = "\n\nTasks proposed for confirmation:\n" + renderConfirmationTasks(tasks, 0).join("\n");
	const auditorLine = auditorEnabled
		? "\n\nAuditor for this goal: enabled (independent approval required before completion)."
		: "\n\nAuditor for this goal: disabled (completion skips the audit).";
	return base + tasksText + auditorLine;
}

/**
 * Open the goal confirmation dialog (showProposalDialog shape: single confirm
 * question with the full draft as context) and return the rendered lines.
 */
function renderProposalDialog(args: { rows: number; baseFrameLines: number }, width = 100): string[] {
	const ctx = createMockExtensionContext();
	void runGoalQuestionnaire(ctx, [{
		id: "confirm",
		question: "Confirm Goal Draft",
		context: buildProposalConfirmationContext(PROPOSAL_TASKS, true),
		options: PROPOSAL_CONFIRM_OPTIONS,
		recommended: 0,
		allowCustom: false,
	}], { defaultEnabled: true });
	const record = ctx._customCalls[0];
	assert.ok(record, "goal confirmation opens a custom dialog");
	const { tui } = createMockTUI();
	const augmented = Object.assign(tui, {
		terminal: { rows: args.rows },
		previousLines: Array.from({ length: args.baseFrameLines }, () => "x"),
	});
	const theme = createMockTheme();
	const component = record.factory(augmented, theme, {}, () => {});
	return (component as { render(w: number): string[] }).render(width);
}

test("regression: the goal confirmation dialog presents the tasks (rows=24, baseFrame=19)", () => {
	// Reported repro: the goal draft was not presenting tasks. The proposal
	// confirmation dialog renders the full draft (objective box + "Tasks
	// proposed for confirmation:" + task lines) as context; the churn guard
	// bounds the dialog to 10 lines and the tail-keep slice dropped the entire
	// tasks section — the user was asked to confirm without ever seeing the plan.
	const lines = renderProposalDialog({ rows: 24, baseFrameLines: 19 });
	assert.ok(lines.length <= 10, "dialog stays within the terminal-height bound");
	assert.match(lines[0], /^─+$/, "top border must be visible");
	assert.ok(lines.some((l) => l.includes("Confirm Goal Draft")), "question must be visible");
	assert.ok(lines.some((l) => l.includes("Tasks proposed for confirmation:")), "tasks header must be visible");
	for (const task of PROPOSAL_TASKS) {
		assert.ok(
			lines.some((l) => l.includes(`[ ] ${task.id}: ${task.title}`)),
			`task line must be visible: ${task.id}`,
		);
	}
	assert.ok(lines.some((l) => l.includes("Confirm — create this goal now")), "confirm option must be visible");
	assert.ok(lines.some((l) => l.includes("Enter select")), "footer hint must be visible");
	assert.match(lines[lines.length - 1], /^─+$/, "bottom border must be visible");
});

test("fitDialogLines keeps the protected head and never exceeds the bound", () => {
	const lines = ["─", "Q", "", "ctx1", "ctx2", "", "1. A", "2. B", "", "footer", "─"];
	// Under the limit: unchanged.
	assert.deepEqual(fitDialogLines(lines, 20, 3), lines);
	// Tiny bound: the head alone fits (question stays visible).
	assert.deepEqual(fitDialogLines(["─", "Q", "", "1. A", "footer", "─"], 2, 2), ["─", "Q"]);
});

test("fitDialogLines tail-keeps context-heavy dialogs so options/footer/border stay", () => {
	const lines = ["─", "Confirm", "", "ctx1", "ctx2", "", "1. A", "2. B", "", "footer", "─"];
	// Context dialog (options at the end): head + tail, middle context sliced —
	// the actionable options, footer, and bottom border remain visible.
	assert.deepEqual(fitDialogLines(lines, 6, 3), ["─", "Confirm", "", "", "footer", "─"]);
	assert.deepEqual(fitDialogLines(lines, 8, 3), ["─", "Confirm", "", "1. A", "2. B", "", "footer", "─"]);
});

test("fitDialogLines keeps the top options for plain select-mode questions", () => {
	const lines = ["─", "Q", "", "1. first", "2. second", "3. third", "", "footer", "─"];
	// Select question (options right after the head): top options + footer +
	// bottom border stay; the recommended first option is never hidden.
	assert.deepEqual(fitDialogLines(lines, 6, 3, true), ["─", "Q", "", "1. first", "footer", "─"]);
	assert.deepEqual(fitDialogLines(lines, 8, 3, true), ["─", "Q", "", "1. first", "2. second", "3. third", "footer", "─"]);
});

test("fitDialogLines never exceeds the bound even at degenerate budgets", () => {
	const lines = ["─", "Q", "", "1. first", "2. second", "3. third", "", "footer", "─"];
	// 8-row terminal: maxDialogLines=4 → head + footer + border only, no overflow.
	assert.deepEqual(fitDialogLines(lines, 4, 2, true), ["─", "Q", "footer", "─"]);
	assert.equal(fitDialogLines(lines, 4, 2, true).length, 4);
	// Budget 3: one option line fits before the footer/border.
	assert.deepEqual(fitDialogLines(lines, 5, 2, true), ["─", "Q", "1. first", "footer", "─"]);
	assert.equal(fitDialogLines(lines, 5, 2, true).length, 5);
	// Budget 1: only the bottom border fits after the head.
	assert.equal(fitDialogLines(lines, 3, 2, true).length, 3);
	// Head-only when the head itself fills the bound.
	assert.deepEqual(fitDialogLines(lines, 2, 2, true), ["─", "Q"]);
	// Same guarantee for the tail-keep path.
	assert.ok(fitDialogLines(["─", "Q", "", "ctx", "", "1. A", "", "footer", "─"], 4, 2, false).length <= 4);
});

// Proposal-confirmation synthetic render (goal confirmation dialog shape):
// head (border + question), objective-box context, tasks section, auditor
// line, then the options/footer/border tail.
const PROPOSAL_UNIT_LINES = [
	"─",
	" Confirm Goal Draft",
	"● Goal draft ready for confirmation.",
	" Objective: Fix the goal draft.",
	" Success criteria: tasks visible.",
	"",
	"Tasks proposed for confirmation:",
	"[ ] task-1: Add the failing render-level regression test",
	"[ ] task-2: Add the failing flow-level regression test",
	"[ ] task-3: Add the fitDialogLines unit tests",
	"",
	" Auditor for this goal: enabled.",
	"",
	" 1. Confirm — create this goal now",
	" 2. Continue chatting — keep refining",
	" 3. Cancel — discard this draft",
	"",
	" ↑↓ navigate • Enter select • Esc cancel",
	"─",
];
const PROPOSAL_UNIT_SEGMENTS = { tasksStart: 6, tasksEnd: 9, tailStart: 13 };

test("fitDialogLines proposal mode: content that fits renders byte-identical", () => {
	assert.deepEqual(fitDialogLines(PROPOSAL_UNIT_LINES, 30, 2, false, PROPOSAL_UNIT_SEGMENTS), PROPOSAL_UNIT_LINES);
});

test("fitDialogLines proposal mode: head + tasks + options/footer/border kept within budget", () => {
	// Budget 12: head (2) + tasks header + all 3 task lines + the whole tail.
	// The objective-box middle and the auditor line are sacrificed in-frame.
	assert.deepEqual(
		fitDialogLines(PROPOSAL_UNIT_LINES, 12, 2, false, PROPOSAL_UNIT_SEGMENTS),
		[
			"─",
			" Confirm Goal Draft",
			"Tasks proposed for confirmation:",
			"[ ] task-1: Add the failing render-level regression test",
			"[ ] task-2: Add the failing flow-level regression test",
			"[ ] task-3: Add the fitDialogLines unit tests",
			" 1. Confirm — create this goal now",
			" 2. Continue chatting — keep refining",
			" 3. Cancel — discard this draft",
			"",
			" ↑↓ navigate • Enter select • Esc cancel",
			"─",
		],
	);
});

test("fitDialogLines proposal mode: strips blank spacing, then drops task lines from the end", () => {
	// Budget 10: head + tasks header + first 2 task lines + options/footer/
	// border (the blank between options and footer is stripped; task-3 drops
	// only after that, and stays readable in the scrollback presentation).
	const fitted = fitDialogLines(PROPOSAL_UNIT_LINES, 10, 2, false, PROPOSAL_UNIT_SEGMENTS);
	assert.deepEqual(fitted, [
		"─",
		" Confirm Goal Draft",
		"Tasks proposed for confirmation:",
		"[ ] task-1: Add the failing render-level regression test",
		"[ ] task-2: Add the failing flow-level regression test",
		" 1. Confirm — create this goal now",
		" 2. Continue chatting — keep refining",
		" 3. Cancel — discard this draft",
		" ↑↓ navigate • Enter select • Esc cancel",
		"─",
	]);
	assert.ok(!fitted.join("\n").includes("task-3"), "task-3 drops only after blank spacing is exhausted");
});

test("fitDialogLines proposal mode: never exceeds the bound even at degenerate budgets", () => {
	// Budget 6: head + tail kept from its end (border/footer first).
	const tight = fitDialogLines(PROPOSAL_UNIT_LINES, 6, 2, false, PROPOSAL_UNIT_SEGMENTS);
	assert.ok(tight.length <= 6);
	assert.match(tight[tight.length - 1], /^─+$/, "bottom border must be visible");
	assert.ok(tight.some((l) => l.includes("Enter select")), "footer hint must be visible");
	// Budget 3: head + bottom border only, still within the bound.
	const tiny = fitDialogLines(PROPOSAL_UNIT_LINES, 3, 2, false, PROPOSAL_UNIT_SEGMENTS);
	assert.equal(tiny.length, 3);
	assert.match(tiny[tiny.length - 1], /^─+$/, "bottom border must be visible");
	// Budget 1: the head itself fills the bound.
	assert.equal(fitDialogLines(PROPOSAL_UNIT_LINES, 1, 2, false, PROPOSAL_UNIT_SEGMENTS).length, 1);
});

test("findProposalPresentationSegments locates the tasks section and options tail", () => {
	assert.deepEqual(findProposalPresentationSegments(PROPOSAL_UNIT_LINES, 13), PROPOSAL_UNIT_SEGMENTS);
	// A plain agent question (no tasks marker) is not a proposal confirmation.
	assert.equal(findProposalPresentationSegments(["─", "Q", "", "1. A", "footer", "─"], 3), null);
	// Degenerate tail index is rejected.
	assert.equal(findProposalPresentationSegments(PROPOSAL_UNIT_LINES, -1), null);
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
