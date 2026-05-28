# Changelog

All notable changes to pi-goal-x are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the `0.x` prefix indicating pre-1.0 development.

---

## [0.15.0] — 2026-05-28

### Changed

- **Unified settings file** — all settings now live in a single `.pi/pi-goal-x-settings.json` file instead of two separate files. The unified file includes `disableTasks`, `disableContracts`, `subtaskDepth`, `provider`, `model`, `thinkingLevel`, and `disabled`. Clean break: old `.pi/goal-settings.json` and `.pi/goal-auditor.json` files are no longer read. Users must manually merge into the new file.
- **`loadGoalSettings` replaces `loadGoalAuditorConfig`** — the auditor now reads its config (provider, model, thinkingLevel, disabled) from the unified settings file via `loadGoalSettings()`. Old individual `loadGoalAuditorConfig`, `loadGoalAuditorFileConfig`, `saveGoalAuditorFileConfig`, `parseGoalAuditorConfig`, and `goalAuditorConfigPath()` functions removed from `goal-auditor.ts`.
- **Auditor env vars removed** — `PI_GOAL_AUDITOR_PROVIDER`, `PI_GOAL_AUDITOR_MODEL`, and `PI_GOAL_AUDITOR_THINKING_LEVEL` removed. Replaced with single `PI_GOAL_SETTINGS_FILE` env var that points at an alternative settings file path (relative to cwd or absolute). `PI_GOAL_DISABLE_TASKS` and `PI_GOAL_DISABLE_CONTRACTS` remain unchanged.
- **`/goal-settings` TUI updated** — now shows all settings in one list (disabled, provider, model, thinking_level, subtaskDepth, disableTasks, disableContracts) instead of a separate auditor-only sub-menu.

## [0.14.0] — 2026-05-28

### Added

- **Unified goal + task acceptance** — `propose_goal_draft` accepts an optional `tasks` array parameter (full task list structure). The confirmation dialog shows the goal objective AND proposed task list together in a single rich TUI view with box-drawing panel (`┌─ TASKS ───┐`), section headers, and hierarchical indentation for subtasks. One confirmation (single enter press) creates both the goal and its task list atomically. Backward compatible: existing `propose_task_list` flow unchanged.
- **Recursive sub-task system** — `GoalTask` type gains optional `subtasks?: GoalTask[]` (recursive — sub-tasks are full task records with id, title, status, evidence, completedAt, verificationContract, and their own subtasks). `GoalSettings` gains `subtaskDepth?: number` field (default 1) in `.pi/goal-settings.json`. Depth validation/policy in `goal-policy.ts` enforces the limit at all proposal points. `lightweightSubtasks?: boolean` flag allows parent completion without child enforcement.
- **Depth-validated proposal flow** — subtask depth is validated BEFORE showing the confirmation dialog (moves pre-dialog to match `propose_task_list` behavior). `findSubtaskDepthViolation` and `validateTaskListProposal` used in both `propose_goal_draft` and `propose_task_list`.
- **Subtask enforcement on complete/skip** — `complete_task` rejects when a task has pending full subtasks (`checkSubtasksComplete`). `skip_task` cascades skip to all child subtasks (`skipAllSubtasks`). Both use `findTaskInTree`/`updateTaskInTree` helpers.
- **Hierarchical task display** — `taskListBlock` in prompts renders subtask trees with indentation via `renderTaskTree`. `buildTaskSummary`/`taskSummaryBlock` recursive. Widget (`goal-widget.ts`) counts subtasks recursively in `countFlatTasks` and finds next pending task via BFS `findFirstPending`.
- **Scroll fix for proposal dialogs** — `runGoalQuestionnaire` suppresses hardware cursor during dialog (`setShowHardwareCursor(false)`) to reduce ~60fps ANSI cursor-positioning writes that fight manual scrolling. Cursor restored on dialog close. Affects `propose_goal_draft`, `propose_task_list`, and all goal questionnaire dialogs.
- **E2E test coverage** — unified acceptance flow (goal creation + task list + subtasks + verification contract, disk round-trip verified) and scroll fix (headless dialog path exercises cursor operations).
- **Subtask normalization/roundtrip** — `normalizeTaskList`, `normalizeTaskItem`, and `cloneGoal` handle recursive subtask structures.
- **Subtask depth edge cases** — tests for depth below 1, non-integer, negative, and missing config file defaults.

### Changed

- **`subtaskDepth` default is 1** — one level of nesting (tasks → subtasks). Set via `.pi/goal-settings.json`. No config file means default 1.

## [0.13.0] — 2026-05-28

### Added

