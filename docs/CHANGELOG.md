# Changelog

## 0.18.0 (2026-05-29)

### Features

- **Enriched confirmation dialog** — proposal dialogs now render with full-width box-drawing section headers (`┌─ Section Name ─────┐`), per-status task coloring (`[x]` green, `[ ]` yellow), and goal structure section highlighting (`Objective:`, `Success criteria:`, etc. in accent). The 12-line MAX_CONTEXT_LINES cap is removed — full proposals are always visible.
- **Hidden TUI debug mode** — Ctrl+Shift+X toggles a debug panel in the goal widget. Ctrl+Shift+N creates/removes test goals (written to `.pi/goals/debug/`), Ctrl+Shift+T injects sample tasks, Ctrl+Shift+R starts a mock audit, Ctrl+Shift+O opens the proposal dialog with realistic data.

### Fixes

- **Text wrapping inside boxes** — pipe-prefixed lines (`│   content`) that wrap now maintain the `│   ` prefix on continuation lines, keeping wrapped text inside the ASCII box. Task checkbox lines embedded in objective text also get the `│   ` prefix so they appear within the box.

### Tests

- 310 total tests (unchanged).

## 0.17.0 (2026-05-29)

### Features

- **Per-goal auditor toggle** — press `a` during the confirmation dialog to toggle the auditor on/off for a specific goal. Default from settings; override persists within session.
- **Task workflow prompt guidance** — added `[TASK WORKFLOW]` section to both `goalPrompt` and `continuationPrompt`, directing agents to complete subtasks one-by-one as progress trackers (not batch-marking at the end).
- **Recursive duplicate ID validation** — `validateTaskListProposal` now checks all task IDs across the entire tree, preventing collisions between parent/subtask or sibling subtask IDs.
- **Escape dialog during audit** — pressing Escape during a completion audit shows a TUI dialog with "Mark complete without audit" or "Continue working" options.

### Fixes

- `validateTaskCompletion` and `validateTaskSkip` now use recursive `findTaskInTree` instead of flat `Array.find()` for nested subtask support.
- Updated README references from legacy `update_goal` to `complete_goal`.

### Tests

- 310 total tests (up from 308).
- Added tests for recursive duplicate ID detection across nested subtask trees.
- Added e2e test for `skipAuditor=true` path.

## 0.16.1 (2026-05-29)

### Features

- **Escape-to-skip audit** — press Escape during an auditor run to abort it and complete the goal immediately. The skip is recorded in the ledger with the reason `user_aborted` and auditor model metadata.
- **Audit progress widget** — the TUI shows a spinner, progress bar, step labels, current tool, and output lines while the auditor runs.
- **Audit abort detection** — the auditor detects aborts both from exceptions and from `session.prompt()` returning after an abort signal, preventing stuck goals or ghost states.
- **Goal status for Sisyphus** — `COMPLETED` status label for completed Sisyphus goals.
- **Multi-session focus isolation** — goal focus data uses `goalFocusDetails` which includes the goal id and reason but not full balance data, preventing cross-session focus leakage.

### Fixes

- Fixed a merge bug where `propose_task_list` could produce duplicate task list when called during a continuation.

## 0.16.0 (2026-05-29)

### Features

- **`delete_goal` tool** — new lifecycle tool for archiving goals by id. Accepts a required `goalId` and optional `reason`. Agent-facing only; not intended for user use.
- **`complete_goal` `status` optional** — the `status` parameter on `complete_goal` is now optional. When omitted, defaults to `"complete"`. Explicitly setting an invalid value (anything other than `"complete"`) still produces an error.
- **SCROLL FIX** — the confirmation dialog no longer scrolls to the bottom when the user is scrolled up and new content arrives. Uses `addContextWrapped()` which suppresses viewport resets.
- **Task list shown first** — the task list section now appears FIRST in the confirmation dialog context (before the objective), with context capped at 12 lines so tasks don't scroll off-screen.
- **Audit completion flow** — the completion report card no longer says "Goal audit approved." when the auditor was skipped (now shows "Goal audit skipped." with reason).

### Fixes

