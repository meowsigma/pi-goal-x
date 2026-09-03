# Continue Through Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task has an Acceptance Contract; do not mark a task complete until its Quality Gate review returns PASS.

**Goal:** Stop treating restatement as goal death. Auto-continue stays on with escalating research/attempt prompts; create/tweak always start; empty history is scoped to the current goal.

**Architecture:** Replace the `agent_end` circuit-open `return` with a coach prompt + `queueContinuation`. Scope `countTrailingNoProgressRuns` to entries after the current goal’s focus marker. Create/tweak/focus keep `armFocusedContinuation` / `queueContinuation(..., true)` unconditional.

**Tech Stack:** TypeScript pi-goal-x extension events, node:test goldens.

**Spec:** `docs/superpowers/specs/2026-09-02-continue-through-blockers-design.md`

## Files

- Modify: `extensions/goal-events.ts`
- Modify: `extensions/goal-tool-names.ts` (`countTrailingNoProgressRuns` goal-scoped)
- Modify: `extensions/prompts/goal-prompts.ts` (coach copy 1/2/3+)
- Modify: `tests/goal-stale-continuation-golden.test.ts`
- Modify: `tests/goal-tool-names.test.ts`
- Modify: `CHANGELOG.md`, `package.json`

### Task 1: Coach instead of kill switch

**Files:**
- Modify: `extensions/goal-events.ts` (`agent_end` no-progress branch)
- Modify: `extensions/prompts/goal-prompts.ts`
- Test: `tests/goal-stale-continuation-golden.test.ts`

**Acceptance Contract:**
- User-visible behavior: Three text-only turns still auto-continue with coach prompts; no yellow halt; no `pi-goal:no-progress-circuit-open`.
- Wiring proof command: `node --experimental-strip-types --test tests/goal-stale-continuation-golden.test.ts`
- Expected output: former “three consecutive no-progress opens circuit” test now asserts 3 checkpoints queued, no halt notify, recovery text 1 then 2 then dual-sided packet.
- Test-quality proof: fails on 0.30.18 because `agent_end` returns without queueing on turn 3.
- Regression proof command: same file — child/`bg_run` goldens still pass.
- Failure this catches: Kalshi/Lumeance restatement halt.

- [ ] Write failing goldens for coach-not-halt
- [ ] Run and confirm they fail on the circuit `return`
- [ ] Remove circuit-open halt; inject escalating `noProgressRecoveryPrompt`; always queue
- [ ] Focused tests pass
- [ ] Commit

### Task 2: Create/tweak always start; empty count is goal-scoped

**Files:**
- Modify: `extensions/goal-tool-names.ts`
- Modify: `extensions/goal-events.ts` (`session_start` / compact / tree)
- Test: `tests/goal-stale-continuation-golden.test.ts`, `tests/goal-tool-names.test.ts`

**Acceptance Contract:**
- User-visible behavior: A new or tweaked goal in a session with three prior empty turns still gets its first continuation. Reload of the *same* goal after three restatements continues with the next coach prompt, not silence.
- Wiring proof command: `node --experimental-strip-types --test tests/goal-stale-continuation-golden.test.ts tests/goal-tool-names.test.ts`
- Expected output: “new goal after latched history still queues”; “reload after current-goal restatements continues with coach 3+”.
- Test-quality proof: fails if `countTrailingNoProgressRuns` is session-wide.
- Regression proof command: `npm test`
- Failure this catches: PolyEdge create/tweak sitting at `running` with auto-continue on and no agent turn.

- [ ] Failing tests for goal-scoped trailing count + create/tweak start
- [ ] Scope count to after current `pi-goal-focus` / goal id marker; create/tweak always `queueContinuation(..., true)`
- [ ] `npm test`, `npm run check`, `npm run lint`
- [ ] Version 0.30.19, changelog, commit
