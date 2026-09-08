import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { createAgentSession, defineTool, SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalCore } from "./goal-state.ts";
import {
  resolveAuditorModel,
  resolveAuditorSessionModelOptions,
  makeAuditorResourceLoader,
  type AuditorProgressCallback,
} from "./goal-auditor.ts";
import { loadGoalSettings, type GoalSettings } from "./goal-settings.ts";
import { detailedSummary, goalDetails } from "./goal-format.ts";
import { cloneGoal, nowIso, type GoalRecord, type GoalTask } from "./goal-record.ts";
import { countTaskSubtree } from "./goal-task-count.ts";
import { checkSubtasksComplete, findTaskInTree } from "./goal-policy.ts";
import { collectLatestUserDecisions } from "./goal-user-decisions.ts";

export interface GoalReviewDecision {
  disposition: "work" | "audit" | "wait";
  summary: string;
  nextAction: string;
  evidence: string[];
  completedTasks: Array<{ taskId: string; evidence: string }>;
  wait?: { until: string; criterion: string; observedDependency: string; taskIds: string[] };
}

export interface GoalReviewResult {
  decision?: GoalReviewDecision;
  output: string;
  model?: string;
  tokensUsed?: number;
  error?: string;
}

const ReviewSchema = Type.Object({
  disposition: Type.Union([Type.Literal("work"), Type.Literal("audit"), Type.Literal("wait")]),
  summary: Type.String(),
  nextAction: Type.String(),
  evidence: Type.Array(Type.String()),
  completedTasks: Type.Array(Type.Object({ taskId: Type.String(), evidence: Type.String() })),
  wait: Type.Optional(Type.Object({ until: Type.String(), criterion: Type.String(), observedDependency: Type.String(), taskIds: Type.Array(Type.String()) })),
}, { additionalProperties: false });

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function taskIds(tasks: readonly GoalTask[], out = new Set<string>()): Set<string> {
  for (const task of tasks) {
    out.add(task.id);
    if (task.subtasks) taskIds(task.subtasks, out);
  }
  return out;
}

function pendingTaskIds(tasks: readonly GoalTask[], completed: ReadonlySet<string>, out: string[] = []): string[] {
  for (const task of tasks) {
    if (task.status === "pending" && !completed.has(task.id)) out.push(task.id);
    if (task.subtasks) pendingTaskIds(task.subtasks, completed, out);
  }
  return out;
}

