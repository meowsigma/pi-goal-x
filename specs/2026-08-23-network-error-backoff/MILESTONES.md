# Milestones — network-error recovery backoff

## 2026-08-23 — Design

- Identified that `agent_end` precedes Pi's built-in retry settlement, so the
  goal extension must defer its fallback to `agent_settled`.
- Chose a bounded 5-step exponential ladder (5–80 seconds), preserving the
  existing protection from runaway provider-error loops.

## 2026-08-23 — Implementation and validation

- Added network-error classification from Pi assistant error metadata and a
  pure bounded-delay policy.
- `agent_end` records a network recovery candidate; `agent_settled` schedules
  it, so a later success in Pi's own retry loop clears the candidate instead.
- Recovery timers are unref'd and cancelled by every ordinary continuation
  reset, including user-driven turns, focus/lifecycle changes, and shutdown.
- Validation passed: `npm run check`, `npm run lint`, `npm test` (837 tests),
  `npm run test:integration` (31 tests), `npm pack --dry-run`, and
  `git diff --check`.

## 2026-08-25 — Regression fix: 503 outages never engaged recovery; unbounded default

- User report: repeated `Error: 503: {"type":"server_error","message":"Error
  from provider (Console): Upstream request failed: Endpoint is unavailable."}`
  followed by "Retry failed after 3 attempts" left the goal stranded with no
  goal-level backoff.
- Root cause: `isNetworkErrorAssistantMessage` matched only the literal text
  `network error` in `rawStopReason`/`errorMessage`. The 503 `server_error`
  payload contains neither string, so `goal-events.ts` routed it down the
  generic-error path (persist only, no recovery scheduled).
- Classification broadened: `TRANSIENT_PROVIDER_ERROR_RE` now matches HTTP
  5xx-style transient failures (502/503/504/529, `server_error`,
  service unavailable, bad gateway, gateway timeout, upstream request
  failed, endpoint is unavailable, overloaded). Auth/malformed-request 4xx
  errors remain non-retryable.
- Behavior change (user-directed): recovery is UNBOUNDED by default — it
  keeps retrying on the ladder, plateauing at `maxDelayMs` (default 80s),
  instead of giving up after five attempts.
- Settings: new layered `networkRecovery.{maxAttempts,maxDelayMs}` leaves
  (global/project `pi-goal-x-settings.json` plus
  `PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS` / `PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS`
  env overrides), following the existing oracle-settings conventions.
  `maxAttempts: 0`/unset = unbounded; bounded caps still exhaust with the
  actionable resume-hint warning.
- Notification wording distinguishes bounded (`recovery 1/5`) from
  unbounded (`recovery 1, unbounded`) progress.
- New suite `tests/goal-network-recovery.test.ts`: exact-payload regression
  through the real `agent_end` → `agent_settled` lifecycle, escalation past
  the old 5-attempt cap, configured-cap exhaustion hint, success resets the
  counter, plus classification unit coverage. Fast lifecycle tests shrink
  delays via `PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS`.
- Validation passed: `npm run check`, full `npm run test:serial`.