- Fixed task completion/skip validation for nested subtasks (uses recursive `findTaskInTree`).
- All `complete_goal` calls default to `status: "complete"` when no explicit status is provided.
- Updated prompts and tool descriptions to reflect the `complete_goal` naming.

### Tests

- Updated e2e tests to verify `complete_goal` accepts calls without status.
- Added e2e test verifying `complete_goal` rejects invalid explicit status.

## 0.15.1 (2026-05-28)

### Fixes

- Fixed settings file reference in storage writes.

### Documentation

- Reorganized README settings documentation for clarity.

## 0.14.0 (2026-05-27)

### Features

- **Subtask hierarchy** — tasks can have nested sub-tasks via `subtasks?: GoalTask[]`. Subtask depth controlled by `subtaskDepth` setting (default: 1). Deep subtrees are rejected at proposal.
- **Lightweight subtasks** — `lightweightSubtasks?: boolean` on tasks. When true, parent can complete regardless of subtask status. Full subtasks require all sub-items completed first.
- **Per-task contracts** — `propose_task_list` supports optional `verificationContract` per task. If set, `complete_task` requires a non-empty `verificationSummary`.
- **Task list block** — tasks are listed in prompts with checkboxes and status indicators.

### Tests

- Added e2e tests for goal creation with task list, scroll fix, and subtask validation.

## 0.13.0 (2026-05-22)

### Features

- **Verification contract system** — goals can include a `Verification contract:` section. Extracted and stored on the goal record. `complete_goal` rejects calls without `verificationSummary` when a contract is set.
- **Per-goal verification contracts** — the contract is extracted during goal drafting and enforced by tools and prompts.
- **`complete_goal` `testResults` removed** — replaced with `verificationSummary`. The old structured test results interface is gone.
- **Auditor integration** — the independent completion auditor receives both the `verificationContract` and `verificationSummary` and cross-checks claims against real artifacts.

### Tests

- Updated verification contract tests.

## 0.12.0 (2026-04-29)

### Features

- **Task list system** — `propose_task_list` tool with confirmation dialog. Tasks stored on goal record, rendered in prompts and widget, serialized to disk.
- **Unified goal + task acceptance** — `propose_goal_draft` accepts optional `tasks` array. Single dialog shows goal + task list together.
- **`complete_task` and `skip_task` tools** — per-task completion with evidence/verificationSummary. Neither stops the turn.
- **`update_goal` renamed to `complete_goal`** — the core completion tool now uses `complete_goal({status: "complete"})` and requires explicit status acceptance.
- **Completion report heading fix** — the report now shows `Goal complete.` instead of `Goal audit approved.` when no contract or auditor is involved.

### Tests

- Full task lifecycle tests (policy, round-trip, render, edge cases).
- Verification contract tests for both goal-level and per-task contracts.

## 0.11.0 (2026-04-23)

### Features

- **Deferred archival** — goals are archived at `turn_end`, not inline in the tool handler. Prevents premature archiving before the agent sees the audit result.
- **`propose_goal_tweak`** — sole mechanism for updating the goal objective during `/goal-tweak`. Uses the same Confirm/Continue Chatting dialog as goal creation.
- **Focus isolation** — goal focus is stored as a branch-local session entry, not in goal markdown metadata. Multiple sessions can have different focused goals.
- **Auditor bypass with user confirmation** — `confirmBypassAuditor: true` bypasses the auditor when the user explicitly opts out.

### Fixes

- Cleaned up lifecycle issues with AbortSignal wiring and timer cleanup.

## 0.10.0 (2026-04-15)

### Features

- **Completion audit system** — independent pi auditor agent verifies completion claims before archiving.
- **Audit progress** — real-time TUI progress widget with spinner, progress bar, and step labels.
- **Ledger system** — structured event log for all goal lifecycle events.

## 0.9.0 (2026-04-08)

### Features

- **`goal_question` and `goal_questionnaire`** — structured drafting question tools.
- **`/goal-settings`** — interactive settings configuration.
- **Sisyphus goal style** — patient ordered execution with prompt/criteria variant.

## 0.8.1 (2026-04-01)

### Features

- Initial fork from @capyup/pi-goal.
- Pause/resume/abort lifecycle.
- Multiple open goals.
- Auto-continue loop.
