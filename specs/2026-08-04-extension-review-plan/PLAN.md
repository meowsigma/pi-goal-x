# Extension Review Plan — pi-goal-x (plan-only)

Date: 2026-08-04 · Scope: the full extension, every part, no exceptions ·
Deliverable: this plan (optimisation + feature enhancements + new
features), prioritized, each item with description + rationale + user value.
No effort/risk ratings by design. No implementation in this plan. New-feature
section scope steered by the user on 2026-08-04 to 1–3 task-focused features
with no new slash commands (the earlier 10-candidate set is parked in
`PARKED.md`).

---

## Part 0 — Audit coverage map (every module, no exceptions)

The extension ships as one installer (`extensions/goal.ts`, 33 lines) plus
~9.5k lines across 29 modules. Behavior is pinned by 24 test files under
`tests/` (unit + handler-level integration), the experiment matrix under
`experiments/cases/` (B1–B2, C1–C26), the scroll-churn harness under
`experiments/scroll-repro/`, and four docs (`docs/agent-flow-design.md`,
`docs/agentic-runtime-prd.md`, `docs/architecture.md`,
`docs/goal-ts-refactor-test-strategy.md`).

| Module | Responsibility | Observations (hotspots / plan-relevant) |
|---|---|---|
| `goal.ts` | Thin installer: message renderers, `createGoalCore`, registers commands/tools/events | Correctly minimal; no logic. |
| `goal-state.ts` (870) | `GoalCore`: all session state, tool-profile install, UI/widget glue, accounting glue, focus ops, archive/pause/continuation, `loadState`, `replaceGoal` | **Largest maintainability hotspot.** ~50-member interface; `state.goal` getter/setter with side effects; three similar focus-setters (`setGoal`, `updateFocusedGoal`, `setFocusedGoalId`); UI factory duplicated in `updateUI` (unfocused vs focused branches). |
| `goal-service.ts` (536) | `GoalService`: sole mutation boundary — reconcile, lock + revision check, write→ledger→memory commit, task transactions, `persist` with additive usage merge | Ledger-failure `onDiagnostic` boilerplate duplicated at **5 sites** (apply, updateTaskAttempt, persist, create, appendEvents) with identical message construction. |
| `goal-runtime.ts` (205) | Continuation scheduling (timer + idle gating), stale-checkpoint state, turn-stop guard, one-time steering reminders | Clean, encapsulated, independently testable. Scheduling retry loop uses 50ms unref'd timers — fine. |
| `goal-accounting.ts` (92) | Idempotent token/time charge, budget helpers | Tokens charged at **turn/tool-end granularity**, not per-tool-call — budgets can overshoot slightly between charges. `liveSeconds` clones goal per render. |
| `goal-policy.ts` (324) | Status/transition gates, task validation (depth, dupes, acyclic), task-tree walkers, report builders | `buildTaskSummary` counts **skipped as done**; `goal-auditor.ts`'s `countAuditorTasks` counts them separately; widgets/prompts each have their own counters — **4+ task-counting implementations** with subtle semantics drift. |
| `goal-record.ts` (309) | Types, normalization (status-authoritative reads), id/path helpers, budget validation | `safeIdPart` slices ids to 80 chars; `newGoalId` uses `Math.random` (non-crypto). Normalization is defensive and consistent. |
| `storage/goal-files.ts` (292) | Path safety (symlink/traversal guards), atomic writes, parse/serialize, `readActiveGoalPool`, objective-from-body merge | `readActiveGoalPool` does a **full sync directory scan + parse of every active goal file on every reconcile** (reconcile runs per tool call / turn event). |
| `storage/goal-lock.ts` (118) | Per-goal exclusive lock, stale recovery (TTL + pid liveness) | `Atomics.wait` **synchronous sleeps** on the main thread (default 100×25ms ≈ 2.5s worst case; persist uses 10×25ms). |
| `goal-ledger.ts` (367) | JSONL append (temp-write→read→append), full-file read+validate+sanitize, ledger reconstruction, latest-event queries | Every `readGoalLedger` **parses the entire JSONL** — called in `before_agent_start` (up to twice per turn), compaction, prompt building. Grows unbounded per session. Append = 2 file ops per event; events appended one-by-one in loops. |
| `goal-pool.ts` (101) | Pool construction, open-goal ordering, focus resolution, selector labels, usage merge | Small and clean. `otherOpenGoalCount` re-sorts the pool each call. |
| `goal-compaction.ts` (136) | Compaction summaries from goals + ledger | Depends on full ledger parse (see ledger). |
| `goal-events.ts` (408) | All lifecycle handlers: context rewrite, turn lifecycle, staleness gates, pause/error guards, session start/tree/compact, shutdown | `before_agent_start` can call `readGoalLedger` **twice** (paused + active paths) and `reconcileFocusedGoalFromDisk` multiple times. The `context` handler rewrites every queued goal event each context call. |
| `goal-commands.ts` (554) | 14-command palette: draft entry, direct-create, focus/unfocus, list/status, settings menu, tweak, clear, pause/resume | `handleSettingsMenu` inner block has **broken indentation** (readability); settings menu loop is the deepest nesting in the codebase. |
| `goal-core-tools.ts` (287) | `get_goal` / `create_goal` / `update_goal` (blocked, agent-pause, completion dispatch) | Prompt guidance embedded in tool definitions (good). `create_goal` always `terminate: true`. |
| `goal-task-tools.ts` (510) | `set_goal_tasks` / `update_goal_task`: flat→tree conversion, id-stable merge, task transactions | Flat-input validation is thorough (dupes, parents, cycles, depth, lightweight placement). `mergeTasksWithExisting` intentionally clears omitted structural fields. |
| `goal-task-confirmation.ts` (172) | Neutral task-list confirmation dialog (overlay) | Duplicates the bordered-line/truncation helpers also found in `goal-escape-dialog.ts` and `widgets/task-list-overlay.ts` (3 copy-pasted dialog scaffolds). Exports `renderConfirmationTasks`, which **`goal-draft.ts` re-implements identically**. |
| `goal-completion.ts` (398) | `update_goal(complete)` flow: gates, auditor dispatch, disabled/skip branches, escape dialog, single completion transaction, deferred archival | Long single function with interleaved ledger appends; four separate `appendEvents` try/catch blocks with near-identical swallow semantics. |
| `goal-auditor.ts` (455) | Auditor prompt, `resolveAuditorModel` (provider-only refusal), session creation with shared model runtime, progress tool, decision parse | `makeAuditorResourceLoader` returns an **empty resource loader** — auditor sessions get no project skills/extensions (deliberate isolation; also a capability ceiling). Audit animation timer pings the widget every 80ms. |
| `auditor-selector.ts` (72) | Settings picker choices: default/current ✓, authenticated models, manual entry, thinking levels | Clean, testable. |
| `goal-drafting.ts` (340) | Durable draft sessions (custom entries), rehydration, drafting tool registrations, proposal→confirm/cancel/continue, tweak apply | `activeDrafts` is a module-level `WeakMap`. Tweak path reuses the goal-draft pipeline cleanly. |
| `goal-draft.ts` (263) | Draft confirmation text builders, verification-contract extraction, drafting prompt | **Duplicates `extractVerificationContract` from `goal-contract.ts`** and `renderConfirmationTasks` from `goal-task-confirmation.ts`. |
| `goal-questionnaire.ts` (555) | Shared question UI (multi-tab), proposal dialog, spinner/hardware-cursor handling, terminal-height churn guard | Most complex UI file (~200 lines of custom ANSI render logic); the `render` closure is hard to test directly (covered via widget-level tests). |
| `goal-widget.ts` (341) | `syncTerminalInputPause`: Escape/audit-abort/task-overlay keybindings + **debug-mode helpers** | Debug helpers (`createDebugGoal`, `injectDebugTasks`, `startMockAudit`, `openDebugProposal`) ship in the production bundle; module-level mutable counters/timers; `openDebugProposal` is effectively dead (only notifies). |
| `widgets/goal-widget.ts` (378) | Above-editor goal widget + auditor progress widget + debug panel | Spinner frames derived from wall clock (`Date.now()/80`); render safety-net truncation. Debug panel gated by debugMode. |
| `widgets/task-list-overlay.ts` (389) | Ctrl+Shift+T scrollable multi-goal task overlay | Self-contained; duplicates dialog scaffold helpers. |
| `widgets/goal-escape-dialog.ts` (150) | Escape-during-audit choice dialog | Third copy of the bordered-dialog scaffold. |
| `widgets/goal-notifications.ts` (9) | Running-goal notification builder | Minimal. |
| `goal-format.ts` (237) | Entry/render helpers, event heading renderers, error/abort/tool-use message classifiers, token extraction | Message classifiers + token extraction are the model-coupling seam (all pi-agnostic shape checks — good). |
| `goal-core.ts` (78) | Display helpers: truncation, status labels, footer | `truncateText` hardcodes `max=120`; `footerStatus` truncates objective to 60 cols. |
| `goal-settings.ts` (187) | Settings file parse/load/save, env overrides, key rejection | `loadGoalSettings` does a **sync `fs.readFileSync` on every call** — invoked in `before_agent_start`, `queueContinuation`, tool gates, widget render (`getSettings`), drafting. No caching. |
| `goal-contract.ts` (58) | Verification-contract extraction, prompt-safe objectives, sisyphus sufficiency | Duplicated extraction exists in `goal-draft.ts`. |
| `goal-tool-names.ts` (70) | Tool-name constants, profiles, progress-tool sets | Single source of truth for tool sets — good. |
| `goal-tools.ts` (16) | Registration composition | Trivial. |
| `prompts/goal-prompts.ts` (228) | Active/continuation/paused/budget/stale/unfocused prompts, bounded fragments | `taskListBlock` renders the **entire task tree** (up to 50 tasks + subtrees) into every continuation prompt; fragment capped at 10k chars total so big trees crowd out the objective. |

