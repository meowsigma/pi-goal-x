# Unified Dashboard

`pi-goal-x` renders one dashboard component in two presentation modes. The
above-editor widget, `/goal-status`, and the completion flow all derive from
the same presentation model (`extensions/widgets/goal-dashboard-model.ts`),
so they can never drift apart on data or terminology.

- **Compact mode** — a persistent summary above the editor while a goal is
  focused.
- **Expanded mode** — the full dashboard: task tree, current-task details,
  verification, and recent activity. This replaces the former task-list
  overlay; `Ctrl+Shift+T` now toggles between compact and expanded instead of
  opening a separate overlay.

Everything shown is derived from persisted goal state and the durable ledger:
progress, the current task, verification status, the audit result, and recent
activity are never fabricated for display.

## Compact mode

Always visible above the editor while a goal is focused:

```text
╭─ pi-goal-x ─ Add CSV export to reports────────────── 12m47s · 18.2K tok ─╮
│ ● In progress · Focused: yes · Other goals: 2                            │
│ Tasks  [███████████░░░░░░░] 3/5 · 60%                                    │
├─ Tasks ─────────────────────────────────────────────────────────────────┤
│ ✓ t1  Review reports page and data source                                │
│ ✓ t2  Implement filtered CSV export                                      │
│ ▸ t3  Add the download button                                            │
│ · t4  Add documentation                                                  │
│ … +1 more task                                                           │
│ Current  t3 · Add the download button                                    │
│ Subtasks [████████████░░░░░░] 2/3 · 67%                                  │
│ Verify   Run npm test with zero failures.                                │
│ File     .pi/goals/active_goal_g1.md                                     │
╰─ Ctrl+Shift+T: expand tasks─────────────────────────────────────────────╯
```

Compact rows, in order:

1. Header (rounded corners): title plus elapsed time and token usage.
2. Status: colored symbol + explicit label, focus state, other open goals
   (`·`-separated). Colors come from the theme with a monochrome fallback.
3. Token budget (when configured): `⛽ Budget 18.2K / 50K · 36%`.
4. Top-level task progress (`3/5 · 60%`); a skipped top-level task counts as
   done (§9.1).
5. Task list section: the top-level tasks shown by default with colored
   markers (✓ complete, ▸ current, ~ skipped, · pending), an aligned id
   column, truncated titles, and a `… +N more` overflow line when the list is
   longer than the row budget (5 rows at wide, 4 medium, 3 narrow, 2 minimal).
