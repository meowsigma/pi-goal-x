# No-progress auto-continuation circuit breaker

## Problem

An active auto-continue goal can enter a successful empty-turn loop: the assistant repeatedly states that work is impossible or asks the user to clear the goal, calls no productive tools, and `agent_end` nevertheless queues another checkpoint immediately. One observed goal emitted about 950 near-identical turns over two hours after its last meaningful action.

## Required behavior

- A successful turn with meaningful goal work continues normally.
- The first two consecutive successful turns without meaningful work receive explicit, escalating recovery turns that require a materially different, tool-using strategy.
- A third consecutive no-progress turn opens a circuit breaker: no further automatic checkpoint is queued, the goal remains active and recoverable, and the UI reports why automatic turns stopped.
- User-driven input resets the breaker. Meaningful work resets the consecutive no-progress count.
- Provider/network error recovery, user cancellation, completion, and stale checkpoint behavior remain unchanged.
- Recovery guidance must reject repetitive status prose, waiting, requests to clear the goal, and unsupported `TERMINAL_NOT_PROVEN` declarations. It must direct the model to inspect remaining criteria and perform safe controllable work.
