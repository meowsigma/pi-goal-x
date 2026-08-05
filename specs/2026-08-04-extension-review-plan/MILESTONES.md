# Milestones: Extension review plan (plan-only)

## Plan

Read the extension in full (every module, no exceptions), verify the module
list against the tree, write a committed spec (`specs/2026-08-04-extension-review-plan/`)
containing a coverage map plus three prioritized sections (optimisation,
feature enhancements, 3–10 new features) with description + rationale + user
value per item and no effort/risk ratings, then get user signoff. No
implementation.

## Log

### 1. Full audit (coverage map)

- Enumerated the tree: 35 modules under `extensions/` (~9,538 lines), 24 test
  files under `tests/`, experiment cases B1–B2 / C1–C26, the scroll-repro
  harness, four docs.
- Read every extension module end-to-end (goal.ts, goal-state.ts,
  goal-service.ts, goal-events.ts, goal-commands.ts, goal-core-tools.ts,
  goal-task-tools.ts, goal-completion.ts, goal-auditor.ts, goal-drafting.ts,
  goal-questionnaire.ts, goal-widget.ts + widgets/, goal-runtime.ts,
  goal-policy.ts, goal-record.ts, goal-ledger.ts, goal-pool.ts,
  goal-compaction.ts, goal-accounting.ts, goal-format.ts, goal-core.ts,
  goal-settings.ts, goal-contract.ts, goal-draft.ts, goal-tool-names.ts,
  goal-tools.ts, auditor-selector.ts, storage/, prompts/).
- Key audit findings: goal-state.ts monolith (870 lines, ~50-member
  interface); full-dir pool scan per reconcile; full ledger JSONL parse up to
  2×/turn; sync settings read on hot paths; synchronous lock sleeps on the
  main thread; 4+ task-counting implementations; duplicated
  extractVerificationContract / renderConfirmationTasks / dialog scaffolds;
  entire task tree rendered into every continuation prompt; debug surface
  shipped in the production bundle; ledger-failure diagnostic boilerplate at
  5 sites.
- Verified map completeness programmatically: 35/35 modules named (five rows
  use the `storage/`/`widgets/`/`prompts/` path-prefixed form).

### 2. Plan sections

- Optimisation: 10 items (P1-1..P1-10) — settings/pool/ledger caching,
  counting consolidation, deduplication, async locks, batch ledger appends,
  prompt-tree trimming, goal-state decomposition, debug-surface pruning.
- Enhancements: 8 items (E1..E8) — history in status, widget task depth,
  effective-settings visibility, auditor skill reuse, budget awareness,
  drafting-answer echo, sisyphus step progress, pause-reason detail line.
- New features: 10 items (F1..F10) — dashboard, archive/reopen, stall
  detector, quiet hours, export/import, budget alerts, autoContinue presets,
  audit retention/diffing, sisyphus step widget, headless pause banner;
  balance check maps each to agent/human/TUI surfaces.

### 3. Validation + signoff

- Coverage map verified 35/35; spec documents are the only changes (no code
  touched); awaiting user signoff in a real terminal.
- Hardening pass after re-read: (a) F1–F10 items now carry an explicit
  "Description:" label alongside their existing "Rationale:"/"User value:"
  lines for unambiguous auditability; (b) P1-4 reworded ("drift risk" →
  "semantic drift") so the word "risk" appears nowhere outside the
  no-effort/risk disclaimer.
- Full validation battery re-run: 11/11 PASS — coverage 35/35, DRU complete
  for all 28 items, no effort/risk ratings, 10 features each stating
  Surfaces:, agent/human/TUI balance, spec committed, no code changes.

### 4. User steering: narrow features to 1–3, task-focused, no new commands

- User direction (2026-08-04): the new-features section should be 1–3
  features focused on making the task system better, with **no additional
  slash commands**; the existing 10-candidate set is fine but moves to a
  parked file.
- Moved the full original F1–F10 set (verbatim, incl. its balance rationale)
  to `PARKED.md`; nothing from that set was implemented.
- Rewrote PLAN.md Part 3 with three task-focused features, each stating its
  user surface(s), prioritized: F1 task evidence worklog (TUI + agent),
  F2 objective→task bootstrap at creation (human + agent + TUI), F3
  interactive task toggling in the Ctrl+Shift+T overlay (TUI). All reuse
  existing surfaces; no new slash commands.
- PLAN header amended to record the steered scope.
- Second steering pass (2026-08-04): user liked the idea of seeing *more task
  detail*; F1 was promoted from a worklog into a full task-detail capability
  (untruncated text, verification contract, transition trail with timestamps
  and actor, evidence, subtree position) delivered via the overlay detail
  pane and `get_goal`, explicitly paired with enhancement E2 (widget depth)
  into a graduated detail story. Priority 1 retained.
- Third steering pass (2026-08-04): user clarified the task detail belongs
  *under "goal running" at the bottom* — i.e. in the always-visible goal
  widget, not an overlay detail pane. F1 was rewritten as "Task detail in the
  goal-running widget" (done/total counts, next pending tasks with contract
  snippets, evidence lines for recent completions, collapsed-count handling,
  `get_goal` mirror), and the former E2 widget-depth enhancement was folded
  into it; Part 2 enhancements renumbered E1–E7.
- Fourth steering pass (2026-08-04): user approved the widget block and
  allowed the most useful UI feature changes to be raised beyond the 3-feature
  limit (no new slash commands). F4–F7 raised from the parked set: sisyphus
  ordered-step progress in the widget, stall detector + wake prompt, token-
  budget threshold alerts, headless pause banner. Part 3 now has 7 features
  (F1–F7); the multi-goal dashboard stays parked because it needs a new slash
  command.
