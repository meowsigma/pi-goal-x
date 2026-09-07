# Integrated Recovery Repair Implementation Plan

> For workers: execute with test-driven-development and systematic-debugging; the parent owns publication and acceptance.

**Goal:** Repair the four audited integration gaps without weakening autonomy or human-owned boundaries.
**Architecture:** Keep goal-x the sole continuation owner for focused goals. Separate focused side-UI key ownership from main cancellation, audit admission from productive-work continuation, and current goal status from extension ordering. Prefer existing/public host APIs; if the SDK lacks cross-extension focus information, use a small versioned ephemeral focus-ownership event between BTW and goal-x, driven by actual focus and released on close/shutdown. Do not patch installed SDK internals or merely consume every Escape.
**Tech stack:** TypeScript/JavaScript Pi extensions; existing node:test and Vitest harnesses; actual installed Pi 0.85.1 TUI/loader where required.

## 1. Goal and BTW lane
Files: goal extensions/goal-widget.ts, extensions/goal-state.ts, extensions/goal-events.ts, extensions/goal-runtime.ts, extensions/goal-completion.ts, extensions/prompts/goal-prompts.ts; tests/goal-modal-escape.test.ts and tests/integration/extension.test.ts; BTW extensions/btw.ts and tests/btw.runtime.test.ts. Touch only the necessary subset plus focused regression files/docs/version metadata.

Acceptance contract:
- Wiring: replay Escape through actual TUI input dispatch with registered goal handler and focused BTW-like/custom overlay; close side UI without goal pause, while unfocused-overlay/main Escape still pauses and aborts.
- Goal: exhausted audit remains fail-closed, but an audit-only turn with pending independent work gets targeted pivot guidance and a continuation opportunity; subsequent repeated rejected completion requests do not cause a hot loop.
- Test quality: reproduce each failure on base 4845b3f before production edits; old Escape sequence is [goal.pause, btw.dismiss].
- Regression: npm run check; npm run lint; npm test; npm run test:integration; BTW npm test. Include cancellation, shutdown/focus cleanup, same-run productive credit, no pending-work case, and timer ownership.

- [ ] Read relevant complete Pi extension/TUI docs and call sites; confirm baseline tests.
- [ ] Add failing native-dispatch Escape tests (including focused, unfocused, nested goal modal, main abort, audit Escape).
- [ ] Implement minimum focus-aware routing; no blanket return consume:true and no suppression merely because an overlay is visible.
- [ ] Add failing exhaustion + independent pending work lifecycle test, with blockCompletion false where required to reach the audit path.
- [ ] Separate audit admission from actionable recovery; maintain bounded provider attempts and single-owner timers. Never substitute generic endless completion-denied checkpoints for a pivot.
- [ ] Align no-progress skip guidance to existing task-tool authorization; preserve criteria and NOT PROVEN.
- [ ] Run lane proofs and document exact commands/results in MILESTONES.md.

## 2. NQA lane
Files: extensions/no-questions-asked.ts, skills/full-throttle/SKILL.md, tests/no-questions-asked.test.mjs and relevant package tests/docs/version metadata. Do not edit the other lane's files.

Acceptance contract:
- Wiring: actual NQA-before-goal and goal-before-NQA handler chains must both include actionable goal reinforcement. Existing disposable failing assertion is in /tmp/goal-nqa-sdk085-audit-KXm243/tests/integration/nqa-goal-host.test.ts; logs order-goal-first.log and order-nqa-first.log.
- Goal: NQA must not assert an inactive goal is active or queue a second goal wake. Current pause/budget/unfocused blocks win over conditional coaching.
- Test quality: production NQA-first order fails on fd42241 when requiring specialized active-goal recovery. Test both orderings and nonactive states.
- Regression: npm test; npm run smoke:packed; npm run pack:check; git diff --check.

- [ ] Add failing both-order tests and pause/unfocus guard cases.
- [ ] Make reinforcement independent of whether the current-turn active block has already been appended; favor conditional status-aware guidance over guessing goal state from mere focus.
- [ ] Remove stale Full-Throttle approval of arbitrary no-progress circuit termination; retain real cancellation, budgets, authorization, and auditor protocol errors.
- [ ] Run lane proofs, report exact files and evidence.

## 3. Parent integration and release
- [ ] Review complete diffs against PRODUCT.md, then independent quality/correctness review.
- [ ] Run both latest candidate packages together on Pi 0.85.1 in both load orders, and goal/BTW native input routing. Keep optional-source tests explicit: do not count skipped integration as proof.
- [ ] Independently rerun final suites/static/package checks; verify no unrelated changes included.
- [ ] Commit and push fast-forward to existing meowsigma repositories only after acceptance.
- [ ] Install via repository fetch/fast-forward. Preserve the local BTW orphan-result diff byte-for-byte in scope; do not publish it accidentally.
- [ ] Verify installed hashes/status and tell user to /reload active sessions. Report exact evidence and residual limits.
