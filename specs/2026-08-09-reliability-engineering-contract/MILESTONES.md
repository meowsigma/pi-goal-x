# Milestones — reliability and maintainability contract

## 2026-08-09 — Phase 0: stabilize the worktree as a standalone release

The in-flight ledger-dedup/health-report changes were validated at the release
point and released as **pi-goal-x 0.26.3** (separate from any refactor work).

### Release-point validation (all green)

- `npm run check` (`tsc --noEmit`): clean.
- `node scripts/run-unit-tests.mjs all`: **756 tests pass** (51 unit files +
  integration + e2e), 0 failures.
- `test:selfcheck`: runner self-check OK, manifest matches.
- `npm pack --dry-run`: OK, 53 files.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --check`: clean.
- `bench:gate:naf`: fresh release-point after-baseline gated against the
  committed before-baseline — **PASS, 95/95 rows, no regressions** (refreshed
  `experiments/bench/baseline-naf-after.json` +
  `specs/2026-08-06-non-agent-flow-optimization/BENCH-AFTER.md`).

### Baseline figures (fresh, release point, local SSD, NAF campaign, B8)

| Category | Row | p50 | fs ops | Notes |
| --- | --- | --- | --- | --- |
| Cold start | `B5.startup.cold` | 1.9 ms | 4 | wall 1.8–1.9ms ×5 |
| Cold start (slow disk) | `B5.startup.cold.lat25` | 118.6 ms | 4 | +25ms/op emulation |
| Cold start | `B1.pool.cold` | 0.8 ms | 3 | pool read |
| Cold start | `B1.settings.cold` | 0.3 ms | 1 | settings load |
| Cold start | `B1.ledger.cold` | 1.2 ms | 1 | full ledger parse |
| Contention | `B5.lock.contended` | 13.1 ms | — | fail-fast, bounded ≈200ms window |
| Mutation write | `B2.mutationturn.task` | 1.2 ms | 19 | one task mutation, batched append |
| Mutation write | `B1.append.single` | 0 ms | 1 | single event append |
| Mutation write | `B1.append.x4` | 0 ms | 1 | one appendFileSync for 4 events |
| Ledger read | `B1.ledger.1k` | 0 ms | 0 | cache-served steady state |
| Ledger read | `B2.readturn.1g` / `10g` | 0 ms | 0 | read turn = zero fs ops |
| Ledger read | `B3.parse.1000` / `10000` | 0 ms | — | flat parse at scale |
| Ledger read | `B1.ledger.cold` | 1.2 ms | 1 | cold full-parse bound |

Key structural numbers for later phases: steady-state read turns cost **0 fs
ops** (cache); a cold session startup reads 4 files in ~2ms; a full ledger
cold parse is ~1.2ms at current sizes; a contended lock resolves by
fail-fast in ~13ms inside the ≈200ms bound.

### Release

- `package.json` 0.26.2 → **0.26.3**; CHANGELOG Unreleased folded into
  `## [0.26.3] — 2026-08-09`.
- Feature commit: ledger-dedup + health report + specs (`goal-service-ledger-
  dedup`, `project-improvement-audit`) + refreshed NAF baselines.
- `chore(release): 0.26.3`; tag `v0.26.3`; `npm publish`; GitHub release;
  pushed `main` + tag.