export function validateGoalReviewDecision(value: unknown, goal: GoalRecord): GoalReviewDecision | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "review result must be an object" };
  const raw = value as Record<string, unknown>;
  const disposition = raw.disposition;
  if (disposition !== "work" && disposition !== "audit" && disposition !== "wait") return { error: "disposition must be work, audit, or wait" };
  const summary = text(raw.summary, 1_000);
  const nextAction = text(raw.nextAction, 1_000);
  if (!summary || !nextAction) return { error: "summary and nextAction are required" };
  const evidence = Array.isArray(raw.evidence) ? raw.evidence.map((item) => text(item, 500)).filter((item): item is string => !!item).slice(0, 12) : [];
  if (raw.evidence !== undefined && !Array.isArray(raw.evidence)) return { error: "evidence must be an array" };
  const ids = taskIds(goal.taskList?.tasks ?? []);
  const completedTasks: Array<{ taskId: string; evidence: string }> = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.completedTasks)) {
    for (const item of raw.completedTasks.slice(0, 50)) {
      if (!item || typeof item !== "object") return { error: "completedTasks entries must be objects" };
      const entry = item as Record<string, unknown>;
      const taskId = text(entry.taskId, 200);
      const taskEvidence = text(entry.evidence, 500);
      if (!taskId || !taskEvidence) return { error: "every completed task needs an id and evidence" };
      if (!ids.has(taskId)) return { error: `unknown task id: ${taskId}` };
      if (seen.has(taskId)) return { error: `duplicate task id: ${taskId}` };
      seen.add(taskId);
      completedTasks.push({ taskId, evidence: taskEvidence });
    }
  } else if (raw.completedTasks !== undefined) return { error: "completedTasks must be an array" };
  let wait: GoalReviewDecision["wait"];
  if (raw.wait !== undefined) {
    if (!raw.wait || typeof raw.wait !== "object") return { error: "wait must be an object" };
    const candidate = raw.wait as Record<string, unknown>;
    const until = text(candidate.until, 100);
    const criterion = text(candidate.criterion, 500);
    const observedDependency = text(candidate.observedDependency, 500);
    const waitTaskIds = Array.isArray(candidate.taskIds) ? candidate.taskIds.map((item) => text(item, 200)).filter((item): item is string => !!item) : [];
    if (!until || !criterion || !observedDependency || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now()) return { error: "wait requires a future UTC instant, criterion, and observed dependency" };
    if (!until.endsWith("Z")) return { error: "wait.until must be a UTC timestamp" };
    const pending = pendingTaskIds(goal.taskList?.tasks ?? [], seen);
    if (new Set(waitTaskIds).size !== waitTaskIds.length || waitTaskIds.some((id) => !ids.has(id))) return { error: "wait.taskIds must contain unique known task ids" };
    if (waitTaskIds.some((id) => !pending.includes(id))) return { error: "wait.taskIds must contain only remaining pending task ids" };
    if (pending.some((id) => !waitTaskIds.includes(id))) return { error: "wait.taskIds must cover every remaining pending task, including parents" };
    wait = { until: new Date(until).toISOString(), criterion, observedDependency, taskIds: waitTaskIds };
  }
  if (disposition === "wait" && !wait) return { error: "wait disposition requires wait evidence" };
  if (disposition !== "wait" && wait) return { error: "wait is only valid with wait disposition" };
  if (disposition === "wait" && goal.taskList && pendingTaskIds(goal.taskList.tasks, seen).length > 0 && !wait) {
    return { error: "wait requires explicit pending task ids" };
  }
  return { disposition, summary, nextAction, evidence, completedTasks, ...(wait ? { wait } : {}) };
}

