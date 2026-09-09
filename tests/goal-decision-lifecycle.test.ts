import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGoalCore } from "../extensions/goal-state.ts";
import { registerGoalEvents } from "../extensions/goal-events.ts";
import { createGoal, goalFocusDetails, type GoalRecord } from "../extensions/goal-record.ts";
import { buildGoalProgressReviewPrompt, runGoalProgressReviewFlow, type GoalReviewResult } from "../extensions/goal-review.ts";
import { invalidateGoalPoolCache, readActiveGoalFiles, writeActiveGoalFile } from "../extensions/storage/goal-files.ts";

const holdResult: GoalReviewResult = { output: "held", model: "faux/reviewer", effort: "high", tokensUsed: 7, decision: {
  disposition: "hold", summary: "No discriminating observation is available.", nextAction: "Await changed evidence.",
  evidence: ["The pending criterion has no current observation."], completedTasks: [],
  hold: { reason: "No justified next action.", evidence: ["The dependency is unavailable."] },
} };

function fixture(result: GoalReviewResult = holdResult) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-decision-lifecycle-"));
  mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
  const entries: any[] = [];
  const sent: any[] = [];
  const reviews: any[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const bus = new Map<string, Array<(event: any) => void>>();
  const emitBus = (name: string, event: any) => { for (const handler of bus.get(name) ?? []) handler(event); };
  let systemPrompt = "base";
  const pi = {
    events: { on: (name: string, handler: (event: any) => void) => bus.set(name, [...(bus.get(name) ?? []), handler]), emit: emitBus },
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: unknown) => sent.push(message), getThinkingLevel: () => "high",
    getActiveTools: () => [], setActiveTools() {}, registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
  };
  const ctx = {
    cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    model: { provider: "faux", id: "executor" }, getSystemPrompt: () => systemPrompt,
    sessionManager: { getBranch: () => entries, getCwd: () => cwd, getSessionId: () => "decision-test" },
    ui: { notify() {}, setStatus() {}, setWidget() {}, onTerminalInput: () => () => {} },
  } as unknown as ExtensionContext;
  let core = createGoalCore(pi as never, { runProgressReviewer: async (args) => { reviews.push(args); return result; } });
  core.setGoal(writeActiveGoalFile(ctx, createGoal({ objective: "Verify the unresolved criterion", autoContinue: true, sisyphus: false })), ctx);
  entries.push({ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(core.state.goal!.id, "created") });
  core.clearContinuationState();
  registerGoalEvents(core);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  const before = async (text = "continue", source = "extension") => {
    await emit("input", { text, source });
    const prompt = await emit("before_agent_start", { prompt: text, systemPrompt: "base" });
    systemPrompt = prompt?.systemPrompt ?? "base";
    return systemPrompt;
  };
  const request = async (messages: any[] = []) => (await emit("context", { messages }))?.messages ?? messages;
  const settle = async (text = "No new evidence.") => {
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "end_turn", content: [{ type: "text", text }] }] });
    await emit("agent_settled");
  };
  const cycle = async (text?: string) => { await before(); await emit("agent_start"); await settle(text); };
  const mutate = (update: (goal: GoalRecord) => GoalRecord) => {
    const outcome = core.goalService.apply(ctx, { focusToken: core.focusedOperationToken(core.state.goal!.id), mutate: update });
    assert.equal(outcome.ok, true);
  };
  const disk = () => { invalidateGoalPoolCache(); return readActiveGoalFiles(ctx).find((g) => g.id === core.state.goal?.id); };
  return {
    cwd, ctx, entries, sent, reviews, emit, emitBus, before, request, settle, cycle, mutate, disk,
    get core() { return core; },
    async hold() { await runGoalProgressReviewFlow(core, ctx); assert.ok(core.state.goal?.continuation?.hold); },
    async reload() {
      core.runtime.disposeAuditRetryTimers(); core.clearContinuationState();
      core = createGoalCore(pi as never, { runProgressReviewer: async (args) => { reviews.push(args); return result; } });
      registerGoalEvents(core); await emit("session_start", { reason: "reload" });
    },
    close() { core.runtime.disposeAuditRetryTimers(); core.clearContinuationState(); rmSync(cwd, { recursive: true, force: true }); },
  };
}

test("held status queries survive reload; only a genuine new instruction clears the hold", async () => {
  const f = fixture();
  try {
    await f.hold(); await f.reload();
    for (const text of ["status?", "Do not change the goal", "Please do not resume the goal", "What does /goal-resume do?"]) {
      const prompt = await f.before(text, "interactive");
      assert.match(prompt, /CONTINUATION HOLD/, text);
      assert.equal(f.disk()?.status, "active");
      assert.ok(f.disk()?.continuation?.hold, text);
    }
    await f.before("Inspect the newly provided result and compare it with the previous failure.", "interactive");
    assert.equal(f.disk()?.continuation?.hold, undefined);
  } finally { f.close(); }
});