- **Verification contract system** — goals and individual tasks can now define a `Verification contract:` section specifying what verification evidence is required before completion, enforced at both the prompt and tool level. Key properties:
  - **`Verification contract:` section** — when drafting a goal (via `propose_goal_draft` or `/goals-set`/`/sisyphus-set`), include a `Verification contract: <description>` section in the objective. The contract is extracted, stored on the goal record, and stripped from the visible objective text.
  - **`complete_goal` `verificationSummary`** — the old optional `testResults` parameter is replaced with a required `verificationSummary` (plain text). If the goal has a contract, the call is rejected unless `verificationSummary` is non-empty.
  - **Per-task contracts** — `propose_task_list` supports an optional `verificationContract` per task. `complete_task` gains an optional `verificationSummary` parameter; if the task has a contract, the summary is required.
  - **Prompt hardening** — `goalPrompt` and `continuationPrompt` include a VERIFICATION CONTRACT section instructing the agent to provide evidence against every contract item before calling `complete_goal`/`complete_task`.
  - **Auditor integration** — the auditor receives both the `verificationContract` and `verificationSummary` and cross-checks the agent's claims against real artifacts.
  - **Backward compatible** — goals/tasks without a `Verification contract:` section work exactly as before.

### Changed

- **`complete_goal` `testResults` removed** — fully replaced by `verificationSummary`. The deprecated `AuditorTestResults` interface is deleted; `AuditorVerificationEvidence` is the only interface used.
- **`buildGoalAuditorPrompt`** — now accepts `verificationSummary` instead of `testResults`; renders `<verification_summary>` and `<verification_contract>` blocks instead of `<test_evidence>`.

## [0.12.0] — 2026-05-27

### Added

- **Task list system** — goals can now include a structured task list with `propose_task_list`, `complete_task`, and `skip_task` tools. Key properties:
  - **`propose_task_list`** — agent proposes a task list to the user via a Confirm / Continue Chatting dialog (mirrors `propose_goal_draft` pattern). Stops the turn. Merges with existing tasks, preserving statuses of matching IDs.
  - **`complete_task`** — marks a task complete with optional evidence (≤200 chars). Does **not** stop the turn, allowing the agent to continue work.
  - **`skip_task`** — marks a task skipped with a required reason. Does **not** stop the turn.
  - **`complete_goal` task gate** — when `blockCompletion: true` and pending tasks exist, `complete_goal` surfaces a soft guard warning rather than blocking outright. The gate is prompt-level only; the agent can still complete.
  - **Ledger events** — `task_list_set`, `task_complete`, `task_skipped` events recorded for full traceability.
  - **Serialization** — tasks persisted as `## Tasks` markdown section in goal files with `[x]`/`[ ]`/`[~]` markers, evidence, skip reasons, and `blockCompletion` comment.
  - **Prompt injection** — `taskListBlock` renders the active task list in both `goalPrompt` and `continuationPrompt`, including the TASK GATE warning when `blockCompletion` is enabled and pending tasks exist.
  - **Widget display** — heading shows `N/M tasks`; body shows the next pending task or `All tasks complete`.
  - **Auditor integration** — task summary block included in auditor prompt's `<goal_details>`.
  - **Optional** — goals without a `taskList` work exactly as before.

### Changed

- **`update_goal` renamed to `complete_goal`** — the completion tool is now named `complete_goal` to make its sole purpose unambiguous (marking the goal complete). The old name `update_goal` sounded generic and tempted agents to call it when work was unfinished. Prompt guidelines on the renamed tool were tightened: added "Do NOT call complete_goal if any work remains, even if substantial progress was made." All internal references, tests, prompts, and documentation updated.

## [0.11.0] — 2026-05-27

### Removed

- **`apply_goal_tweak` fully removed** — replaced with `propose_goal_tweak`, a confirmation-dialog tool that mirrors `propose_goal_draft` exactly. The old `apply_goal_tweak` (which applied tweaks inline without user confirmation) is deleted entirely from source: constant, registration, imports, handler, and all references. The `/goal-tweak` flow now shows a Confirm / Continue Chatting dialog before applying the revision.

### Added

- **`propose_goal_tweak` tool** — registered alongside `propose_goal_draft`, available exclusively during `/goal-tweak` drafting. Uses `showProposalDialog()` and `buildTweakConfirmationText()` to present the current objective, change summary, and proposed new objective. On Confirm: writes the new objective, clears drafting state, terminates the turn. On Continue Chatting: keeps drafting active for further refinement.
- **Comprehensive test coverage** — 13 new tests across three layers:
  - Unit: `buildTweakConfirmationText` renders normal/sisyphus modes and edge cases (3 tests).
  - Integration: tool registration, schema validation, rejection gates (no goal set, no `/goal-tweak` flow), prompt guidelines, renderCall/renderResult (11 tests).
  - E2E: real `pi --fork --mode json` test verifying `propose_goal_tweak` is rejected without an active `/goal-tweak` drafting flow (1 test).
  - Total test count: 143 tests (up from 131), all passing, TypeScript zero errors.

