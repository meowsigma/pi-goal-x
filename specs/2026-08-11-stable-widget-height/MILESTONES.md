# MILESTONES — Stable widget height so pi stays scrollable

## 2026-08-11 — Root cause confirmed and design decided

- User reported: with the expanded goal widget larger than the terminal, the
  terminal "always scrolls to the bottom" and cannot be scrolled up to read
  the agent's chat; growing the terminal reveals more of the widget and
  scrolling eventually works. Explicitly: pi itself (terminal scrollback /
  transcript), NOT widget-internal scrolling.
- Verified against pi-tui 0.84.1:
  - Regular mode (`TuiMainScreen`, the default; `getTuiMode()` returns
    "regular") has no layout tree — `render(width)` concatenates every child's
    full render into one buffer. Overflow lives in the terminal's scrollback;
    the user reads the chat by scrolling the terminal. `renderLayoutFrame`
    (paint-based, with ScrollView clipping) exists only on `TuiAltScreen`
    (fullscreen mode).
  - The widget (dock, `widgetContainerAbove`) is the last dynamic content in
    the buffer; its rendered line count sets the dock height → the buffer's
    line count → any change appends/removes lines at the bottom → the terminal
    scrolls to keep the bottom in view → the scrolled-up chat position is
    lost. In fullscreen mode a dock height change shrinks the transcript
    viewport and re-engages follow-end, resetting the chat scroll.
- Measured natural-height variability (`experiments/scroll-repro/
  widget-height-variability.mjs`, width 120): expanded dashboard natural
  spans 4..31 across goal-state changes (activity feed 0→5, current-task
  contract/evidence wrapping, verification text, budget, task growth). On a
  24-row terminal (cap 18) the rendered height churns 4→13→15→14→18; the
  audit dashboard churns 8→11→13→8. Each change = a buffer line-count change
  = a bottom-scroll.
- Design decided: **sticky cap** — once the widget's natural height exceeds
  the terminal cap in a regime, render exactly `cap` lines on every later
  render of that regime (head slice when natural > cap, deterministic blank
  padding when natural dips below). Terminal resizes clear the latch and
  re-evaluate `min(natural, newCap)` (grow reveals more widget); regime
  changes (goal id/status, state kind, compact↔expanded, debug, tasks
  disabled) clear the latch. Fits case stays byte-identical; unbounded
  without a terminal (mock/harness/status) unchanged.
- Spec written: `specs/2026-08-11-stable-widget-height/PRODUCT.md`, TECH.md.

## 2026-08-11 — Implementation

- `extensions/widgets/goal-widget.ts`:
  - Added `applyStableHeightBound(lines, terminalRows, state, regime)` —
    pure given the latch state, exported for tests.
  - `GoalWidgetComponent` now holds a `stableHeightState` latch
    (stickyCap / stickyRegime / stickyTerminalRows); `render()` renders the
    current branch unbounded (`renderNatural`) and applies the sticky bound.
    All widget states (focused, audit, result card, unfocused, none, debug
    panel) flow through the single bound; the previous double-bound
    (renderGoalWidgetLines + component) is replaced by one sticky bound at
    the component level.
  - `boundWidgetRenderLines` unchanged (pure head slice, still used by
    `renderGoalWidgetLines` for direct callers).
- No new timers; no 2J/3J/1049 emissions (the widget never writes directly).

## 2026-08-11 — Validation

- New unit tests in `tests/goal-widget.test.ts` (8): latch on cap crossing
  up; deterministic padding on crossing down; fits byte-identical and never
  latches; resize clears the latch and adapts; regime change re-evaluates;
  unbounded without a terminal; component-level height constancy across a
  goal-state sequence; grow-reveals-more / collapse-re-latches.
- `experiments/scroll-repro/widget-height-bound.mjs` rewritten on the real
  geometry (ScrollView transcript + VStack dock + real GoalWidgetComponent +
  real TuiMainScreen): steady-state stability (height + buffer length
  constant after the latch, 0 wipes), fits byte-identical, resize
  adaptation, regime reset, audit dashboard sticky on a small terminal, and
  the retained 2026-08-10 invariants (bounded ≤ cap, chat reachable,
  editor/footer visible, no wipes).
- Full suite: 781/781 pass; `tsc --noEmit` clean; eslint clean.

## Open items

- User validation of the terminal scroll-up experience in a real terminal
  (the goal's final success criterion).
