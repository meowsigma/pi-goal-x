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
import { currentGoalLifecycleSnapshot } from "./prompts/goal-prompts.ts";
import { diagnosticHash, recordGoalDiagnostic, redactDiagnosticText } from "./goal-diagnostics.ts";

export interface GoalReviewDecision {
  disposition: "work" | "audit" | "wait" | "hold";
  summary: string;
  nextAction: string;
  evidence: string[];
  /** Required for work: what the next action should reveal. */
  expectedObservation?: string;
  /** Required for work: which criterion or decision the observation affects. */
  decisionImpact?: string;
  completedTasks: Array<{ taskId: string; evidence: string }>;
  wait?: { until: string; criterion: string; observedDependency: string; taskIds: string[] };
  hold?: { reason: string; evidence: string[] };
}

export interface GoalReviewResult {
  decision?: GoalReviewDecision;
  output: string;
  model?: string;
  effort?: string;
  tokensUsed?: number;
  error?: string;
}

const ReviewSchema = Type.Object({
  disposition: Type.Union([Type.Literal("work"), Type.Literal("audit"), Type.Literal("wait"), Type.Literal("hold")]),
  summary: Type.String(),
  nextAction: Type.String(),
  evidence: Type.Array(Type.String()),
  expectedObservation: Type.Optional(Type.String()),
  decisionImpact: Type.Optional(Type.String()),
  completedTasks: Type.Array(Type.Object({ taskId: Type.String(), evidence: Type.String() })),
  wait: Type.Optional(Type.Object({ until: Type.String(), criterion: Type.String(), observedDependency: Type.String(), taskIds: Type.Array(Type.String()) })),
  hold: Type.Optional(Type.Object({ reason: Type.String(), evidence: Type.Array(Type.String()) })),
}, { additionalProperties: false });

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? redactDiagnosticText(value.trim(), max) : undefined;
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
  if (disposition !== "work" && disposition !== "audit" && disposition !== "wait" && disposition !== "hold") return { error: "disposition must be work, audit, wait, or hold" };
  const summary = text(raw.summary, 1_000);
  const nextAction = text(raw.nextAction, 1_000);
  if (!summary || !nextAction) return { error: "summary and nextAction are required" };
  const expectedObservation = text(raw.expectedObservation, 500);
  const decisionImpact = text(raw.decisionImpact, 500);
  if (disposition === "work" && (!expectedObservation || !decisionImpact)) return { error: "work requires expectedObservation and decisionImpact" };
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
  let hold: GoalReviewDecision["hold"];
  if (raw.hold !== undefined) {
    if (!raw.hold || typeof raw.hold !== "object") return { error: "hold must be an object" };
    const candidate = raw.hold as Record<string, unknown>;
    const reason = text(candidate.reason, 500);
    const holdEvidence = Array.isArray(candidate.evidence) ? candidate.evidence.map((item) => text(item, 500)).filter((item): item is string => !!item).slice(0, 8) : [];
    if (!reason || holdEvidence.length === 0) return { error: "hold requires a reason and evidence" };
    if (!Array.isArray(candidate.evidence)) return { error: "hold.evidence must be an array" };
    hold = { reason, evidence: holdEvidence };
  }
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
  if (disposition === "hold" && !hold) return { error: "hold disposition requires hold reason and evidence" };
  if (disposition !== "hold" && hold) return { error: "hold is only valid with hold disposition" };
  if (disposition === "wait" && goal.taskList && pendingTaskIds(goal.taskList.tasks, seen).length > 0 && !wait) {
    return { error: "wait requires explicit pending task ids" };
  }
  return { disposition, summary, nextAction, evidence, ...(expectedObservation ? { expectedObservation } : {}), ...(decisionImpact ? { decisionImpact } : {}), completedTasks, ...(wait ? { wait } : {}), ...(hold ? { hold } : {}) };
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
    currentGoalLifecycleSnapshot(args.goal),
    "This is a read-only review. Inspect actual artifacts with read, grep, find, and ls before deciding.",
    "You may identify concrete work, verify individual pending tasks with evidence, recommend the normal completion audit, justify one genuinely future-dependent recheck, or record a quiet incomplete hold when no justified next action exists.",
    "A work decision must include a bounded expectedObservation and decisionImpact: state what the next action should reveal and which criterion or decision it changes. Generic objective restatements are not work.",
    "A hold decision must include a precise reason and bounded evidence. A hold keeps the goal ACTIVE and incomplete; it is not a pause, completion, or retry timer.",
    "You may not remove tasks, weaken contracts, grant permission, disable auditing, or mark the goal complete.",
    "Submit exactly one structured decision with submit_goal_progress_review; prose alone is not a result.",
    "A deadline or notice alone is not evidence for waiting. A wait requires a specific unfinished criterion, observed dependency, explicit recheck action, future UTC time, and wait.taskIds listing every remaining pending task (including dependency-blocked parents). Do not omit an actionable task, remove/skip it, or mark future evidence verified.",
    "Objective:\n<objective>\n" + escapePayload(args.goal.objective) + "\n</objective>",
    ...(args.goal.verificationContract?.trim() ? [
      "Goal-level verification contract (distinct from task contracts):\n<goal_verification_contract>\n" + escapePayload(args.goal.verificationContract.trim()) + "\n</goal_verification_contract>",
    ] : []),
    "Task and verification contracts:\n<tasks>\n" + taskSummary + "\n</tasks>",
    "Latest explicit user decisions (source-labelled; executor prose is not authority):\n<user_decisions>\n" + escapePayload(args.latestUserDecisions || "(none available)") + "\n</user_decisions>",
    "Previous independent recommendation (retained until evaluated, not erased by tool activity):\n<previous_advice>\n" + escapePayload(args.goal.continuation?.instruction || "(none)") + "\n</previous_advice>",
    "Recent actual work evidence:\n<recent_work>\n" + escapePayload(redactDiagnosticText(args.recentWork || detailedSummary(args.goal), 4_000)) + "\n</recent_work>",
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
  let tokensUsed = 0;
  try {
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
    const effort = settings.thinkingLevel;
    if (args.signal?.aborted) return { output: "", model: modelName(resolved.model), effort, tokensUsed, error: "Progress reviewer aborted." };
    if (!submitted) return { output: "", model: modelName(resolved.model), effort, tokensUsed, error: invalid ?? "Progress reviewer returned no structured decision." };
    return { decision: submitted, output: `${submitted.summary}\n${submitted.nextAction}`, model: modelName(resolved.model), effort, tokensUsed };
  } catch (error) {
    return { output: "", model: modelName(resolved.model), effort: settings.thinkingLevel, tokensUsed, error: args.signal?.aborted ? "Progress reviewer aborted." : redactDiagnosticText(error instanceof Error ? error.message : String(error)) };
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

/** Excludes status chatter, counters and timestamps; only relevant scope/configuration changes release a hold. */
export function goalHoldAdmissionKey(goal: GoalRecord, ctx: ExtensionContext, effort?: string): string {
  const settings = loadGoalSettings(ctx.cwd);
  return diagnosticHash({ scope: goalReviewScope(goal), reviewer: [settings.provider, settings.model, settings.thinkingLevel, settings.disabled, settings.disableContracts], executor: [ctx.model?.provider, ctx.model?.id, effort], networkRecovery: settings.networkRecovery, skipAuditor: goal.skipAuditor });
}

export async function runGoalProgressReviewFlow(core: GoalCore, ctx: ExtensionContext, opts: { reason?: string; latestUserDecisions?: string } = {}): Promise<GoalReviewResult | null> {
  const goal = core.state.goal;
  if (!goal || !core.isActionableContinuationGoal(goal.id) || goal.continuation?.wake) return null;
  const latestUserDecisions = opts.latestUserDecisions ?? collectLatestUserDecisions(ctx.sessionManager?.getBranch?.() ?? [], goal.id);
  if (goal.continuation?.hold) return { output: "", error: "Independent progress review is on a durable incomplete hold; await an explicit reset, scope change, or owned wake." };
  if (!core.runtime.beginProgressReview(goal.id)) return null;
  const scope = goalReviewScope(goal, latestUserDecisions);
  const admissionKey = goalHoldAdmissionKey(goal, ctx, core.pi.getThinkingLevel?.());
  const operationToken = core.focusedOperationToken(goal.id);
  const userDecisionEpoch = core.userDecisionEpoch;
  const reviewer = core.dependencies.runProgressReviewer ?? runGoalProgressReviewer;
  const controller = new AbortController();
  const reviewStartedAt = Date.now();
  core.reviewAbortController = controller;
  try {
    const result = await reviewer({ ctx, goal: cloneGoal(goal), settings: loadGoalSettings(ctx.cwd), latestUserDecisions, recentWork: opts.reason, signal: controller.signal });
    recordGoalDiagnostic(ctx, {
      type: "progress_review", stage: "client-review-result-not-served-model-proof", goalId: goal.id,
      model: result.model, effort: result.effort, tokensUsed: result.tokensUsed ?? 0,
      decision: result.decision?.disposition ?? "unavailable", evidence: result.decision?.evidence.slice(0, 4), error: result.error,
      durationMs: Math.min(86_400_000, Math.max(0, Date.now() - reviewStartedAt)),
    });
    if (result.tokensUsed) core.accountProgress(ctx, { completedTurnTokens: result.tokensUsed, goalId: goal.id, operationToken });
    // Reconcile authoritative disk state before applying any reviewer effect.
    // The focus token catches away-and-back focus changes; the structural scope
    // catches edited objectives/contracts/tasks; the input epoch catches a new
    // explicit instruction that does not itself change focus.
    const reconciled = core.reconcileFocusedGoalFromDisk?.(ctx) ?? true;
    const currentAfterReview = core.state.goal;
    if (!reconciled || !core.isFocusedOperationCurrent(operationToken) || core.focusedGoalId !== goal.id || !core.isActionableContinuationGoal(goal.id)
      || core.userDecisionEpoch !== userDecisionEpoch
      || !currentAfterReview || currentAfterReview.continuation?.wake || currentAfterReview.continuation?.hold || goalReviewScope(currentAfterReview, latestUserDecisions) !== scope) {
      return { ...result, error: "Progress review became stale; no goal state was changed." };
    }
    if (!result.decision) {
      const diagnostic = redactDiagnosticText(result.error ?? "no decision");
      if (diagnostic.includes("disabled by user-owned")) {
        core.runtime.retainContinuationHold?.(ctx, goal, scope, "The independent reviewer is disabled by the user's settings.", ["Reviewer settings disabled independent admission; completion is not proven."], admissionKey);
      } else {
        core.runtime.recordProgressReviewFailure(ctx, goal, diagnostic, scope, admissionKey);
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
    if (decision.disposition === "hold" && decision.hold) {
      const held = core.runtime.retainContinuationHold?.(ctx, currentGoal, postTaskScope, redactDiagnosticText(decision.hold.reason), decision.hold.evidence.map((item) => redactDiagnosticText(item)), goalHoldAdmissionKey(currentGoal, ctx, core.pi.getThinkingLevel?.()));
      core.pi.sendMessage({ customType: "pi-goal-review-result", content: held
        ? `Review placed the active goal on a quiet incomplete hold.\nReason: ${decision.hold.reason}`
        : "Review hold could not be persisted; completion remains NOT PROVEN.", display: true, details: goalDetails(core.state.goal) }, { triggerTurn: false });
      return result;
    }
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
    const instruction = [decision.nextAction, `Expected observation: ${decision.expectedObservation}`, `Decision impact: ${decision.decisionImpact}`].join("\n");
    if (core.runtime.retainReviewInstruction(ctx, currentGoal, postTaskScope, redactDiagnosticText(instruction, 2_000))) core.queueContinuation(ctx, true);
    return result;
  } finally {
    if (core.reviewAbortController === controller) core.reviewAbortController = null;
    core.runtime.endProgressReview(goal.id);
  }
}

export function reviewReceipt(result: GoalReviewResult): string {
  return result.decision ? `Review: ${result.decision.summary}\nNext: ${result.decision.nextAction}` : `Review unavailable: ${result.error ?? "not proven"}`;
}

