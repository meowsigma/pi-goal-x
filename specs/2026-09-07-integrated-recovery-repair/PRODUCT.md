# Integrated recovery repair

User approved: fix every finding from the installed goal-x/NQA/BTW audit, prove the repairs, push to the existing repositories, and install from those repositories.

## Required behavior
- Escape with the BTW overlay focused dismisses/cancels that side surface only. Main-editor Escape still aborts/pauses the main goal. A visible but unfocused BTW overlay must not swallow main Escape.
- Completion-audit infrastructure cooldown/exhaustion never becomes a false completed/paused/blocked lifecycle transition. Independent actionable work receives actionable recovery guidance and a continuation opportunity even if the last turn only attempted an unavailable audit. Do not restore a rapid repeated-audit or denied-call loop.
- NQA research/alternatives/attempt/evidence-journal coaching is present for active goals regardless of package ordering. It must not override an authoritative user pause, cancellation, budget limit, or lack of focus.
- Repeated no-progress is coaching, not an arbitrary termination or permission to weaken criteria. Task skipping remains limited to the enforced user-direction/hard-contradiction policy. NOT PROVEN is an evidence state, not success.
- Existing stale-lifecycle prompt isolation, auditing integrity, delegated/background sole wake ownership, user authorization and safety remain intact.

## Scope and isolation
- Goal writer: /home/sigma/.pi/worktrees/pi-goal-x-integration-repair (base 4845b3f).
- Same goal writer may make the minimum BTW focus integration in /home/sigma/.pi/worktrees/pi-learn-escape-repair (base d07a117).
- NQA writer: /home/sigma/.pi/worktrees/pi-nqa-integration-repair (base fd42241).
- Do not change host SDK installation, live goals, live settings, or installed package checkouts during implementation.
- /home/sigma/pi-learn/extensions/btw.ts has a pre-existing orphan-tool-result fix. Preserve it and do not include it in the release without separate authorization.

## Acceptance evidence
Tests must fail on the old behavior and pass on the repaired implementation. Exercise native TUI input order rather than calling onEscape alone; exercise NQA-first and goal-first order with the actual extension loader; exercise audit failure/exhaustion through agent_end and agent_settled with pending independent work. Run package suites/static checks and an independent cross-repository review before publication. No provider requests are necessary for deterministic lifecycle verification. Report model behavioral guarantees as instructions, not proof of model compliance.