---

## Part 1 — Optimisation plan (prioritized)

**P1-1. Cache settings loads.** `loadGoalSettings` / `loadGoalSettingsFileConfig`
read the settings file synchronously on every call, and they are called on hot
paths: `before_agent_start`, `queueContinuation`, every task-tool gate, the
widget's `getSettings` at render time, and drafting. Description: cache the
parsed config keyed by path + mtime, invalidate in `saveGoalSettingsFileConfig`
and on file-mtime change. Rationale: removes repeated sync I/O from per-turn and
per-render paths. User value: lower per-turn latency and steadier widget
rendering, especially on network filesystems.

**P1-2. Cache the active-goal pool read.** `reconcileFocused` →
`readActiveGoalPool` performs a full sync directory scan and file parse of every
active goal on every tool call and lifecycle event. Description: cache the pool
with mtime-based invalidation per goal file (and directory listing), refreshed
once per turn rather than per tool call. Rationale: reconcile runs 2–5× per
turn; with several open goals this is the dominant I/O cost. User value:
snappier turns with many open goals; no behavior change (still disk-authoritative
within a turn).

**P1-3. Incremental / bounded ledger reads.** `readGoalLedger` parses and
validates the entire JSONL (plus `reconstructGoalLedger`) on every call, and it
is called up to twice per `before_agent_start` and in compaction. Description:
keep an in-memory parsed tail with byte-offset resume (append-only file), or
cap the retained window and summarize older events; expose
`latestEventsForGoal` from the cache. Rationale: ledger grows unbounded per
session; per-turn cost is O(file). User value: long sessions stay responsive and
prompt injection stays cheap.