### Changed

- **`/goal-tweak` notification** now says "started a `/goal-tweak` flow on `{objective}` — I'll draft the change and propose the revision for you to Confirm." reflecting the new confirmation pattern.
- **`syncGoalTools()` and `fullGoalToolVisibility()`** — `propose_goal_tweak` shown during tweak drafting, hidden otherwise. Removed dead `draftingHiddenWorkTools` constant referencing `TWEAK_APPLY_TOOL_NAME`.
- **`goalTweakDraftingPrompt`** guides the agent to use `propose_goal_tweak` with confirmation dialog.
- **Test assertions updated** in `goal-tool-names.test.ts`, `goal-draft.test.ts`, `goal-update-objective.test.ts`, `goal-prompts.test.ts` — all references to `apply_goal_tweak` / `TWEAK_APPLY_TOOL_NAME` replaced with `propose_goal_tweak` / `PROPOSE_TWEAK_TOOL_NAME`.

---

## [0.10.2] — 2026-05-26

### Removed

- **`updatedObjective` from `update_goal`** — the goal objective can no longer be changed through `update_goal`. The parameter is removed from the schema, `additionalProperties: false` enforces strict rejection of unknown params, and the Phase 1 handler block that processed it is deleted. Objective changes now go exclusively through `apply_goal_tweak`, gated behind user-initiated `/goal-tweak`.

### Changed

- **`update_goal` error message** — simplified to: `"update_goal requires status=complete when marking a goal complete."` (no more branching on `updatedObjective` vs `status`).
- **Prompt guidelines** — `update_goal` prompt, `goalPrompt()`, and `continuationPrompt()` now state the goal objective is **immutable** and instruct the agent to ask the user to run `/goal-tweak` to revise it.
- **Test coverage** — old quick-sync/combined e2e tests replaced with schema-rejection and completion-only mock-pi tests. 2 new source-inspection unit tests verify `additionalProperties: false` and absence of `updatedObjective`.
- **Docs** — `README.md` rewritten ("Goal objective is immutable" section). Agent and chain docs (`e2e-test-runner.md`, `e2e-test.chain.md`) cleaned up.

---

## [0.10.1] — 2026-05-26

### Added

- **`testResults` attestation** — the executor can pass structured test evidence (`exitCode`, `suiteName`, `output`, `timestamp`) via `update_goal({testResults})`. The auditor receives it as a `<test_evidence>` block and is instructed to check it before re-running test suites, skipping redundant re-runs.
- **Full test coverage for `testResults`** — 6 unit tests covering rendering of full/minimal/null evidence blocks, multi-line output indentation, non-passing exit codes, and the checklist instruction to check evidence before re-running. 1 integration test verifying the handler accepts `testResults` without error.

### Changed

- **`buildGoalAuditorPrompt` checklist renumbering** — when `testResults` is provided, the checklist has 5 items (with step 3 about checking test evidence). Without it, the checklist has 4 items (no evidence step), ensuring step numbers always align.

---

## [0.10.0] — 2026-05-26

### Added

- **Auditor progress visibility** — the auditor agent now has a `report_auditor_progress` tool to report its current step label (e.g. "Inspecting files...") and completion percentage at natural phase boundaries. The prompt instructs the model to use it at starting → inspecting → verifying → evaluating → reporting phases.
- **Progress bar widget** — when the auditor reports progress, the TUI widget renders a progress bar (`[████░░░░] 40%`) alongside the step label, giving the user a clear visual sense of completion.
- **Thinking phase awareness** — silent thinking phases (model reasoning without tool calls) are now detected via `thinking_start`/`thinking_end` stream events. The widget shows a distinct `⟡ thinking...` label with elapsed time and hides the Esc-to-skip hint during thinking.
- **`AuditorProgress` / `AuditorWidgetProgress` types** — extended with optional `label` and `percentage` fields for the progress tool and widget.
- **Widget tests for progress bar** — 5 new tests covering progress bar rendering at 0%/40%/100%, thinking phase display, step labels, undefined-percentage fallback, and narrow-width boundaries.

### Changed

