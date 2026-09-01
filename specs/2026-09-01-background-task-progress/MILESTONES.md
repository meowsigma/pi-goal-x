# Milestones

- [x] Confirmed root cause: `0.30.12` recognizes async subagents but not `bg_run`, `background-task-notification`, or `bg_logs` result consumption.
- [x] Selected targeted ownership semantics; rejected broad all-tool progress credit because it would revive polling loops.
- [x] Added failing classifier and progress-evidence tests, then golden integration coverage.
- [x] Implemented minimal classifier/event wiring through the existing continuation owner state.
- [x] Full verification passed: 885/885 tests, TypeScript, ESLint, diff checks, and 59-file package.
- [x] Fusion review found realistic `bg_logs` presentation metadata could spoof changed output; added a failing regression and normalized result evidence to content only.
- [x] Independent re-review returned no findings after the metadata repair.
- [x] Released, pushed, and installed as pi-goal-x 0.30.13.
