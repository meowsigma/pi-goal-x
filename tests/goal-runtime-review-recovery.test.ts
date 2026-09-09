import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GoalRuntime } from "../extensions/goal-runtime.ts";

class FakeClock {
  nowMs = 0;
  readonly timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  setTimeout = (callback: () => void, delay: number) => {
    const timer = { callback, delay, cancelled: false };
    this.timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    (timer as unknown as { cancelled: boolean }).cancelled = true;
  };
  now = () => this.nowMs;
  fire(index = 0): void {
    const timer = this.timers.splice(index, 1)[0];
    if (timer && !timer.cancelled) timer.callback();
  }
  advance(ms: number): void {
    this.nowMs += ms;
    const index = this.timers.findIndex((timer) => !timer.cancelled && timer.delay <= ms);
    if (index >= 0) this.fire(index);
  }
}
import type { GoalRecord } from "../extensions/goal-record.ts";

const ctx = {} as ExtensionContext;
const makeGoal = (): GoalRecord => ({
  id: "review-recovery-goal",
  objective: "Continue the work",
  status: "active",
  autoContinue: true,
  usage: { tokensUsed: 0, activeSeconds: 0 },
  sisyphus: false,
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
  continuation: { scope: "scope", instruction: "review", executionRetries: 0, reviewFailures: 0 },
});

