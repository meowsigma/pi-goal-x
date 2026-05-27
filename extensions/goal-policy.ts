import { statusLabel, type GoalDisplayRecordLike } from "./goal-core.ts";
import type { GoalTaskList, TaskStatus } from "./goal-record.ts";

export type GoalStatusLike = "active" | "paused" | "complete";
export type StopReasonLike = "user" | "agent";

export interface GoalPolicyRecordLike extends GoalDisplayRecordLike {
	id: string;
	status: GoalStatusLike;
	updatedAt?: string;
	pauseReason?: string;
	pauseSuggestedAction?: string;
	taskList?: GoalTaskList;
}

export type PolicyValidation =
	| { ok: true }
	| { ok: false; message: string };

export function isGoalUnfinished(goal: Pick<GoalPolicyRecordLike, "status"> | null | undefined): boolean {
	return !!goal && goal.status !== "complete";
}

export function isRunnableStatus(status: GoalStatusLike): boolean {
	return status === "active";
}

export function isCompletableStatus(status: GoalStatusLike): boolean {
	return status === "active" || status === "paused";
}

export function validateGoalCreationSlot(goal: Pick<GoalPolicyRecordLike, "status"> | null): PolicyValidation {
	void goal;
	return { ok: true };
}

export function validateGoalCompletion(args: {
	goal: GoalPolicyRecordLike | null;
	runningGoalId?: string | null;
}): PolicyValidation {
	const { goal, runningGoalId } = args;
	if (!goal) return { ok: false, message: "No goal is set." };
	if (runningGoalId && goal.id !== runningGoalId) return { ok: false, message: "The active goal changed during this run; not marking it complete." };
	if (!isCompletableStatus(goal.status)) return { ok: false, message: `Goal is ${statusLabel(goal)}; complete_goal does not apply.` };
	return { ok: true };
}

export function validateGoalUpdate(args: {
	goal: GoalPolicyRecordLike | null;
}): PolicyValidation {
	if (!args.goal) return { ok: false, message: "No goal is set; cannot update objective." };
	if (args.goal.status === "complete") return { ok: false, message: "Goal is already complete; cannot update objective." };
	return { ok: true };
}

