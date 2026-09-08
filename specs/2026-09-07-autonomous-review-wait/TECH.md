# Autonomous Review and Deferred Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Use TDD and retain the failing regression evidence. Do not mark acceptance complete from prompt assertions or an unexecuted fixture.

**Goal:** Replace unbounded ordinary status checkpoints with actual whole-goal review and goal-owned autonomous rechecks.

**Architecture:** Keep the five model tools and the existing GoalCore/GoalService/GoalRuntime boundaries. Add a progress-review flow using the proven isolated completion-auditor session machinery, without the completion task gate. Persist deferred continuation state in the authoritative goal record, not solely best-effort ledger events. GoalRuntime owns its timer and all normal continuation admission; final approval remains in runGoalCompletionFlow. Deferred wake retirement is a durable lease handoff: dispatch occurs only after the authoritative write succeeds; a failed retirement retains the persisted wake and emits a bounded diagnostic without dispatch.

**Tech stack:** Existing TypeScript, Node timers/crypto, Pi SDK, TypeBox, node:test and existing loader fixtures. No new dependency or scheduler.

## Files and responsibilities

- `extensions/goal-auditor.ts`: shared read-only session construction, complete task/contract rendering, trusted-origin decision context, strict structured progress-review result, terminal error/abort validation, usage reporting. Preserve completion verdict semantics.
- `extensions/goal-review.ts` (new): whole-goal review orchestration and decision application, stable scope fingerprint, evidence-checked task updates through GoalService, normal completion handoff, runtime-owned recovery/wait admission.
- `extensions/goal-record.ts`, `extensions/storage/goal-files.ts`: validated optional durable continuation/review state, backward-compatible read/clone/serialization.
- `extensions/goal-runtime.ts`: one review-in-flight guard, owned deferred wake, quiet admission, generation-safe disposal/restoration. Existing ordinary/audit/delegated control remains intact.
- `extensions/goal-events.ts`, `extensions/goal-state.ts`, `extensions/goal.ts`: real lifecycle wiring, dependencies for deterministic tests, current-turn waiting/review guidance, cancellation, user input, focus/load restoration, budget handling.
- `extensions/goal-completion.ts`: task-gate denial requests progress review rather than counting as work; seed final auditor with actual current decision/evidence context.
- `extensions/goal-task-tools.ts`: only extract/reuse task-completion validation if needed; no alternate weaker completion path.
- `extensions/goal-tool-names.ts`: narrow standalone clock-probe exclusion, including history reconstruction with real arguments.
- `extensions/goal-format.ts` and `extensions/prompts/goal-prompts.ts`: inspection/authoritative guidance for actual scheduled state; no extra goal tool or model-owned pause.
- Existing unit/integration tests plus new `tests/goal-review.test.ts`, `tests/goal-deferred-continuation.test.ts`; `tests/.test-manifest.json`, README, CHANGELOG and MILESTONES updated through their official mechanisms.
- NQA changes only if an actual both-order regression proves its active guidance overrides authoritative waiting. No BTW source change is planned.

## Decision contract

Use a bounded validated structured submission from the isolated reviewer, not a marker found inside arbitrary prose or an executor completion summary. The shape is:

```ts
export interface GoalReviewDecision {
  disposition: "work" | "audit" | "wait";
  summary: string;
  nextAction: string;
  evidence: string[];
  completedTasks: Array<{ taskId: string; evidence: string }>;
  wait?: { until: string; criterion: string; observedDependency: string };
}
```

Require nonempty summary/action, bounded fields/arrays, known unique task ids, nonempty evidence for every task completion, and nonempty wait evidence/criterion/dependency. Wait requires an unambiguous valid future UTC timestamp and no independently actionable remaining work. The reviewer must inspect evidence rather than adopt an executor-authored time. `audit` is an instruction to invoke the final audit, never approval. Invalid output, conflicting submissions, provider errors, truncated/aborted terminal responses, and unavailable configuration are errors, not decisions. Do not enable the optional blocker Oracle or substitute its configured model.