function escapePayload(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderTasks(tasks: readonly GoalTask[], indent = 0): string[] {
  return tasks.flatMap((task) => [
    `${"  ".repeat(indent)}[${task.status === "complete" ? "x" : task.status === "skipped" ? "~" : " "}] ${escapePayload(task.id)}: ${escapePayload(task.title)}${task.verificationContract ? ` — contract: ${escapePayload(task.verificationContract)}` : ""}${task.evidence ? ` — evidence: ${escapePayload(task.evidence)}` : ""}`, 
    ...(task.subtasks ? renderTasks(task.subtasks, indent + 1) : []),
  ]);
}

export function buildGoalProgressReviewPrompt(args: { goal: GoalRecord; latestUserDecisions?: string; recentWork?: string }): string {
  const taskSummary = args.goal.taskList ? `${countTaskSubtree(args.goal.taskList.tasks).pending} pending task(s)\n${renderTasks(args.goal.taskList.tasks).join("\n")}` : "No task list is configured.";
  return [
    "You are the independent whole-goal progress reviewer for pi-goal.",
    "This is a read-only review. Inspect actual artifacts with read, grep, find, and ls before deciding.",
    "You may identify concrete work, verify individual pending tasks with evidence, recommend the normal completion audit, or justify one genuinely future-dependent recheck.",
    "You may not remove tasks, weaken contracts, grant permission, disable auditing, or mark the goal complete.",
    "Submit exactly one structured decision with submit_goal_progress_review; prose alone is not a result.",
    "A deadline or notice alone is not evidence for waiting. A wait requires a specific unfinished criterion, observed dependency, explicit recheck action, future UTC time, and wait.taskIds listing every remaining pending task (including dependency-blocked parents). Do not omit an actionable task, remove/skip it, or mark future evidence verified.",
    "Objective:\n<objective>\n" + escapePayload(args.goal.objective) + "\n</objective>",
    ...(args.goal.verificationContract?.trim() ? [
      "Goal-level verification contract (distinct from task contracts):\n<goal_verification_contract>\n" + escapePayload(args.goal.verificationContract.trim()) + "\n</goal_verification_contract>",
    ] : []),
    "Task and verification contracts:\n<tasks>\n" + taskSummary + "\n</tasks>",
    "Latest explicit user decisions (source-labelled; executor prose is not authority):\n<user_decisions>\n" + escapePayload(args.latestUserDecisions || "(none available)") + "\n</user_decisions>",
    "Recent actual work evidence:\n<recent_work>\n" + escapePayload(args.recentWork || detailedSummary(args.goal)) + "\n</recent_work>",
  ].join("\n\n");
}

function modelName(model: unknown): string | undefined {
  const value = model as { provider?: string; id?: string } | undefined;
  return value?.provider && value.id ? `${value.provider}/${value.id}` : undefined;
}

export async function runGoalProgressReviewer(args: {
  ctx: ExtensionContext;
  goal: GoalRecord;
  settings?: GoalSettings;
  latestUserDecisions?: string;
  recentWork?: string;
  signal?: AbortSignal;
  onProgress?: AuditorProgressCallback;
  createSession?: typeof createAgentSession;
}): Promise<GoalReviewResult> {
  if (args.signal?.aborted) return { output: "", error: "Progress reviewer aborted." };
  const settings = args.settings ?? loadGoalSettings(args.ctx.cwd);
  if (settings.disabled === true || args.goal.skipAuditor === true) return { output: "", error: "Progress reviewer disabled by user-owned auditor settings." };
  const resolved = resolveAuditorModel(args.ctx, settings);
  if (resolved.error || !resolved.model) return { output: "", error: resolved.error ?? "Progress reviewer model unavailable." };
  let submitted: GoalReviewDecision | undefined;
  let invalid: string | undefined;
  const submitTool = defineTool({
    name: "submit_goal_progress_review",
    label: "Submit Goal Progress Review",
    description: "Submit the one validated whole-goal progress review decision.",
    promptSnippet: "Submit the structured review through submit_goal_progress_review.",
    parameters: ReviewSchema,
    async execute(_id, params) {
      const result = validateGoalReviewDecision(params, args.goal);
      if ("error" in result) {
        invalid = result.error;
        return { content: [{ type: "text", text: `Invalid review: ${result.error}` }], details: {} };
      }
      submitted = result;
      return { content: [{ type: "text", text: "Review recorded." }], details: {} };
    },
  });
  const create = args.createSession ?? createAgentSession;
  try {
    let tokensUsed = 0;
    const { session } = await create({
      cwd: args.ctx.cwd,
      model: resolved.model,
      thinkingLevel: settings.thinkingLevel,
      ...resolveAuditorSessionModelOptions(args.ctx),
      resourceLoader: makeAuditorResourceLoader(),
      sessionManager: SessionManager.inMemory(args.ctx.cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      tools: ["read", "grep", "find", "ls", "submit_goal_progress_review"],
      customTools: [submitTool],
    } as Parameters<typeof createAgentSession>[0]);
    const unsubscribe = session.subscribe?.((event: unknown) => {
      const message = event as { type?: string; message?: { role?: string; usage?: { input?: number; output?: number } } };
      if (message.type === "message_end" && message.message?.role === "assistant") tokensUsed += (message.message.usage?.input ?? 0) + (message.message.usage?.output ?? 0);
    });
    const abort = () => session.abort();
    args.signal?.addEventListener("abort", abort, { once: true });
    try {
      await session.prompt(buildGoalProgressReviewPrompt({ goal: args.goal, latestUserDecisions: args.latestUserDecisions, recentWork: args.recentWork }));
    } finally {
      args.signal?.removeEventListener("abort", abort);
      unsubscribe?.();
    }
    if (args.signal?.aborted) return { output: "", model: modelName(resolved.model), tokensUsed, error: "Progress reviewer aborted." };
    if (!submitted) return { output: "", model: modelName(resolved.model), tokensUsed, error: invalid ?? "Progress reviewer returned no structured decision." };
    return { decision: submitted, output: `${submitted.summary}\n${submitted.nextAction}`, model: modelName(resolved.model), tokensUsed };
  } catch (error) {
    return { output: "", model: modelName(resolved.model), error: args.signal?.aborted ? "Progress reviewer aborted." : error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) };
  }
}

function stableScopeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableScopeValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableScopeValue(item)]));
  return value;
}

