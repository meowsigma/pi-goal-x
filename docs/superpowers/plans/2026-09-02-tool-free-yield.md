# Tool-free Yield Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task has an Acceptance Contract; do not mark a task complete until its Quality Gate review returns PASS.

**Goal:** Stop auto-continue immediately on tool-free yields while keeping bounded recovery for unchanged observational loops.

**Architecture:** Track whether the current agent run attempted a progress-class observational tool. On `agent_end`, if there is no credited work and no observational attempt, open the circuit without queuing recovery. Observational-no-change keeps the existing 2-recovery path.

**Tech Stack:** TypeScript pi-goal-x extension events, node:test golden harness.

## File inventory

- Modify: `extensions/goal-events.ts`
- Modify: `extensions/goal-progress-evidence.ts`
- Modify: `tests/goal-stale-continuation-golden.test.ts`
- Modify: `tests/goal-progress-evidence.test.ts`
- Modify: `CHANGELOG.md`, `package.json`, `package-lock.json`

### Task 1: Tool-free yield circuit

**Files:**
- Modify: `extensions/goal-events.ts`
- Modify: `extensions/goal-progress-evidence.ts`
- Test: `tests/goal-stale-continuation-golden.test.ts`

**Acceptance Contract:**
- User-visible behavior: A tool-free goal turn stops automatic continuation immediately; unchanged `git status` loops still get two recoveries then the existing breaker.
- Wiring proof command: `node --experimental-strip-types --test tests/goal-stale-continuation-golden.test.ts tests/goal-progress-evidence.test.ts`
- Expected output / observable behavior: new tool-free yield test passes; observational golden still reports circuit after 3 unchanged shell runs; first empty tool-free run emits `pi-goal:no-progress-circuit-open` and queues 0 checkpoints.
- Test-quality proof: the new test fails on current code because the first empty run queues a recovery checkpoint.
- Regression proof command: `node --experimental-strip-types --test tests/goal-stale-continuation-golden.test.ts`
- Failure this catches: Kalshi/Day 8 restatement loops after a real user-only yield.

- [ ] **Step 1: Write the failing tests**
- [ ] **Step 2: Run tests to verify they fail for the right reason**
- [ ] **Step 3: Implement observational-attempt tracking and tool-free immediate circuit**
- [ ] **Step 4: Run focused tests green**
- [ ] **Step 5: Run full `npm test`, `npm run check`, `npm run lint`, `git diff --check`**
- [ ] **Step 6: Commit**