export function validateGoalAbort(args: {
	goal: GoalPolicyRecordLike | null;
	runningGoalId?: string | null;
	reason: string;
}): PolicyValidation {
	const { goal, runningGoalId } = args;
	if (!goal) return { ok: false, message: "No goal is set; abort_goal is a no-op." };
	if (runningGoalId && goal.id !== runningGoalId) return { ok: false, message: "The active goal changed during this run; not aborting." };
	if (goal.status === "complete") return { ok: false, message: "Goal is complete; abort_goal does not apply." };
	if (!args.reason.trim()) return { ok: false, message: "abort_goal requires a non-empty reason." };
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

export function buildAbortedByAgentGoal<T extends GoalPolicyRecordLike>(goal: T, args: {
	reason: string;
	updatedAt: string;
}): T {
	return {
		...goal,
		status: "paused",
		autoContinue: false,
		stopReason: "agent",
		pauseReason: `Aborted: ${args.reason.trim()}`,
		pauseSuggestedAction: undefined,
		updatedAt: args.updatedAt,
	};
}

export function validateResumeGoal(goal: GoalPolicyRecordLike | null): PolicyValidation {
	if (!goal) return { ok: false, message: "No goal is set. Use /goals or /sisyphus to discuss, or /goals-set / /sisyphus-set to start immediately." };
	if (goal.status === "complete") return { ok: false, message: "Goal is complete. Use /goals to discuss a new one or /goals-set to start immediately." };
	if (goal.status === "active" && goal.autoContinue) return { ok: false, message: "Goal is already running." };
	return { ok: true };
}

export function clearGoalCommandMessage(args: { archived: boolean; wasDrafting: boolean }): string {
	return args.archived ? "Goal cleared and archived." : args.wasDrafting ? "Drafting cancelled." : "No goal is set.";
}

export function abortGoalCommandMessage(args: { archived: boolean; wasDrafting: boolean }): string {
	return args.archived ? "Goal aborted and archived." : args.wasDrafting ? "Drafting cancelled." : "No goal is set.";
}

export function buildTaskSummary(taskList: GoalTaskList): string {
	const total = taskList.tasks.length;
	const complete = taskList.tasks.filter((t) => t.status === "complete").length;
	const skipped = taskList.tasks.filter((t) => t.status === "skipped").length;
	if (total === 0) return "No tasks";
	const parts: string[] = [`${complete}/${total} tasks complete`];
	if (skipped > 0) parts.push(`(${skipped} skipped)`);
	return parts.join(" ");
}

export function taskCompletionBlockWarning(taskList: GoalTaskList): string | null {
	if (!taskList.blockCompletion) return null;
	const pending = taskList.tasks.filter((t) => t.status === "pending");
	if (pending.length === 0) return null;
	return `${pending.length} task${pending.length > 1 ? "s" : ""} still pending with blockCompletion enabled. Complete or skip all pending tasks before finishing the goal.`;
}

export function validateTaskCompletion(args: {
	goal: GoalPolicyRecordLike | null;
	taskId: string;
}): PolicyValidation {
	if (!args.goal) return { ok: false, message: "No goal is set." };
	if (!args.goal.taskList) return { ok: false, message: "Goal has no task list." };
	const task = args.goal.taskList.tasks.find((t) => t.id === args.taskId);
	if (!task) return { ok: false, message: `Task "${args.taskId}" not found.` };
	if (task.status === "complete") return { ok: false, message: `Task "${args.taskId}" is already complete.` };
	if (task.status === "skipped") return { ok: false, message: `Task "${args.taskId}" was already skipped.` };
	return { ok: true };
}

export function validateTaskSkip(args: {
	goal: GoalPolicyRecordLike | null;
	taskId: string;
	reason: string;
}): PolicyValidation {
	if (!args.goal) return { ok: false, message: "No goal is set." };
	if (!args.goal.taskList) return { ok: false, message: "Goal has no task list." };
	const task = args.goal.taskList.tasks.find((t) => t.id === args.taskId);
	if (!task) return { ok: false, message: `Task "${args.taskId}" not found.` };
	if (task.status === "complete") return { ok: false, message: `Task "${args.taskId}" is already complete.` };
	if (task.status === "skipped") return { ok: false, message: `Task "${args.taskId}" was already skipped.` };
	if (!args.reason.trim()) return { ok: false, message: "skip_task requires a non-empty reason." };
	return { ok: true };
}

export function validateTaskListProposal(args: {
	goal: GoalPolicyRecordLike | null;
	tasks: { id: string; title: string }[];
}): PolicyValidation {
	if (!args.goal) return { ok: false, message: "No goal is set." };
	if (args.tasks.length > 50) return { ok: false, message: "Task list cannot exceed 50 tasks." };
	const ids = new Set<string>();
	for (const t of args.tasks) {
		if (!t.id.trim()) return { ok: false, message: "All tasks must have a non-empty id." };
		if (!t.title.trim()) return { ok: false, message: `Task "${t.id}" must have a non-empty title.` };
		if (ids.has(t.id)) return { ok: false, message: `Duplicate task id: "${t.id}".` };
		ids.add(t.id);
	}
	return { ok: true };
}

export function buildCompletionReport(args: { detailedSummary: string; completionSummary?: string | null; auditorReport?: string | null; auditSkippedReason?: string | null; taskSummary?: string | null }): string {
	const auditSkipped = args.auditSkippedReason?.trim();
	const auditorReport = args.auditorReport?.trim();
	const lines = auditSkipped
		? ["Goal audit skipped.", "", "Reason: " + auditSkipped, "", "Goal complete."]
		: auditorReport
			? ["Goal audit approved.", "", "Auditor approval:", auditorReport, "", "Goal complete."]
			: ["Goal complete."];
	const summary = args.completionSummary?.trim();
	if (summary) {
		lines.push("", "Completion summary:", summary);
	}
	const taskSummary = args.taskSummary?.trim();
	if (taskSummary) {
		lines.push("", `Task summary: ${taskSummary}`);
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

export function shouldQueueContinuation(goal: Pick<GoalPolicyRecordLike, "status" | "autoContinue"> | null): boolean {
	return !!goal && goal.status === "active" && goal.autoContinue;
}


export function shouldArmPostCompactReminder(goal: Pick<GoalPolicyRecordLike, "sisyphus" | "status"> | null): boolean {
	return !!goal && isRunnableStatus(goal.status);
}

export function shouldInjectPostCompactReminder(args: { pending: boolean; goal: Pick<GoalPolicyRecordLike, "sisyphus"> | null }): boolean {
	return args.pending && !!args.goal;
}
