# Decision-led autonomy — technical plan and implementation record

**Architecture:** extend GoalReviewDecision/GoalContinuationState and reuse GoalService persistence, GoalRuntime admission/timers, and the independent final auditor. No second execution scheduler. NQA supplies question/authorization guidance and standalone completion verification, not automatic execution ownership. Existing TypeScript/JavaScript, Node timers/crypto and Pi APIs only; no new dependencies.

**Execution status:** implemented and parent-verified locally. Exact gates, review limitations and delivery state are in [MILESTONES.md](MILESTONES.md). This dated specification preceded implementation; the sections below incorporate the independent review repairs and the user's subsequent retry clarification.

## Goal continuation

- `GoalReviewDecision` admits `work`, `audit`, `wait` or `hold`. Work requires bounded `nextAction`, `expectedObservation` and `decisionImpact`; the retained instruction contains all three.
- The progress reviewer receives retained advice separately from bounded recent actual tool/outcome evidence. Twelve tool cycles admit a strategic review even during productive-looking activity. Activity does not itself erase advice or prove a criterion.
- Holds retain ACTIVE/incomplete status, objective and contracts, but own no recurring timer. Reviewer unavailability holds immediately, not after an invisible retry sequence. Legacy exhausted review counters normalize to a hold at reload/compaction/tree admission.
- GoalService persists before dispatch. GoalRuntime checks hold/wake state at both admission and actual continuation dispatch. A hold cannot replace an external-wait lease.
- Hold admission hashes include canonical goal/task scope, relevant reviewer/executor selection and settings. Status questions/negations preserve holds; genuine instructions or relevant changes can re-admit review. Legacy missing keys are baselined rather than treated as new authority.
- Successful paired native async launches retain bounded goal/session/scope ownership. Matched custom terminal notices are consumed once. Native background `details.task.id` launch / `details.id` terminal shapes and subagent host correlation footers are supported; foreign, duplicate, user-role and uncorrelated notices fail closed. A terminal receipt admits inspection, not completion.

## Lifecycle truth

Every context request reconciles authoritative state and replaces one `pi-goal-current-lifecycle` frame. This includes in-run pause, budget limit, unfocus, held ACTIVE and scheduled ACTIVE states; current context supersedes historical assistant prose and older turn-start frames.

An unproductive present-tense false-paused assertion receives one conservative reconciliation per focus. Negations, historical/quoted discussion, genuine pause, productive work and existing hold/wake owners are excluded. This constrains runtime context/admission; it cannot guarantee model compliance.

Task/child evidence contracts, stale-input/focus checks, budgets, genuine cancellation, owned future wakes and independent final completion audit remain separate authorities. Progress review never substitutes for final approval.

## NQA scope and routing

- Remove `recoverFromUserGate` / `resumeLogicalWork` and every automatic execution send. Settlement, retry completion and auditor cooldown only refresh policy/tool admission.
- Keep routine question suppression, task-list structural confirmation policy, real authorization boundaries and explicit independent standalone completion validation. Ordinary tools are not denied by a competing NQA productivity gate.
- Both loader orders defer to held/waiting/inactive focused goals. Focused work is not converted into a standalone transient objective.
- An explicitly configured auditor model/effort is binding. Unavailable/failed primary routes do not silently substitute session/worker models. Without an explicit auditor, select the live/cached session model, or the default only when there is no session model. The separately exported pool utility can still consume an explicitly supplied candidate list.
- Scope full-throttle to direct parent-owned diagnosis and optional bounded execution; preserve implementation/security/verification safeguards without mandatory diagnostic ceremonies.

## Diagnostics

`goal-diagnostics.ts` stores best-effort redacted bounded summaries in `.pi/goals/diagnostics.json`: at most 64 records / 256 KiB, outside the lifecycle ledger. It includes progress-review decisions, selected route/effort, observed usage/error/timing and request hashes. Full payloads, headers and full tool output are omitted.

Goal and NQA source hashes snapshot bytes at module initialization. NQA uses one replaceable `.pi/no-questions-diagnostics.json` receipt. Native/unit assertions require real 64-hex hashes on successful capture. Hashes and selected client labels do not attest final wire payloads, remote served-model identity or historical loaded code. Common credential redaction does not cover arbitrary unlabeled secrets.

## Retry admission and user clarification

The user chose **“cap at 3”**, while preserving indefinite recovery for traffic/connectivity problems such as 429/400/500/WebSocket failures.

- Positively identified recoverable 400, 429, 5xx, rate-limit, overloaded-server, network/WebSocket/stream failures may retry indefinitely with existing capped backoff. Malformed requests and arbitrary diagnostic numbers are not sufficient traffic evidence.
- Terminal authentication/permission, exhausted credits/balance, plan/budget and explicit retired-model evidence overrides transient wrappers. Generic 404 is not model retirement. Genuine context overflow remains native compaction's responsibility.
- Other hidden reissues, including unknown errors and repeated length continuations, share a three-reissue request budget. Empty-output nudges retain a stricter one-nudge limit. Traffic interleaving and duplicate/synthetic callbacks do not renew the budget.
- Any new input invalidates the old request's retry owner. Only genuine input renews the budget/clears user abort; successful response, explicit retry/reset and new session also re-admit as documented.
- Check terminal admission before dispatch after idle and after every hidden turn, not just the initial agent_end. Preserve a currently visible terminal result; do not invent one when the SDK removed live error state.
- Goal defers secondary network backoff while pi-retry is enabled/owns recovery. Native start/cap outcomes correlate by retry identity and originating goal/focus/session/scope. Only a matched current cap can create a hold; foreign/stale events and prior holds/future wakes are preserved. No new scheduler is added.
- The saved Goal-only fallback uses three attempts and an 80-second delay ceiling. The library's explicit unbounded option remains available. This is not a universal HTTP-request cap across provider/SDK internals.

## Parent configuration

Saved changes: Astra/high default main and Goal auditor; Astra/high/no-fallback reviewer/oracle/debugger overrides; Luna bounded-worker/default-subagent routing. Automatic Ponytail extension injection is disabled while its skill remains available. Global instructions scope diagnostic workflow ceremonies explicitly.

The local summary hook requires exact `sour-local/qwen3.8-27b` context/payload identity and genuine summarization system instructions; Astra, other routes and quoted user history are unchanged. Configuration backups/private incident details stay outside the repositories. Existing sessions were not impersonated or silently switched.

## Verification / stop condition

Focused RED/GREEN tests cover lifecycle holds/re-admission, stale provenance, both loader orders, terminal and bounded retry paths, cancellation races, routing and payload scoping. Full relevant gates are recorded in MILESTONES; selected native paths use SDK 0.85.1 without expanding the declared peer range.

One Astra/high review blocked the initial candidate; parent repairs and the later user-clarified policy were verified directly, not independently re-reviewed. No repeated broad runs solely for documentation. No live goal/session/account/training changes. Implementation acceptance preceded publication/activation; the user subsequently authorized commit, push and installation of the accepted changes. Delivery checks exact remote/installed Git identities without dependency upgrades, a version bump or npm publication.