test("request context replaces stale lifecycle within a run for pause, budget, and unfocus", async () => {
  const f = fixture();
  try {
    await f.before();
    let messages = await f.request([{ role: "assistant", content: "Historical goal is paused" }]);
    assert.match(JSON.stringify(messages), /pi_goal_lifecycle_snapshot.*status=\\"active\\"/);
    for (const status of ["paused", "budget_limited"] as const) {
      f.mutate((g) => ({ ...g, status, autoContinue: false }));
      messages = await f.request(messages);
      const frames = messages.filter((m: any) => m.customType === "pi-goal-current-lifecycle");
      assert.equal(frames.length, 1);
      assert.match(frames[0].content, new RegExp(`status="${status}"`));
      assert.doesNotMatch(frames[0].content, /status="active"/);
    }
    f.core.setGoal(null, f.ctx);
    messages = await f.request(messages);
    assert.match(JSON.stringify(messages), /unfocused/);
  } finally { f.close(); }
});

test("only an unproductive present-tense false pause triggers one reconciliation", async () => {
  const f = fixture();
  try {
    await f.cycle("The goal is not paused.");
    assert.equal(f.reviews.length, 0);
    await f.cycle("The goal is paused.");
    assert.equal(f.reviews.length, 1);
    assert.match(f.reviews[0].recentWork, /paused.*ACTIVE|ACTIVE.*paused/i);
    await f.cycle("The goal is paused.");
    assert.equal(f.reviews.length, 1);
  } finally { f.close(); }
});

test("productive or historical pause prose is not a lifecycle contradiction", async () => {
  const f = fixture();
  try {
    await f.before(); await f.emit("agent_start");
    await f.emit("tool_call", { toolName: "write", toolCallId: "artifact", input: { path: "result.txt", content: "done" } });
    await f.settle("Yesterday the goal was paused. It is active now.");
    assert.equal(f.reviews.length, 0);
    f.mutate((g) => ({ ...g, status: "paused", autoContinue: false }));
    await f.cycle("The goal is paused.");
    assert.equal(f.reviews.length, 0);
    assert.equal(f.disk()?.status, "paused");
  } finally { f.close(); }
});

test("status cycles and false-paused prose never displace an external future wake", async () => {
  const f = fixture();
  try {
    f.mutate((g) => ({ ...g, continuation: {
      scope: "future", instruction: "Recheck the pending dependency", executionRetries: 0, reviewFailures: 0,
      wake: { id: "future-wake", kind: "external_wait", at: "2999-01-01T00:00:00.000Z", reason: "pending", evidence: ["observed pending"] },
    } }));
    for (const prose of ["The goal is not paused.", "The goal is paused.", "Still waiting."]) await f.cycle(prose);
    assert.equal(f.reviews.length, 0);
    assert.equal(f.disk()?.continuation?.wake?.id, "future-wake");
    assert.equal(f.disk()?.continuation?.hold, undefined);
    assert.equal(await runGoalProgressReviewFlow(f.core, f.ctx), null, "direct review admission also respects the future owner");
  } finally { f.close(); }
});

test("Goal defers secondary transport recovery and holds only a matched native cap outcome", async () => {
  const f = fixture();
  try {
    await f.before(); await f.emit("agent_start");
    f.emitBus("pi-retry:state", { effectiveEnabled: true });
    f.emitBus("pi-retry:started", { retryId: 1 });
    await f.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "503 Service unavailable" }] });
    await f.emit("agent_settled");
    assert.equal(f.core.runtime.networkErrorRetryPendingFor(f.core.state.goal!.id), false);
    assert.equal(f.disk()?.continuation?.hold, undefined, "authorized traffic retries do not exhaust a competing Goal counter");
    f.emitBus("pi-retry:cancelled", { retryId: 2, reason: "bounded_recovery_exhausted", attempts: 3 });
    assert.equal(f.disk()?.continuation?.hold, undefined, "foreign retry outcome cannot change the goal");
    f.emitBus("pi-retry:cancelled", { retryId: 1, reason: "bounded_recovery_exhausted", attempts: 3 });
    assert.ok(f.disk()?.continuation?.hold);
    await f.reload();
    assert.ok(f.disk()?.continuation?.hold);
  } finally { f.close(); }
});