**P1-4. Single task-counting implementation.** `buildTaskSummary` (policy),
`countAuditorTasks` (auditor), `countAllTasks`/`countAllWithStatus` (widget +
overlay), and `countSubtree` (prompts) each re-implement subtree counting with
different "done" semantics. Description: one shared counter module with an
explicit `doneIncludesSkipped` flag, used by all four call sites. Rationale:
removes ~5 copies of the same walker and the semantic drift that produced
inconsistent "skipped counts as done" behavior between surfaces. User value:
consistent task numbers across widget, prompt, status, and auditor output.

**P1-5. Deduplicate contract extraction and confirmation-task rendering.**
`extractVerificationContract` exists in both `goal-contract.ts` and
`goal-draft.ts`; `renderConfirmationTasks` exists in both `goal-task-confirmation.ts`
and `goal-draft.ts`; the bordered dialog scaffold (`line()`, truncation,
header/footer) is copy-pasted across `goal-escape-dialog.ts`,
`goal-task-confirmation.ts`, and `widgets/task-list-overlay.ts`. Description:
collapse to one module each. Rationale: identical logic diverging in three
places is a correctness hazard (escape dialog vs confirmation dialog widths
already differ slightly). User value: fewer subtle rendering inconsistencies;
smaller surface to maintain.