The review session uses the completion auditor's explicitly configured model (or its existing documented parent-model default) and parent auth/modelRuntime. Force the empty resource loader/read-only tool profile for review: read/grep/find/ls plus the structured in-memory submission tool, no ambient extensions, shell, writes, MCP, or nested workers. If auditor use is explicitly disabled/skipped, do not silently buy a new auditor; surface this and use labelled quiet execution recovery while preserving existing user-owned completion settings.

### Current authority and evidence

Collect bounded goal-scoped branch evidence from the last matching focus boundary and native input-handler decision records. The current host API provides no verifiable paired ask_user provenance, so dialog ids alone are rejected rather than treated as authority. Validate the owned record version/kind/source/goal/focus shape; ordinary role:user provenance, synthetic user-message text, assistant prose, background notifications, and forged/unpaired tool results are not authority. Retain source labels and delimit decision data from task/evidence context. Render all task verification contracts and evidence, not titles alone. Provide the current goal file and session reference for read-only inspection when bounded context omits material detail. Arbitrary loaded extensions share full Node/PiAPI privileges and can alter goals or forge owned records; this is a trusted-extension boundary, not cryptographic isolation. The original objective and later user amendments are distinct sources; do not silently rewrite or weaken either.

### Durable state and receipt

Keep durable optional state together on GoalRecord; a concrete working shape is:

```ts
export interface GoalContinuationState {
  scope: string; // hash of objective/contracts/tasks + user-decision boundary, NOT usage/revision/time
  instruction: string;
  executionRetries: number;
  reviewFailures: number;
  wake?: {
    id: string;
    at: string;
    kind: "external_wait" | "execution_recovery" | "review_recovery";
    reason: string;
    evidence: string[];
  };
}
```

Use the repository's record normalization conventions for names/validation if an equivalent existing field fits; do not store this in pauseReason or replace goal status. GoalService's successful authoritative write is required before a scheduled receipt. A ledger append alone is insufficient because it is best-effort. Include the persisted wake id/time/action/kind and the in-process-runtime limitation in the receipt.

Only the current goal/focus epoch/contract-and-user-decision scope may apply review effects. Usage-only changes must not invalidate them. Any newer explicit user input during review cancels that review result, without pausing the goal. The same check runs before task effects, final audit, and wake dispatch.

## Task 1: Reproduce and isolate the existing failure

**Acceptance Contract**
- User-visible behavior: the original incident shape is represented without private content or live calls.
- Wiring proof: `node scripts/run-unit-tests.mjs integration` with the actual extension handler fixture.
- Expected behavior: before repair, a test requiring a progress reviewer invocation after two complete empty cycles fails, while capturing repeated checkpoints.
- Test quality: run agent_start → before_agent_start → tool_call/result where present → turn_end → agent_end → agent_settled. A seeded counter or matching prompt is insufficient.
- Regression proof: `npm test` and explicit-source `npm run test:integration` baseline.
- Failure caught: the comment says no-progress is gated, but the actual ordinary agent_end/settled path requeues regardless of progress.

- [ ] Extend the existing integration harness with a separate `runProgressReviewer` dependency and calls captured independently from `runCompletionAuditor`. Keep temporary cwd/settings and shutdown cleanup.
- [ ] Add a synthetic pending verification task and two empty checkpoint cycles. Assert zero final completion calls and one actual progress-review invocation; record RED output.
- [ ] Add changing `date -u '+%Y-%m-%d %H:%M:%S UTC'` results between empty cycles. Assert they cannot reset the incident's no-work counter. Retain compound shell/real observational work as productive.

Representative assertions inside the existing harness:

```ts
assert.equal(progressReviews.length, 1);
assert.equal(completionAudits.length, 0);
assert.equal(storedGoal.status, "active");
assert.equal(storedGoal.taskList!.tasks[0]!.status, "pending");
```

## Task 2: Implement the isolated whole-goal reviewer

**Acceptance Contract**
- User-visible behavior: review really examines unfinished/current requirements without claiming final completion.
- Wiring proof: a real createAgentSession with an in-memory mock provider and temporary artifact, not a mock createSession that simply accepts wrong SDK arguments.
- Expected behavior: the mock provider performs a real read then submits a validated decision; only read-only tools are exposed; parent modelRuntime and abort signal work.
- Test quality: remove reviewer invocation, expose bash, inject an invalid result, or hide a pending task contract and the respective assertion fails.
- Regression proof: `npm test`, including existing goal auditor/provider tests.
- Failure caught: prompt-only review, invalid SDK construction, inherited write/network tools, stale approval markers and missing actual authority.

