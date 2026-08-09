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

## 2026-08-09 — Phase 1a: GitHub Actions CI

- Added `.github/workflows/ci.yml`: on push to `main` and every PR, matrix
  `node: [22, 24]` runs `npm ci` → `npm run check` → `test:all` →
  `test:selfcheck` → `npm pack --dry-run` → `npm audit --omit=dev` →
  `bench:gate:naf`.
- **Found + fixed a Node-22 incompatibility**: `scripts/run-unit-tests.mjs`
  passed `--test-isolation=none` unconditionally, which Node 22 rejects (the
  flag only exists since 23.4). The runner now probes the running binary
  (`--test-isolation=none --test --help` exit code) and omits the flag on
  older releases. Verified both paths:
  - Node 26: 756/756 pass with `--test-isolation=none`.
  - Node 22.23 (official binary): 756/756 pass via the process-isolation
    fallback; `tsc --noEmit` clean; selfcheck OK; `bench:gate:naf` PASS.
  - Full CI-equivalent sequence also green on Node 26 from a clean `npm ci`.
- The real Node 22.15+ floor is exercised on the GitHub runner on push.

## 2026-08-09 — Phase 1b: engineering contract

### package.json

- `engines`: `{"node": ">=22.15.0"}` (verified: full suite + tsc + gate green on
  Node 22.23 and Node 26; the runner probe already handles the
  `--test-isolation` flag difference across the range).
- **Peer ranges replace wildcard `"*"` after compatibility testing**: pi
  SDK floor verified by running the full suite (756/756) in a sandbox pinned
  to `@earendil-works/pi-*@0.83.0` + typebox 1.3.11, and against 0.84.1 in
  the real project. Declared `>=0.83.0 <0.85.0` for all three pi packages;
  `typebox: ^1.3.11`.
- **Safe typebox patch taken**: `^1.0.58` → `^1.3.11` (installed 1.3.11;
  the one available patch per `npm outdated`).
- Superseded `docs/goal-ts-refactor-test-strategy.md` removed from the
  `files` list — `npm pack --dry-run` now ships only current docs.

### Dependabot

- `.github/dependabot.yml`: weekly updates for `github-actions` and `npm`
  ecosystems, versioning-strategy auto.

### Lint gate (small, high-signal)

- `eslint.config.mjs` (flat config): eslint:recommended + TS parser;
  `no-undef`/`no-unused-vars` off for TS (tsc owns those; the core rule also
  misfires on interface-conformance params and re-exported symbols),
  `no-regex-spaces` off (deliberate multi-space matches in tests),
  `no-empty` with `allowEmptyCatch`, `@typescript-eslint/no-explicit-any`
  scoped to `extensions/**` (test scaffolding may use `as any`).
- Fixes applied: 9 `no-useless-escape` (unnecessary `\"` in regex literals),
  5 `no-control-regex` documented as deliberate ANSI-SGR matching via
  eslint-disable comments, 6 `any` in extensions (3 narrow structural casts
  over SDK stream events; 3 documented disables where the pi SDK itself
  types `Model<any>`, sdk.d.ts:18; 1 typed tool-input map in goal-drafting).
- Removed dangling `n/`-rule disable comments (the globals package's own
  config pattern leaked into two test files).
- `npm run lint` wired into CI after `check`. `eslint .` exit 0.

### Stricter TypeScript: `noUncheckedIndexedAccess` (incremental, now on)

- 161 errors when enabled: 36 in extensions/, 125 in tests — all mechanical
  `possibly undefined` index accesses, fixed with behavior-preserving `!`
  assertions (provably in-bounds loop accesses, guarded matches) or local
  narrowing (the width-safety loop). Fixed extensions first, then test
  files; `tsc` kept green throughout. Flag now enabled in `tsconfig.json`;
  `npm run check` clean; 756/756 tests pass (type-only changes).

### TypeScript 7 evaluation (isolated, documented verdict)

- Method: installed `typescript@7.0.2` (the native 7.0.2 tsc) into a temp
  copy + swapped into `node_modules` temporarily (package.json/lock
  untouched), ran the project `tsc --noEmit`.
- Result: **TypeScript 7.0.2 compiles the project with zero errors** — no
  code changes required for the type-check gate. Notes: `-p` works when the
  binary is invoked directly; TS7's `--version` prints "TypeScript: No errors
  found" (cosmetic output change); Node's runtime type stripping is
  unaffected.
- Verdict: adoption is viable; do it as an isolated PR (typescript 5.x →
  7.0.2 devDep bump) with CI + lint + full suite confirmation, kept separate
  from feature work. Not merged in this goal — evaluation only.