6. Current task: `Current  t3 · Add the download button`.
7. Current-task subtask progress (`2/3 · 67%`) when the current task has
   direct children (the current task's subtasks stay inline).
8. Goal-level verification contract (first line, truncated).
9. Blocked or paused detail (reason, suggested action).
10. Active (or archived) goal file path.
11. Footer with the expansion shortcut.

When every top-level task is done, the current line reads
`Current  All tasks complete`. With `disableTasks` enabled the task rows are
omitted entirely.

## Expanded mode

`Ctrl+Shift+T` expands the same component:

```text
╭─ pi-goal-x ─ Add CSV export to reports ─────────────── 12m47s · 18.2K tok ─╮
│ Status: ● In progress · Focused: yes · Other goals: 2                      │
│ File: .pi/goals/active_goal_...                                             │
├─ Progress ──────────────────────────────────────────────────────────────────┤
│ [██████░░░░] 3/5 tasks · 60%                                               │
├─ Tasks ─────────────────────────────────────────────────────────────────────┤
│ ✓ t1  Review reports page and data source                                  │
│ ✓ t2  Implement filtered CSV export                                        │
│ ▸ t3  Add the download button ☑                                            │
│   ✓ t3.1  Add loading state                                                 │
│   ✓ t3.2  Generate timestamped filename                                    │
│   · t3.3  Add error handling                                                │
│ · t4  Add documentation                                                    │
│ ~ t5  Add and run tests                                                    │
├─ Current task ──────────────────────────────────────────────────────────────┤
│ t3 · Add the download button                                               │
│ Subtasks [███████░░░] 2/3 · 67%                                            │
│ Contract: The button downloads a CSV using the active filters.             │
├─ Verification ──────────────────────────────────────────────────────────────┤
│ Run npm test with zero failures.                                            │
├─ Recent activity ───────────────────────────────────────────────────────────┤
│ ✓ Completed “Implement filtered CSV export”. — Done                        │
│ ▸ Started “Add error handling”.                                             │
╰─ Esc/Ctrl+Shift+T: collapse ────────────────────────────────────────────────╯
```

Task markers (§9.2): `✓` complete, `~` skipped, `▸` current, `·` pending.
A `☑` suffix marks a task that carries its own verification contract; the full
contract is shown in the current-task block.

When no persisted current task exists, the dashboard falls back to the first
pending task for display and marks it as inferred — the fallback is never
persisted.

## Status states

| Symbol | Status | Shown for |
| --- | --- | --- |
| `●` | In progress | active goal with auto-continue on |
| `○` | Idle | active goal with auto-continue off |
| `◐` | Paused (user/agent) | paused goal, with reason |
| `⊘` | Blocked | blocked goal, with blocker and suggested action |
| `⛽` | Budget limited | goal at its token budget, with usage detail |
| `✓` | Complete | completed goal, before/after archival |

Status labels are always explicit words, so the dashboard stays readable
without the symbols.

## Unfocused state

When open goals exist but none is focused:

```text
╭─ pi-goal-x ─ Goal focus required ───────────────────────────────────────────╮
│ 3 open goals are available.                                                │
│ Run /goal-focus to choose the goal for this session.                       │
╰─────────────────────────────────────────────────────────────────────────────╯
```

## Audit view

During an independent completion audit the widget switches to a structured
audit dashboard with the same visual system:

```text
╭─ Independent completion audit ─ anthropic/claude-sonnet:high ─── 2m18s ─╮
│ ✓ Objective and success criteria                                         │
│ ✓ Verification contracts                                                 │
│ ✓ Tasks and recorded evidence                                            │
│ ◌ Workspace inspection                                                   │
│ · Final decision                                                         │
│ [███████░░░] 72%                                                         │
╰─ Esc: stop audit ─────────────────────────────────────────────────────────╯
```

Raw auditor tools and output are hidden by default; they appear only in
expanded/debug audit mode or when the audit failed and diagnostics are needed.

After the audit, a result card shows the outcome:

```text
╭─ Audit result ─ APPROVED ─────────────────────────────────────────────────╮
│ ✓ Objective satisfied.                                                    │
│ ✓ Verification requirements satisfied.                                    │
│ ✓ Required tasks and evidence accepted.                                   │
╰────────────────────────────────────────────────────────────────────────────╯
```

A rejected audit keeps the goal open, shows `CHANGES REQUIRED` with the
auditor's findings, and returns to the normal dashboard so work can continue.

## Keybindings

| Key | Action |
| --- | --- |
| `Ctrl+Shift+T` | Toggle the dashboard between compact and expanded |
| `Esc` | Collapse the expanded dashboard; otherwise pause the goal |
| `Esc` (during audit) | Stop the audit and choose to continue working or complete without audit |

## Width behavior

Layout modes (§5.5):

- **Wide (≥100 columns):** full border, multiple fields per line, full task
  titles, wider progress bars, current-task details.
- **Medium (70–99):** mostly one field per line, shorter bars, truncated
  paths and contracts.
- **Narrow (50–69):** compact border, short labels, reduced metadata, one
  task line at a time.
- **Very narrow (<50):** the essential summary only — status, task progress,
  the current task, and the verification contract.

The renderer never emits a line wider than the terminal width: all alignment
and truncation is visible-width aware (ANSI colors, Unicode, and double-width
characters included). Golden tests assert `visibleWidth(line) <= width` for
every rendered line at 40, 50, 60, 80, 100, and 140 columns.

## `/goal-status`

`/goal-status` renders the same model as the widget.

- Standard mode: a static compact-dashboard rendering, current-task details,
  recent activity, and the last audit result. No effective-settings noise.
- `/goal-status verbose`: goal id, revision, full objective, the complete
  task tree with full evidence and contracts, recent ledger history, token
  budget detail, pause/blocker detail, active and archived paths, the last
  audit report, and effective settings with provenance.

## Migration behavior

The current-task focus is a new **optional** persisted field
(`currentTaskId`) on goal records.

- Legacy goal files load without it and are **never rewritten** just because
  the field is absent.
- A persisted `currentTaskId` is accepted only when it references an existing
  *pending* task; it is cleared when that task is completed, skipped, or
  removed during normalization.
- Task-list restructuring preserves the current task only while its id
  remains pending; otherwise the focus clears and the dashboard recomputes.
- For display only, the dashboard may infer the first pending task as the
  current task and marks it as inferred.

## Compatibility

- Existing goal-file formats, archived goals, settings, slash commands, and
  direct-goal behavior are preserved.
- The task-overlay shortcut is retained but now expands the unified
  dashboard; the separate overlay registration is removed.
- Headless behavior remains functional without TUI rendering, and
  audit-disabled completion remains explicit and distinct from approval.
