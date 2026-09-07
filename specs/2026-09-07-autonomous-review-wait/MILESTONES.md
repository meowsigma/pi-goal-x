# Autonomous review/wait implementation log

## 2026-09-07 — investigation and approved direction

- Parent independently traced the status-loop incident and the released control flow. Ordinary no-work cycles always reach another checkpoint; coaching is not an enforced review transition. Completion auditing is executor-requested and gated by pending tasks.
- User chose full autonomy and asked to continue: real whole-goal review, concrete next work/final audit, or an owned quiet automatic recheck. Waiting must not become model-owned user pause or a fake completion.
- Read-only debugger failed at provider admission (retired configured model), before producing findings. No model substitution was made for that diagnosis. Findings above are parent evidence, not a successful debugger report.
- Created isolated worktree `/home/sigma/.pi/worktrees/pi-goal-x-review-wait`, branch `fix/review-before-repeat`, from released `1aa1b15bb878b517559748dd9156b25420c93a37`. Shared only the existing test dependency directory through an ignored node_modules symlink.
- Wrote PRODUCT and TECH. Compared stronger coaching, a separate scheduler/worker, and the selected existing runtime plus independent review. Kept stable model tools, final audit gate and human lifecycle ownership.
- Design self-review caught an important lifecycle boundary: an automatic audit started from agent_settled cannot rely on a future turn_end to archive. Plan now requires publishing the real result and invoking the shared archival operation, with full lifecycle proof.
- Baseline check/lint/unit/integration launched as `b19e197dc`; results not yet accepted in this log.

## Work remaining

- [ ] Baseline verified from terminal output.
- [ ] Incident-shaped full-lifecycle RED regression.
- [ ] Real read-only reviewer SDK proof and source-labelled current requirements.
- [ ] Durable single-owner wait/recovery state and fake-clock race tests.
- [ ] Actual work/task completion/final audit/archival transitions.
- [ ] Ignored advice, provider exhaustion, budgets, disabled settings, delegated ownership and user cancellation proof.
- [ ] Both actual NQA/goal loader orders and native Escape regressions.
- [ ] Independent review, repairs, parent validation and honest limitations.

No live goals, user settings, installed sources, external accounts or protected BTW changes have been modified. No release or installation is claimed.
