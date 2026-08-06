# Non-agent flow optimisation (2026-08-06) — PRODUCT.md

Campaign: **naf** · Goal: benchmark every non-agent flow of pi-goal-x on
current main with the existing agent-free B1–B9 harness (extended to cover
the 0.24.0 unified-dashboard surface), then make every flow with meaningful
headroom measure ≥10x faster than a fresh BEFORE baseline, with zero
regressions elsewhere.

## Behavior stance

This campaign is **performance-only**. User-visible behavior (dialogs, tool
headings, command surface, prompts' *information content*) is preserved; unit
and integration tests must stay green (`npm test`, `npm run check`).

The one deliberate semantics nuance: **session-level read caching**.
Today `loadGoalSettings`, `readActiveGoalPool`, and `readGoalLedger` re-read
disk on every call (a per-turn reconcile does multiple scans). The campaign
introduces write-through caches keyed by cwd:

- reads return the cached value without touching disk;
- every extension-mediated write (goal create/update, ledger append, settings
  save) invalidates or bumps the cache, so **all extension-visible changes
  are always observed**;
- the only path that can go stale mid-session is an *external* hand-edit of a
  goal/settings/ledger file by another tool or process; those are picked up
  on the next full reconcile that detects a signature change (dir/file
  mtime), and at session restart. Cross-process extension writers are still
  mutually excluded by the per-goal lock and the revision check (which reads
  through the cache but is invalidated by any lock-guarded write).

If any optimization turns out to require an actual behavior change, it is
flagged to the user before landing — never silently folded in.

## Out of scope

- Anything requiring live agent sessions, model calls, or network (LLM
  latency cannot be guaranteed 10x).
- Auditor agent-session logic (the auditor *dispatch* path is measured, not
  the auditor itself).
- Feature changes, new slash commands.
- The four goal dialogs and goal tool-call headings stay byte-identical.
- The blocked 2026-08-04 review-plan goal's signoff (separate concern; its
  work is already merged to main).