- [ ] Define and validate GoalReviewDecision with bounded schema/semantic checks; add invalid wait, duplicate/unknown task, unpaired authority, provider error, conflicting/absent result, abort and truncation tests first.
- [ ] Reuse the working auditor session setup for a progress-review purpose and structured submission. Preserve the final completion auditor's strict approval/rejection result and its current configuration semantics.
- [ ] Render task contracts/evidence and current source-labelled user decisions for both progress review and final audit. Do not grant authority to arbitrary tool data.
- [ ] Report consumed tokens in review results, including failed/cancelled results, so automatic nested work is not a hidden budget bypass. Charge the original goal only; never charge a newly focused goal for a stale result.

## Task 3: Durable quiet wake and single-owner admission

**Acceptance Contract**
- User-visible behavior: one actual automatic recheck replaces repeated waiting replies.
- Wiring proof: `npm test` with fake-clock GoalRuntime tests plus the real extension lifecycle fixture.
- Expected behavior: persist receipt → no ordinary wake before deadline → one recheck at deadline; restore from disk behaves identically; overdue restored wait runs once.
- Test quality: bypassing the admission check in either queueContinuation or its timer callback causes duplicate/early wake failures.
- Regression proof: existing network recovery, audit retry/exhaustion, stale checkpoint, pause/resume/focus and delegated ownership tests.
- Failure caught: fake scheduling, timer overflow, reload loss, duplicate owners, stale callbacks and silent goal pausing.

- [ ] Add validated optional continuation state to GoalRecord and round-trip tests. Old records must remain unchanged/readable; invalid state must not be announced as scheduled.
- [ ] Add GoalRuntime review/deferred admission and a single owned timer. Check both scheduling and dispatch; clear generation on cancellation. Clamp individual Node timeout intervals to 2^31−1 ms and re-arm without premature model wake.
- [ ] Persist a wait through GoalService before arming/announcing it. Wake dispatch reconciles disk, verifies the same wake id/scope and active focus, retires the persisted lease safely, and queues one checkpoint containing/recovering the specific recheck instruction.
- [ ] Restore on session load/focus, retain safe dormant state when another goal owns focus, cancel on explicit pause/cancel/completion/budget/shutdown. Explicit resume/tweak supersedes a wait; ordinary user status input does not erase a valid future lease.
- [ ] Report persistence/arming failures as NOT PROVEN and use bounded-rate recovery, never 'scheduled' with no timer. A transient persistence problem must not create 50ms retry I/O or LLM loops.

## Task 4: Wire review decisions to actual progress

**Acceptance Contract**
- User-visible behavior: bookkeeping can be resolved from verified evidence, genuine remaining work continues, and only the existing final auditor can complete the goal.
- Wiring proof: `PI_NQA_EXTENSION_PATH=/home/sigma/.pi/worktrees/pi-nqa-integration-repair/extensions/no-questions-asked.ts npm run test:integration`.
- Expected behavior: pending gate requests review; validated pending-task evidence is committed under the unchanged contract; audit disposition invokes normal completion; final disapproval/error stays incomplete; wait leaves the unfinished task pending.
- Test quality: inject contrary reviewer/final-auditor verdicts, stale focus, incomplete children, changed contracts and missing evidence. None can pass by status text alone.
- Regression proof: `npm test` and all integration tests.
- Failure caught: task-gate preventing any review, weakened task invariants, review approval bypass, old authorization, or audit races.

- [ ] Add `runGoalProgressReviewFlow(core, ctx)` in `goal-review.ts`. Capture the stable goal/user scope; obtain exclusive runtime review ownership; invoke reviewer; release in finally.
- [ ] At two no-progress agent_end cycles, request review for agent_settled instead of another ordinary checkpoint. A task-gated completion request sets denied/nonproductive credit and requests review, not a fake completion.

The settled branch must call the flow, not append a stronger prompt:

```ts
if (reviewGoalId && core.isActionableContinuationGoal(reviewGoalId)) {
  await runGoalProgressReviewFlow(core, ctx);
  return;
}
```

