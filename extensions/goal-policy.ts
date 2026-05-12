import { statusLabel, truncateText, type GoalDisplayRecordLike } from "./goal-core.ts";

export type GoalStatusLike = "active" | "paused" | "budgetLimited" | "complete";
export type StopReasonLike = "user" | "agent";

export interface GoalPolicyRecordLike extends GoalDisplayRecordLike {
	id: string;
	status: GoalStatusLike;
	updatedAt?: string;
	totalSteps?: number | null;
	stepsCompleted?: number;
	currentStep?: number;
	pauseReason?: string;
	pauseSuggestedAction?: string;
}

export type PolicyValidation =
	| { ok: true }
	| { ok: false; message: string };

export type StepValidation =
	| { ok: true; evidence: string; done: number; expected: number; stepIndex: number }
	| { ok: false; message: string };

export interface VerifyCommandResultLike {
	code: number;
	killed: boolean;
	stdout: string;
	stderr: string;
}

export type VerifyCommandPolicy =
	| { ok: true; summary: string }
	| { ok: false; message: string };

export function isGoalUnfinished(goal: Pick<GoalPolicyRecordLike, "status"> | null | undefined): boolean {
	return !!goal && goal.status !== "complete";
}

export function isRunnableStatus(status: GoalStatusLike): boolean {
	return status === "active" || status === "budgetLimited";
}

export function statusAfterBudgetLimit(goal: Pick<GoalPolicyRecordLike, "status" | "tokenBudget" | "usage">): GoalStatusLike {
	if (goal.status === "active" && goal.tokenBudget !== null && goal.usage.tokensUsed >= goal.tokenBudget) {
		return "budgetLimited";
	}
	return goal.status;
}

export function validateGoalCreationSlot(goal: Pick<GoalPolicyRecordLike, "status"> | null): PolicyValidation {
	if (isGoalUnfinished(goal)) return { ok: false, message: "An unfinished goal already exists. Ask the user before replacing it." };
	return { ok: true };
}

export function validateGoalCompletion(args: {
	goal: GoalPolicyRecordLike | null;
	runningGoalId?: string | null;
}): PolicyValidation {
	const { goal, runningGoalId } = args;
	if (!goal) return { ok: false, message: "No goal is set." };
	if (runningGoalId && goal.id !== runningGoalId) return { ok: false, message: "The active goal changed during this run; not marking it complete." };
	if (!isRunnableStatus(goal.status)) return { ok: false, message: `Goal is ${statusLabel(goal)}; ask the user to resume it before marking complete.` };
	if (goal.sisyphus && typeof goal.totalSteps === "number" && goal.totalSteps > 0) {
		const done = goal.stepsCompleted ?? 0;
		if (done < goal.totalSteps) {
			const remaining = goal.totalSteps - done;
			return {
				ok: false,
				message: `update_goal(complete) REJECTED: this is a Sisyphus goal with ${goal.totalSteps} numbered steps. ` +
					`Only ${done} step(s) have been marked complete via step_complete. ` +
					`${remaining} step(s) remain. ` +
					`Either (a) execute step ${done + 1} and call step_complete({stepIndex: ${done + 1}, evidence: ...}), ` +
					`or (b) call pause_goal({reason, suggestedAction?}) if you cannot complete the remaining step(s). ` +
					`Sisyphus completion cannot be claimed until step_complete has been called for all ${goal.totalSteps} steps.`,
			};
		}
	}
	return { ok: true };
}

export function validatePauseGoal(args: {
	goal: GoalPolicyRecordLike | null;
	runningGoalId?: string | null;
	reason: string;
}): PolicyValidation {
	const { goal, runningGoalId } = args;
	if (!goal) return { ok: false, message: "No goal is set; pause_goal is a no-op." };
	if (runningGoalId && goal.id !== runningGoalId) return { ok: false, message: "The active goal changed during this run; not pausing." };
	if (!isRunnableStatus(goal.status)) return { ok: false, message: `Goal is ${statusLabel(goal)}; pause_goal does not apply.` };
	if (!args.reason.trim()) return { ok: false, message: "pause_goal requires a non-empty reason." };
	return { ok: true };
}

export function buildPausedByAgentGoal<T extends GoalPolicyRecordLike>(goal: T, args: {
	reason: string;
	suggestedAction?: string;
	updatedAt: string;
}): T {
	const suggested = args.suggestedAction?.trim() || undefined;
	return {
		...goal,
		status: "paused",
		autoContinue: false,
		stopReason: "agent",
		pauseReason: args.reason.trim(),
		pauseSuggestedAction: suggested,
		updatedAt: args.updatedAt,
	};
}

export function validateResumeGoal(goal: GoalPolicyRecordLike | null): PolicyValidation {
	if (!goal) return { ok: false, message: "No goal is set. Use /goal-set or /goal-sis to start one." };
	if (goal.status === "complete") return { ok: false, message: "Goal is complete. Use /goal-set to start a new one." };
	if (goal.status === "active" && goal.autoContinue) return { ok: false, message: "Goal is already running." };
	if (goal.status === "budgetLimited" && goal.tokenBudget !== null && goal.usage.tokensUsed >= goal.tokenBudget) {
		return { ok: false, message: "Goal is budget-limited. Raise or remove the budget before resuming." };
	}
	return { ok: true };
}

export function clearGoalCommandMessage(args: { archived: boolean; wasDrafting: boolean }): string {
	return args.archived ? "Goal cleared and archived." : args.wasDrafting ? "Drafting cancelled." : "No goal is set.";
}

export function buildCompletionReport(args: { detailedSummary: string; completionSummary?: string | null }): string {
	const lines = ["Goal complete."];
	const summary = args.completionSummary?.trim();
	if (summary) {
		lines.push("", "Completion summary:", summary);
	}
	lines.push("", args.detailedSummary);
	return lines.join("\n");
}

