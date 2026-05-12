import assert from "node:assert/strict";
import test from "node:test";

import {
	buildAutoContinueCapPause,
	buildCompletionReport,
	buildGoalCreatedReport,
	buildPausedByAgentGoal,
	classifyVerifyCommandResult,
	clearGoalCommandMessage,
	isGoalUnfinished,
	shouldArmPostCompactReminder,
	shouldAutoPauseForContinueCap,
	shouldInjectPostCompactReminder,
	shouldQueueContinuation,
	statusAfterBudgetLimit,
	validateGoalCompletion,
	validateGoalCreationSlot,
	validatePauseGoal,
	validateResumeGoal,
	validateStepCompletion,
	type GoalPolicyRecordLike,
} from "../extensions/goal-policy.ts";

function goal(overrides: Partial<GoalPolicyRecordLike> = {}): GoalPolicyRecordLike {
	return {
		id: "g1",
		objective: "=== Goal ===\nObjective: test",
		status: "active",
		autoContinue: true,
		tokenBudget: null,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		updatedAt: "2026-05-12T00:00:00.000Z",
		...overrides,
	};
}

function sisyphus(overrides: Partial<GoalPolicyRecordLike> = {}): GoalPolicyRecordLike {
	return goal({
		objective: "=== Sisyphus Goal ===\nSteps:\n1. A\n2. B",
		sisyphus: true,
		totalSteps: 2,
		stepsCompleted: 0,
		currentStep: 1,
		...overrides,
	});
}

function rejectedMessage(result: { ok: true } | { ok: false; message: string }): string {
	assert.equal(result.ok, false);
	return result.message;
}

test("goal lifecycle creation and completion gates reject unsafe transitions", () => {
	assert.equal(isGoalUnfinished(null), false);
	assert.equal(isGoalUnfinished(goal({ status: "active" })), true);
	assert.equal(isGoalUnfinished(goal({ status: "complete" })), false);

	assert.deepEqual(validateGoalCreationSlot(null), { ok: true });
	assert.match(rejectedMessage(validateGoalCreationSlot(goal({ status: "paused" }))), /unfinished goal/);

	assert.deepEqual(validateGoalCompletion({ goal: goal({ sisyphus: false }) }), { ok: true });
	const noGoal = validateGoalCompletion({ goal: null });
	assert.equal(noGoal.ok, false);
	if (!noGoal.ok) assert.match(noGoal.message, /No goal is set/);

	const stale = validateGoalCompletion({ goal: goal({ id: "current" }), runningGoalId: "old" });
	assert.equal(stale.ok, false);
	if (!stale.ok) assert.match(stale.message, /changed during this run/);

	const paused = validateGoalCompletion({ goal: goal({ status: "paused", autoContinue: false }) });
	assert.equal(paused.ok, false);
	if (!paused.ok) assert.match(paused.message, /ask the user to resume/);

	const incompleteSis = validateGoalCompletion({ goal: sisyphus({ stepsCompleted: 1 }) });
	assert.equal(incompleteSis.ok, false);
	if (!incompleteSis.ok) assert.match(incompleteSis.message, /Only 1 step\(s\).*1 step\(s\) remain/);

	assert.deepEqual(validateGoalCompletion({ goal: sisyphus({ stepsCompleted: 2 }) }), { ok: true });
});