- [ ] Apply completedTasks through GoalService.updateTask using the same pending-only, evidence, child and focus validation as update_goal_task. Process children before parents or reject an invalid order safely; never complete skipped/already-complete tasks or alter their contracts.
- [ ] For audit, invoke runGoalCompletionFlow after rechecking current scope/budget/gates. Publish its real result; no invented approval. Because this call occurs AFTER the ordinary turn_end, extract/reuse the existing completion archival operation and invoke it after publishing the automatic result. Prove that an approved automatic audit archives/unfocuses without another executor turn, and that rejection/error/stale results cannot archive. Do not spoof runningGoalId or user input to bypass admission.
- [ ] For work, issue one immediate evidence-bearing follow-up instruction. If ignored with the same scope and no new meaningful work, retain that instruction and schedule quiet execution recovery using 5s → 30s → 2m → 10m capped backoff, rather than repeatedly buying the same review or ordinary checkpoint spam. No arbitrary terminal cutoff.
- [ ] For wait, persist/arm the justified external wait. For review infrastructure failure, retain a separate goal-scoped attempt count (initial + three retries), never reset it from clock/status or ordinary productive accounting. After exhaustion, retain diagnostics and allow bounded-rate independent execution recovery without more review-provider calls until genuine user/config/scope change.
- [ ] User abort/focus/new input/shutdown invalidates in-flight effects and stops the nested session. Do not reuse the completion audit's Escape 'bypass approval' path for a progress review.

## Task 5: Real-host regression and delivery evidence

**Acceptance Contract**
- User-visible behavior: the installed host wiring can review/wait without competing NQA wakes or breaking Escape/budget handling.
- Wiring proof: both commands below, plus the existing native Escape proof with explicit paths.
- Expected behavior: real loader tests execute in both NQA/goal orders, no skips; waiting has one wake owner; reviewers use real host APIs with a fake provider; no account/network mutations.
- Test quality: intentionally disconnect settled review dispatch or deferred admission once and show the incident regression fails before restoring it.
- Regression proof: check/lint/unit/integration/selfcheck and native Escape tests; existing release's failure cases remain assertions.
- Failure caught: synthetic-only success, implicit source fallback, stale lifecycle frames, uncounted nested costs or regressions in the previous repair.

```bash
npm run check
npm run lint
npm test
PI_NQA_EXTENSION_PATH=/home/sigma/.pi/worktrees/pi-nqa-integration-repair/extensions/no-questions-asked.ts npm run test:integration
PI_HOST_PACKAGE_ROOT=/home/sigma/.npm-global/lib/node_modules PI_NQA_EXTENSION_PATH=/home/sigma/.pi/worktrees/pi-nqa-integration-repair/extensions/no-questions-asked.ts npm run test:integration
PI_HOST_PACKAGE_ROOT=/home/sigma/.npm-global/lib/node_modules PI_BTW_EXTENSION_PATH=/home/sigma/.pi/worktrees/pi-learn-escape-repair/extensions/btw.ts node scripts/native-goal-btw-proof.mjs
node scripts/run-unit-tests.mjs --write-manifest
npm run test:selfcheck
git diff --check
```

- [ ] Exercise wait, actual due wake, reload, stale callbacks, focus away/back, explicit pause/resume, user input during review, disabled/unavailable reviewer, actual retry exhaustion, ignored work advice, budget reached by review and both loader orders.
- [ ] Update README/CHANGELOG and MILESTONES with exact executed proof, RED failures, limitations and remaining NOT PROVEN claims. Do not copy private transcripts into tracked files.
- [ ] Obtain independent read-only review of the diff and tests; fix meaningful findings and rerun affected proof. Parent must inspect the actual implementation and fresh validation before acceptance.
- [ ] Do not push, install, change user settings, modify live goals, bump unrelated package versions, or touch the protected BTW working change as part of worker execution.

## Limits of the proof

Fake-provider/fake-clock tests prove control flow and actual SDK wiring, not universal model reasoning or compliance. A valid wait does not prove future external success. In-process wake recovery does not promise execution while Pi is shut down. No real external account needs to be called to prove this repair.
