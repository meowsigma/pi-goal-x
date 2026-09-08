# Autonomous review before repetition

## User decision and problem

The user wants full autonomy: do useful work, check the whole current goal, and own any necessary waiting and follow-up. They chose automatic rechecking rather than a manual handoff, then asked to continue.

The released implementation requeues ordinary empty runs forever. Its escalating recovery text does not invoke review. Completion auditing is requested by the executor and pending task gates can prevent that audit from starting. A changing clock can also receive observational progress credit. Thus a model can repeatedly announce a future obligation without checking whether it is required, already satisfied, or actually scheduled.

## Required behavior

### Work → independent review → work / completion / scheduled wait

1. Two consecutive settled runs without meaningful work trigger a runtime-owned, isolated, read-only whole-goal review. The threshold starts review; it is not a cutoff that pauses or abandons the goal. Review is a real invocation, not a prompt asking the executor to request one.
2. A completion request blocked by unfinished task bookkeeping must also request this review, without bypassing the existing completion gate or receiving productive-work credit.
3. Review inspects the objective, every task and verification contract, evidence, latest explicit user decisions, and recent actual work. It distinguishes a user-required outcome from an executor-added obligation. A deadline or 'up to 24 hours' notice alone proves neither a prohibition on earlier checks nor a future task's necessity.
4. Review can identify concrete remaining work, verify individual pending tasks against their unchanged contracts, recommend the normal independent completion audit, or justify a genuinely time-dependent recheck. It cannot remove/skip tasks, loosen contracts, grant permissions, disable auditing, or mark the goal complete itself.
5. Independently verified task completions use the same task invariants and persisted evidence as ordinary task completion. Children must be satisfied before their parent. Final goal completion still uses the existing completion flow; review output is not a completion approval.
6. A real external wait requires a specific unfinished criterion, observed evidence of the dependency, an explicit recheck action, a valid future UTC instant, and `wait.taskIds` explicitly covering every remaining pending task (including dependency-blocked parents). It never marks future evidence verified or silently ignores an actionable task. The runtime persists and arms one goal-owned wake and returns a receipt before calling the check scheduled. The goal remains active and incomplete, not user-paused. Ordinary checkpoints are suppressed during this wait.
7. At the due time, the focused active goal resumes the recorded recheck automatically. A due time is a time to inspect the real state, never evidence that the criterion is now satisfied. Long timers must not overflow Node's timer limit.
8. If an executor ignores an actionable review and continues returning no-work text, do not reopen a hot ordinary-checkpoint loop or repeatedly buy the identical review. Retain the review instruction, record the lack of execution, and retry quietly with goal-owned backoff. This is honestly labelled execution recovery, not a verified external dependency or completion. Meaningful work resets execution recovery, not unrelated audit-infrastructure admission.
9. Review infrastructure/protocol failures remain NOT PROVEN. Bound their own attempts independently of ordinary work, retain diagnostics, and allow safe independent work/recovery without repeated provider hammering. No silent provider/model substitution, enabling an opt-in Oracle, or overriding an auditor-disabled setting.

### Ownership, persistence, and human control

- Goal-x remains the single wake owner. NQA can reinforce instructions but must not wake a waiting goal or compete with review. Existing background/delegated ownership suppresses review and goal checkpoints until a provenance-bearing terminal event.
- Reuse the existing runtime/timer/ledger mechanisms; do not create a sleeping LLM, shell sleep worker, parallel scheduler, or arbitrary future child with no owning-goal context.
- Rehydrate deferred wakes after reload. While Pi is not running, its in-process timers cannot fire; documentation/receipts must say that overdue work is recovered on return, not promise an external daemon that does not exist.
- Genuine user pause/cancel, budgets, focus changes, shutdown, and updated user instructions invalidate stale in-flight review effects and stale timer callbacks. Preserve human focus ownership. Explicit resume or changed scope can supersede a wait; ordinary status requests must not accidentally erase it.
- Review and completion cannot race. Stale review results cannot change a replacement goal, overwrite newer contracts, or complete a goal paused during review. Usage-only revisions are not a new task/authorization state.
- Keep unmet criteria intact and preserve security/authorization boundaries. Only source-labelled records emitted by the native interactive/RPC input boundary are current decision context; synthetic transcript text and dialog ids without paired host provenance are untrusted. Loaded extensions have full host privileges, so this boundary is trusted-extension scope rather than cryptographic isolation. Never infer user approval from an executor narrative, external page instructions, or a tool-shaped string.

### Evidence and visible state

- Standalone clock probes and ordinary lifecycle/status polling do not reset progress. Runtime observations require paired successful results; history reconstructs assistant tool-call arguments by tool-call id and remains conservative when arguments are missing. Compound shell commands and real diagnostic/implementation tools retain existing support, including unknown MCP/desktop/research tools.
- Review-provider failure admission remains independent of ordinary productive work: clearing retained advice preserves the exhausted failure count, so a full retry cycle cannot buy a fifth review without an explicit user/config/scope reset.
- Whole-goal progress review receives the escaped goal-level verification contract in its own section, separate from task contracts and authority-bearing user decisions.
- Show one concise review result or waiting/recovery receipt. Surface the real recheck time, action, and runtime limitation through goal inspection and authoritative current-turn guidance. Do not repeatedly ask the user to pause.
- Do not publish private incident transcripts or real account details in specs/tests. Use synthetic incident-shaped fixtures.

## Alternatives considered

1. Stronger coaching or rejecting clock credit alone: smallest patch, but still no forced review and no owned future check. Rejected.
2. A new subagent schedule/sleeping background worker: existing schedules launch fresh independent children and do not automatically retain the focused goal's cancellation and audit ownership. Unnecessary integration and duplicate-owner risk for this repair. Rejected.
3. Runtime review plus a durable deferred continuation using existing goal machinery: selected. It changes control flow while retaining the existing execution and completion gates.

## Acceptance

- Synthetic full lifecycle reproduces many empty 'not due' replies plus changing clock output. The repaired runtime invokes review and transitions to actual work, the normal audit, or an owned quiet wait; merely containing new prompt words is not a pass.
- The pending bookkeeping case is reviewed despite blockCompletion, but completion still requires verified tasks and the final auditor's approval.
- Waiting issues one durable receipt, suppresses repeated checkpoints, reloads safely, and wakes once at/after the deadline without falsely completing anything.
- Repeated ignored actionable advice and failed review infrastructure are tested across full agent cycles, not only seeded state. No hot ordinary loop or silent abandonment.
- Both actual NQA/goal load orders, native Escape ownership, prior audit retry/exhaustion behavior, isolated read-only reviewer construction, and budget/cancellation/focus races remain covered.
- No live goal, user settings, installed source, or external account is modified during implementation/proof. Release/installation remains a separate parent-owned action after acceptance.