test("pause, resume, and clear policy preserve human-owned lifecycle affordances", () => {
	assert.match(rejectedMessage(validatePauseGoal({ goal: null, reason: "blocked" })), /no-op/);
	assert.match(rejectedMessage(validatePauseGoal({ goal: goal({ id: "new" }), runningGoalId: "old", reason: "blocked" })), /changed during this run/);
	assert.match(rejectedMessage(validatePauseGoal({ goal: goal({ status: "complete" }), reason: "blocked" })), /does not apply/);
	assert.deepEqual(validatePauseGoal({ goal: goal(), reason: "blocked" }), { ok: true });

	const paused = buildPausedByAgentGoal(goal(), {
		reason: "Need credentials",
		suggestedAction: "Set TOKEN and /goal-resume",
		updatedAt: "2026-05-12T01:00:00.000Z",
	});
	assert.equal(paused.status, "paused");
	assert.equal(paused.autoContinue, false);
	assert.equal(paused.stopReason, "agent");
	assert.equal(paused.pauseReason, "Need credentials");
	assert.equal(paused.pauseSuggestedAction, "Set TOKEN and /goal-resume");

	assert.match(rejectedMessage(validateResumeGoal(null)), /No goal is set/);
	assert.match(rejectedMessage(validateResumeGoal(goal({ status: "complete" }))), /Goal is complete/);
	assert.match(rejectedMessage(validateResumeGoal(goal({ status: "active", autoContinue: true }))), /already running/);
	assert.match(rejectedMessage(validateResumeGoal(goal({ status: "budgetLimited", tokenBudget: 10, usage: { tokensUsed: 10, activeSeconds: 0 } }))), /budget-limited/);
	assert.deepEqual(validateResumeGoal(goal({ status: "paused", autoContinue: false })), { ok: true });

	assert.equal(clearGoalCommandMessage({ archived: true, wasDrafting: false }), "Goal cleared and archived.");
	assert.equal(clearGoalCommandMessage({ archived: false, wasDrafting: true }), "Drafting cancelled.");
	assert.equal(clearGoalCommandMessage({ archived: false, wasDrafting: false }), "No goal is set.");

	assert.equal(
		buildCompletionReport({ detailedSummary: "Goal: full objective\nStatus: complete", completionSummary: "All requested checks passed." }),
		"Goal complete.\n\nCompletion summary:\nAll requested checks passed.\n\nGoal: full objective\nStatus: complete",
	);
	assert.equal(
		buildCompletionReport({ detailedSummary: "Goal: full objective", completionSummary: "   " }),
		"Goal complete.\n\nGoal: full objective",
	);
	assert.equal(
		buildGoalCreatedReport({ objective: "# Objective\nShip the feature.", detailedSummary: "Status: active" }),
		"Goal confirmed and created.\n\nFinalized goal:\n\n# Objective\nShip the feature.\n\nGoal details:\nStatus: active",
	);
});

test("Sisyphus step gate rejects wrong mode, wrong status, duplicates, skips, and finished goals", () => {
	assert.match(rejectedMessage(validateStepCompletion({ goal: null, stepIndex: 1, evidence: "done" })), /no-op/);
	assert.match(rejectedMessage(validateStepCompletion({ goal: goal(), stepIndex: 1, evidence: "done" })), /only applies to Sisyphus/);
	assert.match(rejectedMessage(validateStepCompletion({ goal: sisyphus({ status: "paused", autoContinue: false }), stepIndex: 1, evidence: "done" })), /does not apply/);
	assert.match(rejectedMessage(validateStepCompletion({ goal: sisyphus({ totalSteps: null }), stepIndex: 1, evidence: "done" })), /no parseable numbered step count/);
	assert.match(rejectedMessage(validateStepCompletion({ goal: sisyphus(), stepIndex: 1, evidence: "   " })), /requires a non-empty evidence/);

	const duplicate = validateStepCompletion({ goal: sisyphus({ stepsCompleted: 1, currentStep: 2 }), stepIndex: 1, evidence: "done" });
	assert.equal(duplicate.ok, false);
	if (!duplicate.ok) assert.match(duplicate.message, /already marked complete/);

	const skip = validateStepCompletion({ goal: sisyphus({ stepsCompleted: 0 }), stepIndex: 2, evidence: "done" });
	assert.equal(skip.ok, false);
	if (!skip.ok) assert.match(skip.message, /cannot skip to step 2/);

	const finished = validateStepCompletion({ goal: sisyphus({ stepsCompleted: 2, currentStep: 2 }), stepIndex: 3, evidence: "done" });
	assert.equal(finished.ok, false);
	if (!finished.ok) assert.match(finished.message, /All 2 steps are already marked complete/);

	assert.deepEqual(
		validateStepCompletion({ goal: sisyphus({ stepsCompleted: 1, currentStep: 2 }), stepIndex: 2, evidence: "  verified  " }),
		{ ok: true, evidence: "verified", done: 1, expected: 2, stepIndex: 2 },
	);
});