export function goalReviewScope(goal: GoalRecord, userDecisions = ""): string {
  return createHash("sha256").update(JSON.stringify(stableScopeValue({ objective: goal.objective, taskList: goal.taskList, verificationContract: goal.verificationContract, userDecisions }))).digest("hex").slice(0, 32);
}

export async function runGoalProgressReviewFlow(core: GoalCore, ctx: ExtensionContext, opts: { reason?: string; latestUserDecisions?: string } = {}): Promise<GoalReviewResult | null> {
  const goal = core.state.goal;
  if (!goal || !core.isActionableContinuationGoal(goal.id)) return null;
  const latestUserDecisions = opts.latestUserDecisions ?? collectLatestUserDecisions(ctx.sessionManager?.getBranch?.() ?? [], goal.id);
  if (core.runtime.isProgressReviewExhausted?.(goal)) return { output: "", error: "Independent progress review is exhausted; continue safe independent work until an explicit reset or scope change." };
  if (!core.runtime.beginProgressReview(goal.id)) return null;
  const scope = goalReviewScope(goal, latestUserDecisions);
  const operationToken = core.focusedOperationToken(goal.id);
  const userDecisionEpoch = core.userDecisionEpoch;
  const reviewer = core.dependencies.runProgressReviewer ?? runGoalProgressReviewer;
  const controller = new AbortController();
  core.reviewAbortController = controller;
  try {
    const result = await reviewer({ ctx, goal: cloneGoal(goal), settings: loadGoalSettings(ctx.cwd), latestUserDecisions, recentWork: opts.reason, signal: controller.signal });
    if (result.tokensUsed) core.accountProgress(ctx, { completedTurnTokens: result.tokensUsed, goalId: goal.id, operationToken });
    // Reconcile authoritative disk state before applying any reviewer effect.
    // The focus token catches away-and-back focus changes; the structural scope
    // catches edited objectives/contracts/tasks; the input epoch catches a new
    // explicit instruction that does not itself change focus.
    const reconciled = core.reconcileFocusedGoalFromDisk?.(ctx) ?? true;
    const currentAfterReview = core.state.goal;
    if (!reconciled || !core.isFocusedOperationCurrent(operationToken) || core.focusedGoalId !== goal.id || !core.isActionableContinuationGoal(goal.id)
      || core.userDecisionEpoch !== userDecisionEpoch
      || !currentAfterReview || goalReviewScope(currentAfterReview, latestUserDecisions) !== scope) {
      return { ...result, error: "Progress review became stale; no goal state was changed." };
    }
    if (!result.decision) {
      const diagnostic = result.error ?? "no decision";
      if (diagnostic.includes("disabled by user-owned")) {
        core.runtime.retainReviewInstruction(ctx, goal, scope, "The independent reviewer is disabled by the user's settings. Continue safe independent work while preserving every unmet contract.");
        core.runtime.scheduleExecutionRecovery(ctx, goal, scope, "Continue safe independent work; the disabled reviewer cannot establish completion.");
      } else {
        core.runtime.recordProgressReviewFailure(ctx, goal, diagnostic, scope);
      }
      return result;
    }
    core.runtime.clearProgressReviewFailure(goal.id);
    const decision = result.decision;
    // Task evidence is applied only through the same GoalService mutation
    // boundary as update_goal_task; a review can never alter contracts or
    // bypass child ordering/evidence invariants.
    if (decision.completedTasks.length > 0 && core.state.goal?.id === goal.id) {
      const ordered = [...decision.completedTasks].sort((left, right) => {
        const depth = (taskId: string, tasks: readonly GoalTask[], level = 0): number => {
          for (const task of tasks) {
            if (task.id === taskId) return level;
            if (task.subtasks) { const nested = depth(taskId, task.subtasks, level + 1); if (nested >= 0) return nested; }
          }
          return -1;
        };
        return depth(right.taskId, goal.taskList?.tasks ?? []) - depth(left.taskId, goal.taskList?.tasks ?? []);
      });
      for (const item of ordered) {
        if (!findTaskInTree(core.state.goal.taskList?.tasks ?? [], item.taskId)) continue;
          if (!core.isFocusedOperationCurrent(operationToken) || core.userDecisionEpoch !== userDecisionEpoch || core.state.goal?.id !== goal.id) return { ...result, error: "Progress review became stale while applying task evidence." };
        const updated = core.goalService.updateTask(ctx, {
          focusToken: core.focusedOperationToken(goal.id),
          taskId: item.taskId,
          validate: (current) => {
            if (current.status !== "pending") return { ok: false, message: `Task "${item.taskId}" is not pending.` };
            if (!loadGoalSettings(ctx.cwd).disableContracts && current.verificationContract && !item.evidence.trim()) return { ok: false, message: `Task "${item.taskId}" requires evidence.` };
            const children = checkSubtasksComplete(current);
            return children ? { ok: false, message: children } : { ok: true };
          },
          update: (current) => ({ ...current, status: "complete" as const, completedAt: nowIso(), evidence: item.evidence.trim().slice(0, 200) }),
          ledger: (written) => [{ type: "task_complete", goalId: written.id, taskId: item.taskId, evidence: item.evidence.trim().slice(0, 200), at: written.updatedAt }],
        });
        if (!updated.ok) return { ...result, error: `Review task update rejected: ${updated.message}` };
      }
    }
    // GoalService task updates replace the focused record. Never persist a
    // continuation from the pre-review snapshot: doing so can resurrect tasks
    // that the reviewer just verified.
    const currentGoal = core.state.goal;
    const postTaskScope = currentGoal ? goalReviewScope(currentGoal, latestUserDecisions) : "";
    const reconciledAfterTasks = core.reconcileFocusedGoalFromDisk?.(ctx) ?? true;
    if (!currentGoal || currentGoal.id !== goal.id || !core.isFocusedOperationCurrent(operationToken) || core.userDecisionEpoch !== userDecisionEpoch || !reconciledAfterTasks || !core.state.goal || goalReviewScope(core.state.goal, latestUserDecisions) !== postTaskScope) return { ...result, error: "Progress review became stale while applying task evidence." };
    if (decision.disposition === "wait" && decision.wait) {
      const wake = { id: `${goal.id}-${Date.now().toString(36)}`, at: decision.wait.until, kind: "external_wait" as const, reason: decision.wait.criterion, evidence: [decision.wait.observedDependency, ...decision.evidence].slice(0, 8) };
      const armed = core.runtime.scheduleDeferredWake(ctx, currentGoal, { scope: postTaskScope, instruction: decision.nextAction, executionRetries: 0, reviewFailures: 0, wake });
      core.pi.sendMessage({ customType: "pi-goal-review-result", content: armed
        ? `Review scheduled a goal-owned recheck.\nAt: ${wake.at}\nAction: ${decision.nextAction}\nWake is in-process; overdue work is recovered when Pi returns.`
        : "Review could not persist and arm the future recheck; the criterion remains NOT PROVEN.", display: true, details: goalDetails(core.state.goal) }, { triggerTurn: false });
      return result;
    }
    if (decision.disposition === "audit") {
      const { runGoalCompletionFlow } = await import("./goal-completion.ts");
      const { archiveCompletedGoal } = await import("./goal-archive.ts");
      const audit = await runGoalCompletionFlow(core, ctx, decision.summary, { scope: postTaskScope, userDecisionEpoch, userDecisions: latestUserDecisions });
      if (audit.content?.length) core.pi.sendMessage({ customType: "pi-goal-review-result", content: audit.content.map((item) => "text" in item ? item.text : "").join("\n"), display: true, details: goalDetails(core.state.goal) }, { triggerTurn: false });
      if (core.state.goal?.status === "complete") archiveCompletedGoal(core, ctx);
      return result;
    }
    // Retain actionable advice durably, then give it one immediate execution
    // chance. If it is ignored, the settled no-progress path owns quiet
    // recovery rather than buying the same review repeatedly.
    core.runtime.retainReviewInstruction(ctx, currentGoal, postTaskScope, decision.nextAction);
    core.queueContinuation(ctx, true);
    return result;
  } finally {
    if (core.reviewAbortController === controller) core.reviewAbortController = null;
    core.runtime.endProgressReview(goal.id);
  }
}

export function reviewReceipt(result: GoalReviewResult): string {
  return result.decision ? `Review: ${result.decision.summary}\nNext: ${result.decision.nextAction}` : `Review unavailable: ${result.error ?? "not proven"}`;
}