- **`runGoalCompletionAuditor`** now passes the `report_auditor_progress` tool via `customTools` to the auditor agent session. Initial progress ("Starting audit..." / 0%) is emitted before the session starts. The `buildGoalAuditorPrompt` includes a "Progress reporting:" section with usage examples.
- **`renderAuditorWidgetLines`** — enhanced to display step label, progress bar, and thinking-phase icon/label. All existing display elements (spinner, tool name, output lines, Esc-to-skip) are preserved.

---

## [0.9.0] — 2026-05-26

### Added

- **`update_goal({updatedObjective})`** — the agent can now sync the goal objective mid-flight when user requirements change, without completing the goal. The `status` parameter is now optional, allowing a pure objective-update call. This ensures the completion auditor evaluates against the latest requirements.
- **`validateGoalUpdate()`** extracted to `goal-policy.ts` — validates that the target goal is active/paused (rejects null or already-complete goals with specific messages). Used by the handler and testable independently.
- **Comprehensive e2e test suite**: 131 tests covering function-level integration (12 tests, 9-scenario matrix + 3 edge-case gates), mock-pi handler tests (4), file-validity/chain checks (6), and real `pi --fork --mode json` fork tests (3 scenarios).
- **Deterministic fork tests**: the `--mode json` fork test uses `--append-system-prompt` + `--tools get_goal,update_goal` to force the AI model to always call the required tools. Validates `tool_execution_start`/`tool_execution_end` JSON events with field-level assertions — no free-text AI output parsing.

### Changed

- **Goal archival deferred until after agent turn completes**: `update_goal` marks the goal complete in-memory and writes an active file (not archived). The `turn_end` lifecycle hook detects completed goals and archives them — after the agent has received the audit/skip result. Previously archival happened inline within the tool handler, before the agent could see the result.
- **`buildCompletionReport` supports `auditSkippedReason`**: skip notifications (disabled auditor, Esc abort) are now included in the tool output text.
- **`accountProgress` guard**: skips `reconcileFocusedGoalFromDisk` for completed goals, preventing lifecycle conflicts.

### Fixed

- **Combined path correct ordering**: when `updatedObjective` + `status: "complete"` are passed together, the objective update is applied first, then the normal completion+audit flow runs against the updated objective.
- **Completion gate timing**: `turnStoppedFor` and `terminate: true` are no longer set for pure objective-sync calls — only for actual completions.

---

## [0.8.2] — 2026-05-26

### Fixed

- **Goal archival deferred until after agent turn completes**: previously, `update_goal` archived the goal file inline within the tool handler before the agent could see the audit result (or skip notification). Now the goal is marked complete in-memory and written as an active file (not archived) during `update_goal`, and archival happens at `turn_end` — after the agent has received the audit/skip result.

### Added

- **`buildCompletionReport` supports `auditSkippedReason`**: skip notifications (disabled auditor, Esc abort) are now included in the tool output text, ensuring the agent sees why the audit was skipped before the goal is archived.
- **Tests**: verify `writeActiveGoalFile` no longer auto-archives for complete status (deferred archival), and `buildCompletionReport` correctly handles `auditSkippedReason` with precedence over `auditorReport`.

---

## [0.8.1] — 2026-05-19

### Changed

- **Audit log messages clarified**: `extensions/goal.ts` — disabled/aborted audit messages now read naturally as goal completion notices ("Goal completed — auditor disabled in settings." / "Goal completed — auditor bypassed (user pressed Escape during audit).").

---

## [0.8.0] — 2026-05-17

### Added

- **C19 iteration-frustration benchmark**: new spec under `specs/` exercising the proposal-refinement cycle with repeated rejection scenarios.
- Spec metadata files: `PRODUCT.md`, `TECH.md`, `MILESTONES.md` for the C19 benchmark.

### Changed

- **Normalized proposal-refinement cycle language**: `extensions/goal-draft.ts`, `extensions/goal-questionnaire.ts`, and `extensions/goal.ts` — consistent terminology across the drafting/refinement pipeline.
- Updated test assertions (`tests/goal-draft.test.ts`) to match the new language.

---

## [0.7.2] — 2026-05-17

### Added

- Gallery image metadata and placeholder screenshot for `pi.dev/packages`.

---

## [0.7.1] — 2026-05-17

### Fixed

- Version metadata in package manifest after 0.7.0 release commit.

---

## [0.7.0] — 2026-05-17

### Added

- **Goal auditor lifecycle** (`feat(auditor)`):
  - `disabled` config flag to turn off auditing entirely.
  - Real-time progress callbacks during audit execution.
  - `audit_skipped` event type recorded in the ledger with reason + auditor metadata.