test("a provider retry cap cannot overwrite a future wake or a changed goal scope", async () => {
  const f = fixture();
  try {
    await f.before();
    f.emitBus("pi-retry:started", { retryId: 1 });
    f.mutate((goal) => ({ ...goal, verificationContract: "New binding scope" }));
    f.emitBus("pi-retry:cancelled", { retryId: 1, reason: "bounded_recovery_exhausted", attempts: 3 });
    assert.equal(f.disk()?.continuation?.hold, undefined);
    f.emitBus("pi-retry:started", { retryId: 2 });
    f.mutate((goal) => ({ ...goal, continuation: { scope: "wait", instruction: "wait", executionRetries: 0, reviewFailures: 0, wake: { id: "owned-wait", at: new Date(Date.now() + 60_000).toISOString(), kind: "external_wait", reason: "future dependency", evidence: ["not ready"] } } }));
    f.emitBus("pi-retry:cancelled", { retryId: 2, reason: "bounded_recovery_exhausted", attempts: 3 });
    assert.equal(f.disk()?.continuation?.wake?.id, "owned-wait");
    assert.equal(f.disk()?.continuation?.hold, undefined);
  } finally { f.close(); }
});

test("legacy exhausted review state migrates to a quiet hold before reload can checkpoint", async () => {
  const f = fixture();
  try {
    f.mutate((goal) => ({ ...goal, continuation: { scope: "legacy", instruction: "Earlier advice", reviewFailures: 3, executionRetries: 0 } }));
    await f.reload();
    assert.ok(f.disk()?.continuation?.hold);
    assert.equal(f.disk()?.status, "active");
    assert.equal(f.core.runtime.continuationPendingFor(f.core.state.goal!.id), false);
  } finally { f.close(); }
});

test("a configured transient retry cap becomes a durable hold rather than resetting on reload", async (t) => {
  const f = fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    writeFileSync(path.join(f.cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ networkRecovery: { maxAttempts: 1, maxDelayMs: 1000 } }));
    await f.before(); await f.emit("agent_start");
    const error = { messages: [{ role: "assistant", stopReason: "error", errorMessage: "503 Service unavailable" }] };
    await f.emit("agent_end", error); await f.emit("agent_settled");
    assert.equal(f.core.runtime.networkErrorRetryPendingFor(f.core.state.goal!.id), true);
    await f.emit("agent_settled");
    assert.equal(f.disk()?.continuation?.hold, undefined, "duplicate settlement must not misidentify a pending retry as exhaustion");
    t.mock.timers.tick(10_000);
    await f.emit("agent_start"); await f.emit("agent_end", error); await f.emit("agent_settled");
    assert.match(f.disk()?.continuation?.hold?.reason ?? "", /exhausted/);
    await f.reload();
    assert.ok(f.disk()?.continuation?.hold);
    assert.equal(f.core.runtime.continuationPendingFor(f.core.state.goal!.id), false);
  } finally { f.close(); }
});

test("terminal provider failures cannot enter Goal's separate network recovery or restart on reload", async () => {
  for (const errorMessage of ["503 upstream request failed: 403 You have run out of credits or need a subscription", "503: Not enough credits", "503: This model was ZAI:GLM-4.5-Air", "402 Payment required"]) {
    const f = fixture();
    try {
      await f.before(); await f.emit("agent_start");
      await f.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage }] });
      await f.emit("agent_settled");
      assert.ok(f.disk()?.continuation?.hold, errorMessage);
      assert.equal(f.disk()?.continuation?.wake, undefined);
      await f.reload();
      assert.ok(f.disk()?.continuation?.hold);
      assert.equal(f.core.runtime.continuationPendingFor(f.core.state.goal!.id), false);
    } finally { f.close(); }
  }
});

test("first reviewer outage reaches a durable honest hold through real settlement", async () => {
  const f = fixture({ output: "", error: "provider unavailable" });
  try {
    await f.cycle(); await f.cycle();
    assert.equal(f.reviews.length, 1);
    assert.ok(f.disk()?.continuation?.hold);
    assert.equal(f.disk()?.continuation?.wake, undefined);
    assert.equal(f.disk()?.status, "active");
    await f.reload(); await f.cycle(); await f.cycle();
    assert.equal(f.reviews.length, 1);
  } finally { f.close(); }
});

test("busy cycles reach review with actual redacted outcomes, then remain quietly held", async () => {
  const f = fixture();
  try {
    await f.before(); await f.emit("agent_start");
    for (let n = 0; n < 12; n += 1) {
      await f.emit("tool_call", { toolName: "write", toolCallId: `busy-${n}`, input: { path: "status.md", content: `status ${n}` } });
      await f.emit("tool_execution_end", { toolName: "write", toolCallId: `busy-${n}`, result: { content: [{ type: "text", text: 'Status persisted. {"api_key":"JSONSECRET"}\nAuthorization: Bearer BEARERSECRET' }] } });
    }
    await f.settle();
    assert.equal(f.reviews.length, 1);
    assert.match(f.reviews[0].recentWork, /write completed/);
    assert.doesNotMatch(f.reviews[0].recentWork, /JSONSECRET|BEARERSECRET/);
    assert.ok(f.disk()?.continuation?.hold);
    await f.cycle(); assert.equal(f.reviews.length, 1);
  } finally { f.close(); }
});

