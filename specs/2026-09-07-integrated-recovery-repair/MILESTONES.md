# Repair evidence

## Final parent validation

- Candidates: goal-x 0.30.20, NQA 0.8.7, BTW/pi-learn 0.4.2.
- Parent full validation: goal check/lint, 896 unit tests; 40 integration tests with the real host-loader fixture routed to SDK 0.84.1 and 0.85.1 respectively; BTW 74 tests; NQA 83 tests plus packed install/load and package checks. No relevant skips. Diff checks passed in all three repositories.
- Integration requires explicit `PI_NQA_EXTENSION_PATH`; missing sources skip with a diagnostic, never silently select another checkout. `PI_HOST_PACKAGE_ROOT` optionally selects the host package tree (default: local node_modules). Both loading orders explicitly assert the specialized NQA recovery marker and productive-work guidance.
- Native proof uses actual loaded goal/BTW extensions, real TUI and CustomEditor, public overlay focus APIs, and an AbortController wired to the editor interrupt callback. Focused BTW Escape does not abort the main editor; native unfocus restores the main editor and Escape both pauses the goal and invokes interruption. No manual component-focus assignment substitutes for dispatch.
- Native proof isolates its temporary cwd and global settings, then runs shutdown and cleanup. Run with `PI_HOST_PACKAGE_ROOT=/path/to/node_modules PI_BTW_EXTENSION_PATH=/path/to/btw.ts node scripts/native-goal-btw-proof.mjs`.
- Parent module-reload regression first failed because separately loaded modules both produced `btw-controller-1`; UUID controller identities fixed the collision. Cross-controller, per-overlay, rejection, and shutdown protection remain covered.
- Refreshed the official test manifest after self-check exposed two missing unit entries and the combined integration entry; self-check now passes.
- Independent review verified the unchanged audit lease/fourth-failure/resume regressions and the repaired native/load-order proof. Its final test-source fallback finding was removed before release validation.
- These are runtime and instruction-composition guarantees for tested paths, not guarantees of model compliance or blanket SDK compatibility. Declared peer ranges remain unchanged. Genuine user lifecycle boundaries and fail-closed completion auditing remain intact.

## Implementation history

- User authorized repair, proof, repository push, and installation.
- Installed bases: goal-x 4845b3f, NQA fd42241. BTW repo base d07a117 has a separate existing uncommitted orphan-tool-result change; implementation worktree excludes it.
- Baseline combined integration: 36/36 on SDK 0.84.1 and 0.85.1. These tests originally loaded goal before NQA.
- Added disposable order assertion: goal-first 36/36; NQA-first 35/36, failing missing specialized recovery.
- Native TUI reproduction /tmp/pi-escape-overlay-repro.mjs: [goal.pause, btw.dismiss]. Existing goal/BTW standalone tests did not cover global input dispatch together.
- Parent-created lane board: goal+BTW writer owns pi-goal-x-integration-repair and pi-learn-escape-repair; NQA writer owns pi-nqa-integration-repair. Installed sources and live goals are read-only until parent release.

## Audit repair implementation

- Added the v1 ephemeral BTW focus-ownership handoff (`__pi_extension_focus_ownership_v1`) driven by the actual overlay focus setter and public overlay handle; Escape now yields to focused BTW only, while goal modals, auditor Escape, and unfocused/main Escape retain their existing ownership.
- Added one-shot audit recovery leases for pending independent tasks. Exhausted/cooling-down completion requests remain fail-closed, inject explicit pivot guidance, and dispatch at most one post-settlement continuation; productive work or user reset clears the lease. No-pending-task cases do not auto-continue.
- Reworded no-progress recovery so NOT PROVEN remains unmet evidence and skips remain restricted to explicit user direction or hard contradiction.
- RED evidence: before implementation, `node --experimental-strip-types --test tests/goal-modal-escape.test.ts tests/goal-prompts.test.ts tests/integration/extension.test.ts` failed focused BTW Escape, no-progress policy, and audit-recovery assertions. BTW baseline lacked cross-extension focus ownership.
- Worker-stage proof commands/results (superseded by final parent validation below):
  - `npm run check` — passed.
  - `npm run lint` — passed.
  - `npm test` — passed after repair (896 tests; prior run exposed 2 stale wording expectations, then passed on rerun).
  - `npm run test:integration` — passed (38 tests).
  - `cd /home/sigma/.pi/worktrees/pi-learn-escape-repair && npm test` — passed (71 tests).
  - `git diff --check` — passed in both worktrees.
  - Worktree SDK 0.84.1 TUI `TuiMainScreen.handleTerminalInput` focus-order harness — passed: focused BTW produced `btw.dismiss` only; unfocused/main Escape produced `goal.pause`.
  - `node --experimental-strip-types tests/integration/nqa-goal-host.test.ts` — passed actual host-loader proof in both goal-first and NQA-first orders, asserting NO-QUESTIONS-ASKED, active-goal, and AUDIT RECOVERY PIVOT prompt frames. Candidate NQA source: `/home/sigma/.pi/worktrees/pi-nqa-integration-repair/extensions/no-questions-asked.ts`.
  - `PI_HOST_PACKAGE_ROOT=/home/sigma/.npm-global/lib/node_modules PI_BTW_EXTENSION_PATH=/home/sigma/.pi/worktrees/pi-learn-escape-repair/extensions/btw.ts node --experimental-strip-types scripts/native-goal-btw-proof.mjs` — passed host 0.85.1 loader + real goal/BTW overlay/TUI dispatch proof; focused BTW Escape dismissed BTW and left the goal running. The script is checked in and explicitly skips when external host/BTW paths are unavailable.
  - Read-only resume-incident verification: the incident ledger showed one user pause followed by user resume, then active checkpoints; no second pause. Raw private session/goal records are excluded from the release. Added a synthetic pause-mid-run → explicit resume → queued-checkpoint prompt regression without claiming provider/model compliance.
  - Repair follow-up: recovery lease now separates pending dispatch from issued/coached state; final/fourth actual auditor infrastructure failure also schedules one independent-work pivot. BTW rejected-overlay cleanup releases ownership only for the current runtime.
  - Focus follow-up: BTW ownership now carries controller and overlay identities; stale focus/unfocus/shutdown callbacks cannot clear or reclaim a newer controller's claim. Existing goal parsing remains version/owner/focused compatible.
  - `npm test -- tests/btw.runtime.test.ts` — passed (72 runtime tests); full pi-learn `npm test` passed 73 tests, including two-controller stale close/shutdown and rejection cleanup regressions.
  - `tmp=$(mktemp -d); cd "$tmp" && PI_HOST_PACKAGE_ROOT=/home/sigma/.npm-global/lib/node_modules PI_BTW_EXTENSION_PATH=/home/sigma/.pi/worktrees/pi-learn-escape-repair/extensions/btw.ts node --experimental-strip-types /home/sigma/.pi/worktrees/pi-goal-x-integration-repair/scripts/native-goal-btw-proof.mjs; rm -rf "$tmp"` — passed host 0.85.1 native lifecycle proof: focused BTW Escape dismisses only; reopened visible unfocused BTW allows main goal Escape/pause; shutdown cleanup runs.