**P1-6. Async (or tighter-bounded) goal locks.** `acquireGoalLock` blocks the
main thread with `Atomics.wait` sleeps (default 100×25ms; persist 10×25ms).
Description: bound the synchronous wait window (e.g. 5×20ms) and/or move lock
acquisition off the synchronous path with a promise-based variant used by the
async tool flows. Rationale: a contended goal can stall the interactive TUI for
hundreds of ms. User value: no UI stutter when two pi processes share a goal.

**P1-7. Batch ledger appends.** `appendGoalEvent` writes a temp file, reads it
back, and appends per event; completion flows append 2–4 events sequentially.
Description: one shared append that takes an event array and writes a single
line block (keeping the temp-file durability pattern), and a batch helper for
the completion/focus flows. Rationale: halves per-event I/O. User value:
negligible on its own, but compounds with P1-3 for long sessions.

**P1-8. Trim the continuation-prompt task tree.** `taskListBlock` renders every
task (up to 50 + subtrees) into every checkpoint prompt. Description: render
the first N pending tasks plus compact counts for the rest (completed/skipped
collapsed to one line each), keeping contract lines for pending tasks.
Rationale: preserves guidance while reclaiming fragment budget for the
objective and lifecycle policy. User value: less noise per continuation turn;
big task lists stop crowding out the objective.

**P1-9. Decompose `goal-state.ts`.** The 870-line core mixes state, UI, and
lifecycle. Description: extract the widget/status glue (`updateUI`,
`clearGoalWidget`, `goalForDisplay`) and the focus-setter trio into focused
helpers on the same core, shrinking the interface. Rationale: the 50-member
interface is the biggest maintainability cost in the extension. User value:
indirect (fewer regressions, faster iteration) — no user-visible behavior
change.

**P1-10. Prune debug-only surface from the shipped bundle.** The debug
keybindings/helpers in `goal-widget.ts` and the debug panel in
`widgets/goal-widget.ts` ship to every install. Description: gate them behind
an env flag (e.g. `PI_GOAL_DEBUG`) so the default bundle excludes dead code
(`openDebugProposal` is already effectively inert). Rationale: reduces shipped
code and removes module-level mutable debug state from production.
User value: smaller surface; fewer accidental trigger paths.

---

## Part 2 — Feature-enhancement plan (prioritized)

**E1. Per-goal event/audit history in status.** `get_goal` and `/goal-status`
show current state but not the goal's history. Description: surface the last
audit verdict + reason and recent lifecycle events (from the ledger, capped)
in `get_goal` and `/goal-status`, and in the paused prompt where a rejection
is already injected. Rationale: the ledger already records everything; the
surfaces just don't read it. User value: users and agents see why a goal was
paused/rejected without digging into `.pi/goals/goal_events.jsonl`.

**E2. Widget task-depth.** The widget shows only the first pending task.
Description: show the next 2–3 pending tasks with depth-aware indentation and a
collapsed-count line, mirroring the task-list overlay's tree. Rationale: the
widget is the always-visible surface; one line of context is often too little
to plan the next step. User value: glanceable "what's next" without opening the
overlay.

**E3. Effective-settings visibility.** Env overrides can silently change
behavior (`PI_GOAL_DISABLE_TASKS`, `PI_GOAL_SETTINGS_FILE`, budgets).
Description: `/goal-status` gains a "Settings" block showing effective values
with provenance (env vs file vs default), and `/goal-settings` marks rows
overridden by env as read-only with a hint. Rationale: settings are declarative
but opaque about their source. User value: fewer "why is my auditor different"
surprises.

**E4. Auditor session reuse of project skills.** `makeAuditorResourceLoader`
returns an empty loader, so the auditor can only use its six tools.
Description: optionally load the project's own skills/extensions into the
auditor session (off by default for isolation, on via a setting) so audits can
follow project-specific verification conventions. Rationale: audit quality
currently depends only on generic read/bash evidence. User value: stronger,
project-aware audits for teams that codify checks as skills.

**E5. Budget awareness in the widget and completion gate.** Description: show a
live budget progress line in the widget (`used/total`, remaining) and make the
budget-limited completion path mention the remaining-vs-overshoot fact in the
wrap-up steering. Rationale: budgets are set on creation but nearly invisible
afterwards. User value: users see cost pressure before the limit hits; agents
get a concrete number to steer by.

**E6. Drafting answer echo in the created-goal report.** Description: the
post-confirmation report already shows the objective; append a compact
Q&A summary from the questionnaire (question → answer) when drafting used
`goal_questionnaire`. Rationale: the answers shaped the goal but vanish after
confirmation. User value: users can verify their input survived the
clarification loop.

