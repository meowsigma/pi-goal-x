# PRODUCT — Stable widget height so pi stays scrollable

## Problem

When the expanded goal widget is larger than the terminal window, the user
cannot hold a scroll position to read the agent's chat output: the terminal
keeps jumping to the bottom. The user's own diagnosis:

> "The number of lines keeps changing in the terminal, causing it to always
> scroll to the bottom."
> "When you expand the terminal height more, more of the widget shows at the
> bottom. When we expand enough, we can scroll."

The prior fix (spec `2026-08-10-widget-height-bound-scrollback-fix`) caps the
widget's rendered height at `terminalRows − 6` (a head slice), which keeps
pi-tui on the differential render path and eliminates the `\x1b[2J\x1b[H\x1b[3J`
scrollback wipes. But the cap alone does not stop the rendered line count from
**changing over time**: the widget's natural height is not constant.

Measured on a 24-row terminal (cap = 18) while a goal runs, the rendered
height churns through 4 → 13 → 15 → 14 → 18 as the goal progresses
(activity-feed growth, current-task contract/evidence wrapping, goal
verification text, budget, task growth). The audit dashboard churns 8 → 11 →
13 → 8 while an audit animation runs.

Every height change alters the dock height, which alters the number of lines
pi writes into the terminal buffer. A different line count means a rewrite
that ends below the current viewport → the terminal scrolls to the bottom
(universal terminal behavior: a new line at the bottom pushes the viewport
down) → the user is yanked away from the chat they were reading.

## Goal

Make the widget's **rendered height invariant to goal-state changes** whenever
the widget is at the terminal cap, so the buffer's line count stops changing
and the terminal stops jumping to the bottom. The user scrolls **pi / the
terminal** (terminal scrollback in regular mode, the transcript in fullscreen
mode) to read the agent's chat output; the widget must not fight that scroll.

## Behavior (user-visible)

1. **At the cap, the height never changes.** Once the widget's natural height
   reaches the terminal cap in the current mode, the widget renders exactly
   `cap` lines on every subsequent render of that mode — no matter how the
   goal state evolves (usage ticks, task completions, activity-feed growth,
   contract/evidence text, verification, budget). The terminal buffer stops
   growing, so scroll-up holds.

2. **Adapts to the terminal.** Resizing the terminal re-evaluates the cap:
   growing the terminal reveals more of the widget at the bottom (up to its
   natural height); once the whole widget fits, everything renders and
   scrolling works — the "when we expand enough, we can scroll" case.

3. **Fits case unchanged.** When the widget has never exceeded the cap (a
   normal terminal), rendering is byte-identical to today. `/goal-status` and
   golden renders stay unbounded (no terminal bound at all when no terminal
   exists — mock TUIs, headless contexts).

4. **All widget states share the same rule**: compact, expanded, audit, audit
   result card, debug, unfocused.

5. **Sticky is per mode.** Toggling compact↔expanded, switching goals,
   entering/leaving the audit or result card, toggling debug mode, changing
   goal status, or disabling tasks re-evaluates from natural (the sticky
   height belongs to one mode/state).

## Out of scope

- Widget-internal scrolling (the user asked for pi/terminal scroll, not a
  widget scrollbar; the head-slice tail drop and the dashboard's own
  task-list scroll keys are unchanged).
- pi-tui's renderer and the terminal emulator's scroll-on-output behavior
  (pi/emulator-owned).
- pi's own status/spinner line and pending-messages container.
- Chat growth from agent output (inherent streaming — the user reads between
  updates).
- The questionnaire/task-confirmation dialogs (already guarded by their own
  churn guard).
- Alternate screen (banned, unchanged).

## Non-negotiable constraints

1. No new timers, polling, or periodic renders.
2. Never emit DECSET 1049 or `\x1b[2J`/`\x1b[3J` from pi-goal-x.
3. The terminal bound stays optional (default unbounded) — `/goal-status` and
   golden renders byte-identical.
4. The fits case (natural ≤ cap, never latched) renders exactly as today.
5. Deterministic height: once at the cap, the widget renders exactly `cap`
   lines for that mode until the mode/state changes — no oscillation.
