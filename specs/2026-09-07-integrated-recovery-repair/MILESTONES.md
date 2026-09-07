# Repair evidence

- User authorized repair, proof, repository push, and installation.
- Installed bases: goal-x 4845b3f, NQA fd42241. BTW repo base d07a117 has a separate existing uncommitted orphan-tool-result change; implementation worktree excludes it.
- Baseline combined integration: 36/36 on SDK 0.84.1 and 0.85.1. These tests originally loaded goal before NQA.
- Added disposable order assertion: goal-first 36/36; NQA-first 35/36, failing missing specialized recovery.
- Native TUI reproduction /tmp/pi-escape-overlay-repro.mjs: [goal.pause, btw.dismiss]. Existing goal/BTW standalone tests did not cover global input dispatch together.
- Parent-created lane board: goal+BTW writer owns pi-goal-x-integration-repair and pi-learn-escape-repair; NQA writer owns pi-nqa-integration-repair. Installed sources and live goals are read-only until parent release.