**E7. Sisyphus step progress in `get_goal`.** Description: for sisyphus goals,
derive the current step from the objective's ordered list and the latest
events/tasks, and include "At step N of M" in `get_goal` output and the widget
subtitle. Rationale: ordered execution is the point of sisyphus mode; the
surfaces don't say where the goal is. User value: better progress awareness for
long sequential goals.

**E8. Pause/abort reason preview in headings.** The `update_goal` heading
renders the status word only (deliberate 383ae52 surface). Description: keep
headings byte-identical, but add an expandable tool-result detail line that
carries the pause reason + suggested action so the collapsed heading stays
clean while the full reason is one keystroke away. Rationale: resolves the
old "truncated pause reason" complaint without touching the heading surface.
User value: full pause context visible in the transcript.

---

## Part 3 — New features (user-steered: 1–3, task-focused, no new slash commands)

Scope note (user steering, 2026-08-04): the earlier 10-candidate feature set
is parked in `PARKED.md`. The three features below are all about making the
task system better and deliberately add **no new slash commands** — each
reuses existing surfaces: the task-list overlay (Ctrl+Shift+T), the goal
widget, `get_goal`, the proposal/confirmation dialogs, and the `goal-service`
mutation boundary with its existing lock + revision + ledger guarantees.

**F1. Task detail pane — full depth, contract, evidence, and history (priority 1).** Description:
every task record already carries more than the UI shows: full description,
verification-contract lines, status + lightweight flag, a transition trail
(created → updated → completed with timestamps and the actor: agent, human, or
auditor), and the evidence recorded at each completion. Surface all of it in a
dedicated detail view opened from the task-list overlay (select a task →
Enter), showing the untruncated task text, its contract, its complete history
and evidence, and its position in the subtree (children/siblings); mirror the
same detail for the pending/next task in `get_goal`. Together with E2 (widget
depth, always visible) this gives a graduated detail story: glanceable depth in
the widget, full depth on demand in the overlay, and the same depth for the
agent.
Surfaces: **TUI** (overlay detail pane) and **agent** (`get_goal`). Rationale:
the audit found task records already hold everything this needs (descriptions,
contracts, evidence, ledger events), but every surface truncates to one line
and the trail is written to the ledger and then never read — the only reader of
evidence today is the completion auditor. User value: "seeing more task detail"
stops being a missing capability — humans can inspect why a task is done and
what it required, and agents can ground rework in the recorded evidence
instead of re-deriving it or re-doing completed steps.

**F2. Objective→task bootstrap at creation (priority 2).** Description: when a
goal is created (draft confirmation or `create_goal`) with no task list and the
objective contains numbered steps, checklist markers, or a "Verification
contract:" line, auto-derive a proposed task tree and show it in the existing
confirmation dialog so the human can edit/confirm it before the goal exists;
the agent path stays tool-driven (`set_goal_tasks`) with the proposal surfaced
as guidance. Surfaces: **human** (confirmation dialog), **agent** (creation
flow), **TUI** (dialog). Rationale: the audit found tasks are an afterthought —
goals are commonly created with an empty task list, and the objective's own
structure (sisyphus steps, success criteria) already contains a task skeleton
that is currently thrown away at confirmation. User value: goals start with a
trackable, human-approved plan instead of a blank checklist the agent must
remember to propose later.

**F3. Interactive task toggling in the task overlay (priority 3).** Description:
the Ctrl+Shift+T overlay becomes actionable: Enter toggles a pending task to
complete and back, with the same gates as `update_goal_task` (children must be
complete first, parent-complete blocks, lightweight-subtask rules); completing
a task with a verification contract opens the existing evidence-confirmation
dialog; all mutations flow through `goal-service` so locking, revision checks,
and ledger appends are unchanged. Surfaces: **TUI** (human). Rationale: the
audit found the overlay is read-only while the agent has full mutation tools —
a human maintaining tasks in the TUI must leave the overlay and use
`/goal-tweak`; the mutation machinery and dialogs already exist, so this only
wires the existing surface to the existing boundary. User value: humans can
keep the task tree current where they already look at it, with identical
safety gates to the agent path.

Prioritisation note: F1 first because it only surfaces data already recorded
(no new mutation surface), F2 next because it reuses the confirmation dialog,
F3 last because it adds the most UI machinery and requires gate parity with
`update_goal_task`.