test("retained advice and its decision rationale are independent of recent tool evidence", async () => {
  const f = fixture({ output: "work", decision: { disposition: "work", summary: "One discriminator remains", nextAction: "Compare the two captures", expectedObservation: "Locate the first divergent token", decisionImpact: "Choose between request drift and backend divergence", evidence: ["Captures exist"], completedTasks: [] } });
  try {
    await runGoalProgressReviewFlow(f.core, f.ctx);
    const instruction = f.disk()?.continuation?.instruction ?? "";
    assert.match(instruction, /first divergent token/);
    assert.match(instruction, /backend divergence/);
    const prompt = buildGoalProgressReviewPrompt({ goal: f.core.state.goal!, recentWork: "Status file rewritten." });
    assert.match(prompt, /Compare the two captures/);
    assert.match(prompt, /first divergent token/);
    assert.match(prompt, /Status file rewritten/);
  } finally { f.close(); }
});

test("relevant configuration or scope change re-admits held review, unchanged status does not", async () => {
  const f = fixture();
  try {
    await f.hold();
    await f.request(); assert.ok(f.disk()?.continuation?.hold);
    writeFileSync(path.join(f.cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ provider: "changed-reviewer", model: "different-model", thinkingLevel: "high" }));
    await f.request(); assert.equal(f.disk()?.continuation?.hold, undefined);
    await f.hold();
    f.mutate((g) => ({ ...g, objective: "A genuinely changed criterion" }));
    await f.request(); assert.equal(f.disk()?.continuation?.hold, undefined);
    await f.hold();
    f.mutate((g) => ({ ...g, status: "paused", autoContinue: false, objective: "Another change" }));
    await f.request(); assert.ok(f.disk()?.continuation?.hold);
    assert.equal(f.disk()?.status, "paused");
  } finally { f.close(); }
});

test("only fresh matched goal/session-owned terminal receipts re-admit a hold, once", async () => {
  const f = fixture();
  const notice = (id: string, role = "custom") => ({ role, customType: "background-task-notification", details: { id, status: "completed" }, content: `<background-task-notification><task-id>${id}</task-id><status>completed</status></background-task-notification>` });
  try {
    await f.before(); await f.emit("agent_start");
    await f.emit("tool_call", { toolName: "bg_run", toolCallId: "launch", input: { name: "fixture", command: "fixture" } });
    await f.emit("tool_execution_end", { toolName: "bg_run", toolCallId: "launch", result: { details: { task: { id: "owned-1", status: "running" } }, content: [{ type: "text", text: "Started" }] } });
    await f.hold(); await f.reload();
    await f.request([notice("foreign-1")]); assert.ok(f.disk()?.continuation?.hold);
    await f.request([notice("owned-1", "user")]); assert.ok(f.disk()?.continuation?.hold);
    await f.request([notice("owned-1")]); assert.equal(f.disk()?.continuation?.hold, undefined);
    assert.equal(f.disk()?.status, "active");
    await f.hold(); await f.request([notice("owned-1")]); assert.ok(f.disk()?.continuation?.hold, "duplicate notice is not new evidence");
  } finally { f.close(); }
});

test("diagnostics are bounded, redacted, stage-labelled and include selected route/usage", async () => {
  const f = fixture({ ...holdResult, error: 'Authorization: Bearer ERRORSECRET', decision: { ...holdResult.decision!, evidence: ['{"api_key":"REVIEWSECRET"}'] } });
  try {
    await f.emit("session_start", { reason: "start" });
    await f.hold();
    const file = path.join(f.cwd, ".pi", "goals", "diagnostics.json");
    assert.equal(existsSync(file), true);
    const first = readFileSync(file, "utf8");
    assert.doesNotMatch(first, /ERRORSECRET|REVIEWSECRET/);
    assert.match(first, /progress_review/); assert.match(first, /tokensUsed/);
    assert.match(first, /"sourceHash":"[a-f0-9]{64}"/);
    for (let n = 0; n < 75; n += 1) {
      await f.request();
      await f.emit("before_provider_request", { payload: { model: "faux", instructions: "SECRET_PROMPT", messages: [], headers: { Authorization: "Bearer HEADERSECRET" } } });
    }
    const raw = readFileSync(file, "utf8");
    const records = JSON.parse(raw);
    assert.ok(records.length <= 64);
    assert.ok(raw.length < 262_144);
    assert.doesNotMatch(raw, /SECRET_PROMPT|HEADERSECRET/);
    assert.match(raw, /before_provider_request/);
    assert.match(raw, /promptHash/);
    assert.match(raw, /not-final-wire/);
  } finally { f.close(); }
});
