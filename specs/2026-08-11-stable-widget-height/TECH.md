# TECH — Stable widget height so pi stays scrollable

## Mechanism (verified against pi-tui 0.84.1)

pi's default interactive mode is **regular mode** (`TuiMainScreen`,
`settings-manager.js getTuiMode()` defaults to `"regular"`). Regular mode has
no layout tree: `TuiBase.render(width)` concatenates every child's full render
into one buffer — `documentContainer` (header + **all** chat lines) + pending +
status + goal widget + editor + footer — and writes the diff to the terminal.
Overflow past the terminal height lives in the terminal's own scrollback; the
user reads the chat by scrolling the **terminal**. (`renderLayoutFrame`, the
paint-based layout resolver with ScrollView clipping/scrollbars, exists only
on `TuiAltScreen` — fullscreen mode.)

The goal widget is the last dynamic component in the buffer (via
`widgetContainerAbove` in the dock). Its rendered line count therefore sets
the dock height, and the dock height sets the buffer's line count. When the
widget's rendered line count changes:

- a line is appended/removed at the bottom of the buffer → the terminal
  scrolls to keep the bottom in view (universal emulator behavior) → the
  user's scrolled-up position is lost;
- in fullscreen mode the transcript ScrollView's viewport height changes →
  `updateLayout` re-engages follow-end → the chat scroll resets to the bottom.

The 2026-08-10 fix removed the `\x1b[2J\x1b[H\x1b[3J` wipes by capping the
widget to `terminalRows − 6` (head slice), but the cap value is constant only
when the *natural* height is constantly above it. Natural height varies with
goal state (see measurements below), so the rendered height still churns at
the boundary and the buffer still grows/shrinks.

### Measured natural-height variability (experiments/scroll-repro/widget-height-variability.mjs)

Width 120, terminal rows 24 → cap 18:

| state | natural expanded | rendered expanded |
|---|---|---|
| goal created, 3 pending tasks | 4 | 4 |
| +1 task complete (activity grows) | 13 | 13 |
| +2 complete, feed 3 items | 15 | 15 |
| current task gains contract+evidence | 14 | 14 |
| goal verification contract added | 21 | **18** |
| token budget configured | 24 | 18 |
| 12 tasks, 5 complete | 25 | 18 |
| activity feed capped at 5 | 31 | 18 |

Rendered height changes on 4 of 8 transitions. Compact natural spans 4..14
(over a 7-line cap on 13-row terminals). Audit dashboard natural: 8 → 11 →
13 → 8 while the animation runs.

## Design: sticky cap (per-mode latch)

### Component state (`GoalWidgetComponent`)

```ts
private stickyCap: number | undefined;            // committed rendered height once latched
private stickyRegime: string | undefined;         // regime key when latched
private stickyTerminalRows: number | undefined;   // terminal rows when latched
```

Regime key: `goalId | goalStatus | stateKind | expanded | debug | disableTasks`
where `stateKind ∈ { focused, audit, result, unfocused, none }`.

### Algorithm (`applyStableHeightBound`)

```
natural = unbounded render of the current branch (incl. debug panel)
if no terminalRows -> return natural (unbounded; mock/harness/status)
cap = max(1, terminalRows - WIDGET_HEIGHT_RESERVE)

if stickyTerminalRows != terminalRows: reset sticky   // resize: adapt to new height
if stickyRegime != regime:             reset sticky   // mode/state change

if natural.length > cap:
    stickyCap = cap; return natural.slice(0, cap)     // at the cap: latch + head slice
if stickyCap != undefined and natural.length < stickyCap:
    return natural padded with "" to stickyCap        // committed height: pad, never churn
return natural                                         // fits case: byte-identical
```

Properties:

- **Latch**: once natural exceeds the cap, every later render in the same
  regime and terminal size renders exactly `cap` lines (head slice when
  natural > cap, blank-padded when natural ≤ cap). The buffer line count is
  constant → the terminal never scrolls on widget updates.
- **Adapt**: on resize the latch is cleared and `min(natural, newCap)` rules
  again — growing the terminal reveals more of the widget; once it fits,
  everything renders. Re-latches whenever natural exceeds the new cap.
- **Determinism**: the latch is a pure function of (natural height, regime,
  terminal rows) — no timers, no Date, no randomness; the same goal state on
  the same terminal renders the same lines every time.
- **Padding**: blank lines (empty strings) after the box footer; the diff
  writes them once and never again (they never change). Honest filler — the
  dashboard's `… +N more` markers are only used for real hidden content.

### Integration

- `boundWidgetRenderLines(lines, terminalRows)` **stays as-is**: pure head
  slice, no-op when `terminalRows` missing. Still applied inside
  `renderGoalWidgetLines` when a caller passes `terminalRows` (pure-function
  contract for direct callers / tests).
- `renderGoalWidgetLines` keeps its `terminalRows` option; the component no
  longer passes it — the component renders **natural** (unbounded) and applies
  `applyStableHeightBound` at the end, so it can distinguish
  natural>cap (latch) from natural≤cap (fits/sticky-pad) and can append the
  debug panel before bounding.
- All widget branches flow through the single sticky bound in the component's
  `render()`: focused/audit/unfocused (via `renderGoalWidgetLines`),
  result card, and the debug panel.
- Regular mode: constant buffer line count → no bottom-scroll. Fullscreen
  mode: constant dock height → constant transcript viewport → no chat-scroll
  reset. Both renderers are covered by the same widget-side fix.

## Why not the alternatives

- **Fixed-structure dashboard** (constant natural height by construction, e.g.
  fixed row budgets for every section): changes the visual design (truncation
  instead of wrapping) and is a much larger renderer change; the sticky cap
  preserves today's visuals and only intervenes when the widget is taller than
  the terminal.
- **Never re-render the widget at the cap** (freeze content): hides real goal
  state changes (task completions, usage) — misleading.
- **Padding before the box footer / continuation markers**: re-flowing the box
  is complex; `…`/`↑ N more` markers would falsely imply hidden content.

## Validation

- `experiments/scroll-repro/widget-height-variability.mjs` — natural-height
  measurement (root-cause evidence, above).
- `experiments/scroll-repro/widget-height-bound.mjs` — extended to drive the
  real `TuiMainScreen` frame (ScrollView transcript + VStack dock + real
  `GoalWidgetComponent`) through the goal-state sequence at fixed rows,
  asserting: widget rendered height constant (after latch), buffer line count
  constant, 0 `\x1b[2J`/`\x1b[3J`/1049; the fits case byte-identical; resize
  adaptation; regime reset.
- `tests/goal-widget.test.ts` — unit tests for `applyStableHeightBound`
  (latch, cap crossing, resize reset, regime reset, fits byte-identical,
  unbounded-without-terminal determinism).
- `npm test` (0 failures), `npm run check` + eslint clean.