test("first review failure holds immediately and explicit repeated reports retain diagnostics", () => {
  let goal = makeGoal();
  const runtime = new GoalRuntime({
    sendFollowUp() {},
    getGoal: () => goal,
    isActionable: (id) => id === goal.id && goal.status === "active" && goal.autoContinue,
    persistGoal: (next) => { goal = next; return true; },
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    runtime.recordProgressReviewFailure(ctx, goal, `provider failure ${attempt + 1}`, "scope");
    assert.ok(goal.continuation?.hold, "even the first failure is an honest hold");
    assert.equal(runtime.continuationPendingFor(goal.id), false);
  }
  assert.equal(goal.continuation?.reviewFailures, 3);
  assert.equal(goal.continuation?.wake, undefined);
  assert.ok(goal.continuation?.hold);
  assert.match(goal.continuation?.hold?.evidence.join(" ") ?? "", /provider failure 3/);
  runtime.disposeAuditRetryTimers();
});

test("activity does not clear retained advice or exhausted review admission", () => {
  let goal: GoalRecord = { ...makeGoal(), continuation: { ...makeGoal().continuation!, reviewFailures: 4, instruction: "Continue safe independent work." } };
  const runtime = new GoalRuntime({
    sendFollowUp() {}, getGoal: () => goal,
    isActionable: (id) => id === goal.id && goal.status === "active" && goal.autoContinue,
    persistGoal: (next) => { goal = next; return true; },
  });
  runtime.clearRetainedReviewInstruction(ctx, goal);
  assert.equal(goal.continuation?.reviewFailures, 4);
  assert.equal(goal.continuation?.instruction, "Continue safe independent work.");
  assert.equal(runtime.isProgressReviewExhausted(goal), true);
  runtime.disposeAuditRetryTimers();
});

test("wake scheduling fails closed when no authoritative persistence hook exists", () => {
  const runtime = new GoalRuntime({
    sendFollowUp() {},
    getGoal: () => makeGoal(),
    isActionable: () => true,
  });
  const goal = makeGoal();
  const state = {
    ...goal.continuation!,
    wake: { id: "wake-no-persist", at: new Date(Date.now() + 60_000).toISOString(), kind: "external_wait" as const, reason: "dependency", evidence: ["observed"] },
  };
  assert.equal(runtime.scheduleDeferredWake(ctx, goal, state), false);
  runtime.disposeAuditRetryTimers();
});

test("a failed wake retirement keeps the durable lease and does not dispatch early", () => {
  let goal: GoalRecord = {
    ...makeGoal(),
    continuation: {
      ...makeGoal().continuation!,
      wake: {
        id: "wake-1",
        at: "2026-09-06T23:59:59.999Z",
        kind: "external_wait" as const,
        reason: "dependency",
        evidence: ["observed"],
      },
    },
  };
  let writes = 0;
  let dispatched = 0;
  const failures: string[] = [];
  const clock = new FakeClock();
  clock.nowMs = Date.parse("2026-09-07T00:00:00.000Z");
  const runtime = new GoalRuntime({
    sendFollowUp() {},
    getGoal: () => goal,
    isActionable: (id) => id === goal.id && goal.status === "active" && goal.autoContinue,
    persistGoal: (next) => {
      writes += 1;
      if (writes > 1) return false;
      goal = next;
      return true;
    },
    onDeferredWake: () => { dispatched += 1; },
    onDeferredWakePersistenceFailure: (_ctx, _goal, message) => failures.push(message),
  }, clock);
  assert.equal(runtime.scheduleDeferredWake(ctx, goal, goal.continuation!), true);
  clock.fire();
  assert.equal(dispatched, 0);
  assert.equal(failures.length, 1);
  assert.equal(goal.continuation?.wake?.id, "wake-1");
  runtime.disposeAuditRetryTimers();
});

test("long deferred wakes re-arm after the timer clamp and dispatch exactly at due time", () => {
  const clock = new FakeClock();
  const due = 2_147_000_000 + 10_000;
  let goal: GoalRecord = { ...makeGoal(), continuation: { ...makeGoal().continuation!, wake: { id: "long", at: new Date(due).toISOString(), kind: "external_wait", reason: "dependency", evidence: ["observed"] } } };
  let dispatched = 0;
  const runtime = new GoalRuntime({
    sendFollowUp() {}, getGoal: () => goal,
    isActionable: (id) => id === goal.id && goal.status === "active" && goal.autoContinue,
    persistGoal: (next) => { goal = next; return true; },
    onDeferredWake: () => { dispatched += 1; },
  }, clock);
  assert.equal(runtime.scheduleDeferredWake(ctx, goal, goal.continuation!), true);
  assert.equal(clock.timers[0]?.delay, 2_147_000_000);
  clock.advance(2_147_000_000);
  assert.equal(dispatched, 0);
  assert.equal(clock.timers.length, 1);
  clock.advance(10_000);
  assert.equal(dispatched, 1);
  assert.equal(goal.continuation?.wake, undefined);
  runtime.disposeAuditRetryTimers();
});

test("stale replaced and cancelled wake callbacks cannot dispatch", () => {
  const clock = new FakeClock();
  let goal: GoalRecord = { ...makeGoal(), continuation: { ...makeGoal().continuation!, wake: { id: "old", at: "1970-01-01T00:00:00.000Z", kind: "external_wait", reason: "old", evidence: ["old"] } } };
  let dispatched = 0;
  const runtime = new GoalRuntime({
    sendFollowUp() {}, getGoal: () => goal, isActionable: () => true,
    persistGoal: (next) => { goal = next; return true; }, onDeferredWake: () => { dispatched += 1; },
  }, clock);
  assert.equal(runtime.scheduleDeferredWake(ctx, goal, goal.continuation!), true);
  const stale = clock.timers[0]!;
  runtime.cancelDeferredWake(goal.id);
  goal = { ...goal, continuation: { ...goal.continuation!, wake: { id: "new", at: "1970-01-01T00:00:00.000Z", kind: "external_wait", reason: "new", evidence: ["new"] } } };
  assert.equal(runtime.scheduleDeferredWake(ctx, goal, goal.continuation!), true);
  stale.callback();
  assert.equal(dispatched, 0);
  clock.fire(1);
  assert.equal(dispatched, 1);
  runtime.disposeAuditRetryTimers();
});

test("a reloaded deferred wake dispatches once and cancellation prevents it", () => {
  const clock = new FakeClock();
  let goal: GoalRecord = { ...makeGoal(), continuation: { ...makeGoal().continuation!, wake: { id: "reload", at: "1970-01-01T00:00:01.000Z", kind: "external_wait", reason: "dependency", evidence: ["observed"] } } };
  let dispatched = 0;
  const hooks = {
    sendFollowUp() {}, getGoal: () => goal, isActionable: () => true,
    persistGoal: (next: GoalRecord) => { goal = next; return true; }, onDeferredWake: () => { dispatched += 1; },
  };
  const first = new GoalRuntime(hooks, clock);
  first.restoreDeferredWake(ctx, goal);
  first.disposeAuditRetryTimers();
  const second = new GoalRuntime(hooks, clock);
  second.restoreDeferredWake(ctx, goal);
  clock.advance(1_000);
  assert.equal(dispatched, 1);
  assert.equal(goal.continuation?.wake, undefined);
  second.disposeAuditRetryTimers();
});