export function buildGoalCreatedReport(args: { objective: string; detailedSummary?: string | null }): string {
	const lines = ["Goal confirmed and created.", "", "Finalized goal:", "", args.objective.trim()];
	const summary = args.detailedSummary?.trim();
	if (summary) {
		lines.push("", "Goal details:", summary);
	}
	return lines.join("\n");
}

export function validateStepCompletion(args: {
	goal: GoalPolicyRecordLike | null;
	runningGoalId?: string | null;
	stepIndex: number;
	evidence: string;
}): StepValidation {
	const { goal, runningGoalId } = args;
	if (!goal) return { ok: false, message: "No goal is set; step_complete is a no-op." };
	if (runningGoalId && goal.id !== runningGoalId) return { ok: false, message: "The active goal changed during this run; not advancing the step counter." };
	if (!goal.sisyphus) return { ok: false, message: "step_complete only applies to Sisyphus goals. This goal is not in Sisyphus mode." };
	if (!isRunnableStatus(goal.status)) return { ok: false, message: `Goal is ${statusLabel(goal)}; step_complete does not apply.` };
	if (typeof goal.totalSteps !== "number" || goal.totalSteps <= 0) {
		return { ok: false, message: "This Sisyphus goal has no parseable numbered step count; step_complete cannot advance. If steps were intended, ask the user to /goal-tweak to add an explicit numbered Steps section." };
	}
	const evidence = args.evidence.trim();
	if (!evidence) return { ok: false, message: "step_complete requires a non-empty evidence string." };
	const done = goal.stepsCompleted ?? 0;
	const expected = done + 1;
	const stepIndex = Math.floor(args.stepIndex);
	if (stepIndex !== expected) {
		return {
			ok: false,
			message: `step_complete REJECTED: stepIndex=${stepIndex} but the next expected step is ${expected} ` +
				`(${done}/${goal.totalSteps} completed so far). ` +
				(stepIndex < expected
					? `Step ${stepIndex} was already marked complete. Do not re-mark it.`
					: `You cannot skip to step ${stepIndex}; execute step ${expected} first and call step_complete({stepIndex: ${expected}, evidence: ...}).`),
		};
	}
	if (done >= goal.totalSteps) {
		return { ok: false, message: `All ${goal.totalSteps} steps are already marked complete. Call update_goal(complete) to finish the goal.` };
	}
	return { ok: true, evidence, done, expected, stepIndex };
}

export function classifyVerifyCommandResult(args: {
	stepIndex: number;
	result: VerifyCommandResultLike | null;
	execError?: string | null;
}): VerifyCommandPolicy {
	const { stepIndex, result } = args;
	const execError = args.execError ?? null;
	if (execError || !result) {
		return {
			ok: false,
			message: `step_complete REJECTED: verifyCommand could not be executed (${execError ?? "unknown error"}). ` +
				`Step ${stepIndex} is NOT marked complete. Fix the command and retry, or call step_complete without verifyCommand if you have a different way to prove it.`,
		};
	}
	const out = ((result.stdout || "") + (result.stderr ? `\n[stderr]\n${result.stderr}` : "")).trim();
	if (result.killed) {
		return {
			ok: false,
			message: `step_complete REJECTED: verifyCommand TIMED OUT after 30s. ` +
				`Step ${stepIndex} is NOT marked complete. The criterion was not proven. ` +
				`Either simplify the verifyCommand or actually finish the step before retrying.` +
				(out ? `\n\nPartial output:\n${truncateText(out, 600)}` : ""),
		};
	}
	if (result.code !== 0) {
		return {
			ok: false,
			message: `step_complete REJECTED: verifyCommand exited with code ${result.code} (non-zero = criterion not met). ` +
				`Step ${stepIndex} is NOT marked complete. ` +
				`Either (a) actually execute the step so the criterion is satisfied, then retry step_complete, ` +
				`or (b) if the step is genuinely blocked, call pause_goal({reason, suggestedAction?}).` +
				(out ? `\n\nVerify output:\n${truncateText(out, 800)}` : ""),
		};
	}
	return { ok: true, summary: " verifyCommand passed (exit 0)." };
}

export function shouldQueueContinuation(goal: Pick<GoalPolicyRecordLike, "status" | "autoContinue"> | null): boolean {
	return !!goal && goal.status === "active" && goal.autoContinue;
}

export function shouldAutoPauseForContinueCap(args: {
	goal: Pick<GoalPolicyRecordLike, "id" | "status" | "autoContinue"> | null;
	autoContinueTurns: number;
	maxTurns: number;
}): boolean {
	return shouldQueueContinuation(args.goal) && args.autoContinueTurns >= args.maxTurns;
}

export function buildAutoContinueCapPause<T extends GoalPolicyRecordLike>(goal: T, args: { maxTurns: number; updatedAt: string }): T {
	return {
		...goal,
		status: "paused",
		autoContinue: false,
		stopReason: "agent",
		pauseReason: `Auto-continue cap reached (${args.maxTurns} consecutive turns).`,
		pauseSuggestedAction: "Review the goal's progress and /goal-resume, /goal-tweak, or /goal-clear.",
		updatedAt: args.updatedAt,
	};
}

export function shouldArmPostCompactReminder(goal: Pick<GoalPolicyRecordLike, "sisyphus" | "status"> | null): boolean {
	return !!goal && goal.sisyphus && isRunnableStatus(goal.status);
}

export function shouldInjectPostCompactReminder(args: { pending: boolean; goal: Pick<GoalPolicyRecordLike, "sisyphus"> | null }): boolean {
	return args.pending && !!args.goal?.sisyphus;
}
