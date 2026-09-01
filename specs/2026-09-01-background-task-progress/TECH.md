# Background Task Progress Ownership — Technical Design

## Design

Extend the existing delegated-progress boundary rather than broadening the global meaningful-tool allowlist.

1. Classify `bg_run` as asynchronous ownership only when its input leaves both `notifyOnCompletion` and `triggerOnCompletion` enabled (omitted means enabled).
2. Classify custom messages with `customType: "background-task-notification"` as terminal delegated wakes. User prompt text is never inspected, preserving notification provenance.
3. Treat successful `bg_logs` calls as progress, but keep `bg_status` excluded so status polling cannot reset the breaker.
4. Reuse the existing pending asynchronous call set and `delegatedWakeThisRun` state in `goal-events.ts`; do not introduce a second continuation mechanism.

## Data flow

- `tool_call(bg_run)` records the call id as pending ownership.
- `tool_execution_end(bg_run)` establishes `awaiting` only after success.
- `agent_end` sees `awaiting`, resets recovery, and yields without queuing a goal checkpoint.
- The terminal custom message is recognized from the context event as `terminal`.
- Work in the notification-triggered run, including `bg_logs`, resets the no-progress chain and normal goal continuation resumes.

## Safety and regressions

- A failed launch cannot establish ownership.
- Notification/follow-up-disabled jobs cannot strand continuation.
- `bg_status` remains nonproductive.
- Quoted notification text cannot impersonate a terminal event.
- Existing subagent semantics remain unchanged.
