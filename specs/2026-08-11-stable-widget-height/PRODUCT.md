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

## Emulator-level root cause (new session finding)

The 0.27.3 sticky cap only engages when the natural height exceeds the cap
(`natural > cap`). That leaves the **fits case** (terminal taller than the
widget but the frame still overflows via a long chat) rendering the *varying*
natural height — the same churn, just below the cap threshold. The user
confirmed this exact failure:

> "It is getting scrolled to the bottom even when the height is bigger than
the widget now!"
> "When the window is tall enough it does not snap back."

Reproduced at emulator level (real `TuiMainScreen` + ScrollView transcript +
VStack dock + real `GoalWidgetComponent` feeding `@xterm/headless`,
`experiments/scroll-repro/emulator-repro.mjs`):

- **Fits case (40-row terminal, cap 34, expanded)**: rendered height varies
  22 → 24 → 26 → 23 → 25 across goal-state updates → buffer `baseY` moves
  (2 yank triggers) → a multiplexer/emulator following the pane bottom
  re-pins. No 2J/3J (all in-place rewrites) — the churn alone is the yank.
- **Scrolled-up holds (Scenario D)**: user scrolled up 10 lines, then goal
  updates grow the buffer 57 → 59 → 61 (Δ4) → the pane-bottom-following
  multiplexer re-pins the viewport.
- **Capped case (resize below the widget, expanded 40→24 and unexpanded
  30→14)**: stable — widget constant 18/8, buffer constant, 0 churn after
  the resize. The resize itself emits one pi-tui-inherent `2J+3J` (pi's own
  height-change full render — out of scope).

So the cap-only latch fixes the at-cap regime but not the fits regime: the
rendered height must be **constant in every case**, not just at the cap.

## Goal

Make the widget's **rendered height invariant to goal-state changes in every
case** (fits and capped), so the buffer's line count stops changing and the
terminal stops jumping to the bottom. The user scrolls **pi / the terminal**
(terminal scrollback in regular mode, the transcript in fullscreen mode) to
read the agent's chat output; the widget must not fight that scroll.

## Behavior (user-visible)

1. **The height never changes within a mode.** At the first render of each
   mode (regime), the widget latches its rendered height: the natural height
   if it fits, else the terminal cap. On every later render of that regime it
   renders exactly the latched line count — no matter how the goal state
evolves (usage ticks, task completions, activity-feed growth,
contract/evidence text, verification, budget). Growth is head-sliced (content
priority is top-down: identity → status → progress → tasks → details →
hints), shrink is blank-padded — the height never changes, so the buffer line
count never changes and scroll-up holds.

2. **Adapts to the terminal.** Resizing the terminal re-evaluates the latch:
growing the terminal reveals more of the widget at the bottom (up to its
natural height); once the whole widget fits, the latch is the natural height
and everything renders.

3. **Fits case is stable too.** When the widget fits, its rendered height is
now the first-render natural height for the mode (constant thereafter) — this
replaces the old varying-natural fits behavior (the source of the new
finding). `/goal-status` and golden renders stay unbounded (no terminal bound
at all when no terminal exists — mock TUIs, headless contexts).

4. **All widget states share the same rule**: compact, expanded, audit, audit
   result card, debug, unfocused.

5. **Sticky is per mode.** Toggling compact↔expanded, switching goals,
   entering/leaving the audit or result card, toggling debug mode, changing
   goal status, disabling tasks, or the goal's first task appearing
   re-evaluates from natural (the sticky height belongs to one mode/state).

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
4. Within a regime with a terminal, the rendered height is constant — the
   first-render latch (natural or cap), never oscillating; resizes and regime
   changes are the only times the height may change.
5. Deterministic height: within a regime, the widget renders exactly the
   latched line count (natural or cap) until the mode/state or the terminal
   size changes — no oscillation, no per-update growth.
