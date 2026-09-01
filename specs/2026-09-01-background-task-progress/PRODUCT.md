# Background Task Progress Ownership

## Problem

A focused goal can launch useful work with `bg_run`, receive a provenance-bearing `background-task-notification`, inspect the terminal output with `bg_logs`, and continue mutating or verifying the project while the goal no-progress counter continues to advance. This produces warnings during productive work and can open the circuit while a background job is the legitimate continuation owner.

## Required behavior

- A successful `bg_run` launch with automatic terminal follow-up enabled defers goal continuation to the background task notification.
- A provenance-bearing `background-task-notification` is a terminal outcome that permits normal goal continuation and resets stale no-progress recovery state.
- A successful `bg_logs` retrieval is productive evidence because it consumes a completed task result needed for the next decision.
- `bg_status` polling remains nonproductive.
- Failed `bg_run` launches do not establish ownership.
- `bg_run` calls that explicitly disable terminal notification or automatic follow-up do not establish continuation ownership.
- Existing async subagent ownership, repeated-observation detection, cancellation, and circuit-open behavior remain unchanged.

## Acceptance

Focused and integration tests reproduce the false positive before implementation and pass after the targeted classifier/event wiring is added. Full tests, type checking, linting, package layout, and diff checks pass before release.