- **Auditor progress widget**: live spinner, tool tracking, and skip hint in the TUI.
- **Auditor integration**:
  - Escape-key handling during audit (skip with Esc, prevents cascading goal pause).
  - `createSession` factory wiring `AbortSignal` to `session.abort()`.
  - Audit abort detection (both thrown and non-thrown `session.prompt` aborts).
  - Goal completes on audit abort instead of leaving an open state.

### Fixed

- Audit cancellation loop: `confirmBypassAuditor` param respected, skip-once with `triggerTurn` mirroring disabled-bypass path.
- Corrected Esc-to-skip widget message to reflect actual behavior.

### Tests

- Unit tests for disabled config, `audit_skipped` events, and widget skip hint.
- Abort-scenario tests for `runGoalCompletionAuditor`.
- Post-prompt abort detection test.
- Goal policy test validating completion report includes full auditor output.

---

## [0.6.0] — 2026-05-12

### Added

- **Split goal intent and direct set commands**: `/goals-set` / `/sisyphus-set` — create and start a goal immediately from the supplied objective, skipping the discussion flow.

### Changed

- `specs/` directory excluded from npm package.

---

## [0.5.0] — 2026-05-12

### Removed

- Token budget system removed from the drafting runtime.
- **Simplified drafting runtime**: removed token-budget tracking and associated complexity.

---

## [0.4.1] — 2026-05-12

### Added

- **Visible audit dialogue**: the completion auditor now prints its dialogue into the conversation, giving full visibility into the audit reasoning.

---

## [0.4.0] — 2026-05-12

### Changed

- Goal runtime updates — internal refactoring and lifecycle improvements.

---

## [0.3.1] — 2026-05-12

### Added

- **Independent goal completion auditor**: standalone audit step that reviews goal completion before finalizing.

---

## [0.3.0] — 2026-05-12

### Fixed

- **Oracle goal lifecycle audit fixes**: corrected audit lifecycle handling in Oracle-based goal execution.

---

## [0.2.7] — 2026-05-12

### Added

- **Goal abort lifecycle**: proper abort handling for in-progress goals.

---

## [0.2.6] — 2026-05-12

### Changed

- Split goal internals — refactored monolithic goal module into focused sub-modules.

---

## [0.2.5] — 2026-05-12

### Added

- Full `/sisyphus` command now required (no short-form aliases that could cause ambiguity).

---

## [0.2.4] — 2026-05-12

### Changed

- Grouped goal widgets — reorganized widget components for maintainability.

---

## [0.2.3] — 2026-05-12

### Changed

- Simplified Sisyphus goal flow — streamlined the Sisyphus execution loop.

---

## [0.2.2] — 2026-05-12

### Fixed

- Simplified goal widget header — removed redundant status information from the widget display.

---

## [0.2.1] — 2026-05-12

### Added

- **Goal widget component**: initial TUI widget showing goal status in the editor.

---

## [0.2.0] — 2026-05-12

### Added

- **Componentized goal drafting UX**: `/goals` and `/sisyphus` drafting flow extracted into reusable components.

---

## [0.1.2] — 2026-05-11

### Fixed

- Built-in question tools now correctly prefixed to avoid naming collisions.

---

## [0.1.1] — 2026-05-11

### Added

- **Built-in goal questionnaire drafting UI**: interactive questionnaire for goal refinement before confirmation.

---

## [0.1.0] — 2026-05-11

### Added

- Initial release of pi-goal-x (fork of `@capyup/pi-goal`).
- Core goal lifecycle: draft, confirm, execute, pause, resume, complete.
- Two goal styles: regular goals and Sisyphus ordered-execution goals.
- Intent-before-run flow (`/goals`, `/sisyphus`).
- `propose_goal_draft` confirmation gate.
- Auto-continue loop with empty-turn guard.
- Schema-gated lifecycle transitions.
- Multiple open goals with session-local focus.
- Goal status overlay widget.
- MIT license.

<!-- Version links for navigation -->

[0.15.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.15.0
[0.14.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.14.0
[0.13.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.13.0
[0.12.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.12.0
[0.11.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.11.0
[0.10.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.10.2
[0.10.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.10.1
[0.10.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.10.0
[0.9.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.9.0
[0.8.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.8.1
[0.8.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.8.0
[0.7.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.7.2
[0.7.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.7.1
[0.7.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.7.0
[0.6.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.6.0
[0.5.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.5.0
[0.4.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.4.1
[0.4.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.4.0
[0.3.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.3.1
[0.3.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.3.0
[0.2.7]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.7
[0.2.6]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.6
[0.2.5]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.5
[0.2.4]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.4
[0.2.3]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.3
[0.2.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.2
[0.2.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.1
[0.2.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.0
[0.1.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.1.2
[0.1.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.1.1
[0.1.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.1.0