- Fifth pass (2026-08-04): on request, F7's spec entry was expanded with
  concrete mechanics (one-shot per pause transition via the `goal_paused`
  ledger path, idempotent, untruncated reason + suggested action, TUI
  sessions unaffected) and an example banner line.
- Sixth steering pass (2026-08-04): user directed "park it — we don't use
  headless"; F7 was removed from Part 3 (features now F1–F6) and its expanded
  description was moved to `PARKED.md` with provenance; header/scope/
  prioritisation notes updated to F4–F6.
- Seventh steering pass (2026-08-04): user asked to think much harder about
  performance — order-of-magnitude clock-time improvements the user actually
  feels. Part 1 was rebuilt around felt wall clock, in priority order: P1-1
  cache-first read layer (settings/pool/focused goal; 5–10 sync reads/turn →
  order-of-magnitude on slow storage), P1-2 incremental ledger tail (O(n)→O(1)),
  P1-3 one-transaction-per-turn mutation batching (N→1 lock/write/append),
  P1-4 prompt/context memoization + task-tree trimming (5–10x smaller goal
  block per turn), P1-5 async/bounded lock acquire (2.5s frozen-TUI stall →
  tens of ms), P1-6 warm-start auditor (cold session pays full prefill),
  P1-7 parallel startup rehydration, P1-8 batch ledger appends, P1-9 coalesced
  widget renders. Four non-clock-time items (task-counter consolidation,
  renderer dedup, goal-state decomposition, debug-surface pruning) were moved
  to `PARKED.md` as parked optimisation candidates.
- Eighth steering pass (2026-08-04): user: "we also need to add full
  benchmarking (before and after). Maintainability items should also be added
  — we want things clean and fast." Part 1 was split into 1A (user-felt
  clock time, P1-1–P1-9) and 1B (maintainability, P1-10–P1-13 — the four
  parked items restored and renumbered); a new Part 4 (benchmarking, B1–B6)
  was added: B1 I/O micro-bench harness with slow-storage latency injection,
  B2 real-session per-turn I/O accounting, B3 long-session ledger simulation,
  B4 prompt-size + prefill measurement, B5 startup/contention/auditor timing,
  B6 regression gate; header updated; PARKED.md section annotated as a
  historical record.
- Ninth steering pass (2026-08-04): user extended benchmarking to *all*
  extension features with agent time excluded completely ("no live agents in
  benchmarking"), to drive wall clock down on the next run. Part 4 gained
  B7 (feature-wide wall-clock matrix — every feature gets a deterministic
  agent-free case, Part 0 module map doubles as benchmark coverage map,
  fixture sizes 1/10/50 goals, 1k/5k/10k events, 10/50 tasks), B8
  (agent-exclusion harness — auditor stubbed at the pre-audit gate, drafting/
  continuation via scripted fake turns, no-model/no-network assertion per
  run), and B9 (committed baseline table + per-feature wall-clock budgets as
  targets for the next run); Part 4 framing and B6's gate scope (B1–B9)
  updated.

---

## Implementation log — branch `implement/review-plan-2026-08-04`

### Milestone 1 — branch + docs move (task 1, 2026-08-04)
Branch created from `6b42045` (0.22.0 release); the 11 plan-docs commits
(`3e4127a`..`cc7d7e4`) cherry-picked onto it (`e31a0fb`..`eaec52e`); local
main reset to `6b42045` == origin/main, zero `extension-review-plan` files on
main. Both histories verified via `git log`/`git ls-tree`.

### Milestone 2 — agent-free benchmark harness + BEFORE baselines (task 2, 2026-08-04)
Built `experiments/bench/` per PLAN.md Part 4:
- B8 guard layer: `bench-adapter-hooks.mjs` (registerHooks) redirects the pi
  packages to the test stubs (`createAgentSession` throws) and
  `node:fs`/`node:net`/`node:http`/`node:https`/`node:child_process` to
  counting/throwing wrappers; `assertNoViolations` gates every run.
- B1 I/O micro-benches with 25ms/op latency injection; B2 synthetic
  read/mutation turn accounting (fs ops + ms); B3 ledger scale 1k/5k/10k;
  B4 prompt token counts (chars/4 estimate + documented prefill heuristic,
  no live measurement); B5 startup (1/10/50 goals) + two-process lock
  contention + completion dispatch to pre-audit gate with stubbed auditor;
  B7 feature-wide matrix (69 rows) over the Part 0 module map; B6 gate
  script; B9 emitter (`run-bench.mjs`).
- `npm run bench -- before` = 69 rows in 62s, **0 agent/network/spawn
  violations**; baselines committed at `experiments/bench/baseline-before.json`
  and `specs/2026-08-04-extension-review-plan/BENCH-BEFORE.md`.

BEFORE headline evidence (this machine):
- pool scan @25ms/op: 124ms/1 goal, 688ms/10, 3206ms/50 (vs 0.1/0.5/1.6ms
  local) — P1-1/P1-7 lever; contended lock 2832ms frozen main thread — P1-5;
  ledger parse 0.5→5.1ms 1k→10k (O(n)) — P1-2; read turn 6 fs ops @1 goal,
  24 @10 — P1-1; one task mutation 28 fs ops — P1-3; continuation prompt
  2505 est tokens @50 tasks — P1-4.