test("verifyCommand policy rejects failed proof and only accepts exit 0", () => {
	const execError = classifyVerifyCommandResult({ stepIndex: 1, result: null, execError: "ENOENT" });
	assert.equal(execError.ok, false);
	if (!execError.ok) assert.match(execError.message, /could not be executed.*ENOENT/);

	const killed = classifyVerifyCommandResult({ stepIndex: 1, result: { code: 1, killed: true, stdout: "partial", stderr: "" } });
	assert.equal(killed.ok, false);
	if (!killed.ok) assert.match(killed.message, /TIMED OUT.*Partial output/s);

	const nonZero = classifyVerifyCommandResult({ stepIndex: 1, result: { code: 2, killed: false, stdout: "missing", stderr: "bad" } });
	assert.equal(nonZero.ok, false);
	if (!nonZero.ok) assert.match(nonZero.message, /exited with code 2.*Verify output/s);

	assert.deepEqual(
		classifyVerifyCommandResult({ stepIndex: 1, result: { code: 0, killed: false, stdout: "ok", stderr: "" } }),
		{ ok: true, summary: " verifyCommand passed (exit 0)." },
	);
});

test("budget, autoContinue cap, and compaction policies are deterministic", () => {
	assert.equal(statusAfterBudgetLimit(goal({ tokenBudget: 10, usage: { tokensUsed: 9, activeSeconds: 0 } })), "active");
	assert.equal(statusAfterBudgetLimit(goal({ tokenBudget: 10, usage: { tokensUsed: 10, activeSeconds: 0 } })), "budgetLimited");
	assert.equal(statusAfterBudgetLimit(goal({ status: "paused", tokenBudget: 10, usage: { tokensUsed: 20, activeSeconds: 0 } })), "paused");

	assert.equal(shouldQueueContinuation(goal({ status: "active", autoContinue: true })), true);
	assert.equal(shouldQueueContinuation(goal({ status: "paused", autoContinue: true })), false);
	assert.equal(shouldAutoPauseForContinueCap({ goal: goal(), autoContinueTurns: 29, maxTurns: 30 }), false);
	assert.equal(shouldAutoPauseForContinueCap({ goal: goal(), autoContinueTurns: 30, maxTurns: 30 }), true);
	assert.equal(shouldAutoPauseForContinueCap({ goal: goal({ autoContinue: false }), autoContinueTurns: 30, maxTurns: 30 }), false);

	const capped = buildAutoContinueCapPause(goal(), { maxTurns: 3, updatedAt: "2026-05-12T02:00:00.000Z" });
	assert.equal(capped.status, "paused");
	assert.equal(capped.autoContinue, false);
	assert.equal(capped.pauseReason, "Auto-continue cap reached (3 consecutive turns).");
	assert.match(capped.pauseSuggestedAction ?? "", /goal-resume/);

	assert.equal(shouldArmPostCompactReminder(sisyphus({ status: "active" })), true);
	assert.equal(shouldArmPostCompactReminder(sisyphus({ status: "budgetLimited" })), true);
	assert.equal(shouldArmPostCompactReminder(goal({ sisyphus: false })), false);
	assert.equal(shouldArmPostCompactReminder(sisyphus({ status: "paused", autoContinue: false })), false);
	assert.equal(shouldInjectPostCompactReminder({ pending: true, goal: sisyphus() }), true);
	assert.equal(shouldInjectPostCompactReminder({ pending: true, goal: goal({ sisyphus: false }) }), false);
	assert.equal(shouldInjectPostCompactReminder({ pending: false, goal: sisyphus() }), false);
});
