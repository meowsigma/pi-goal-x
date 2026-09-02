# Tool-free yield vs observational no-progress

## Problem

After real work, a focused goal can correctly stop because the next action is user-only (license, credential, COGS, billing). `update_goal blocked/paused` is forbidden. Auto-continue still injects checkpoints. Those turns are `get_goal` plus restatement, which is not progress. After three such turns the circuit warns “no meaningful tool work,” which looks like a random stall.

This is not the live-child or `bg_run` false-positive class. Those leases remain in force.

## Decision

Split empty continuation into two classes:

1. **Tool-free yield.** The agent run used no progress-class tools (`GOAL_PROGRESS_TOOL_NAMES`). Treat it as a yield. Do not queue recovery checkpoints. Open the circuit immediately with a waiting message. Emit `pi-goal:no-progress-circuit-open` so other continuation owners stop.
2. **Observational no-progress.** The run called observational tools (`bash`, `read`, `grep`, `find`, `ls`, `bg_logs`) but produced no new evidence. Keep the existing two recoveries, then circuit with the current no-progress warning.

## Approaches considered

- **Immediate circuit on every no-progress run.** Rejected: a first unchanged `git status` would stop a goal that can still work on the next turn.
- **Softer warning copy only.** Rejected: it still forces two restatement checkpoints after a real yield.
- **Chosen: tool-free yield vs observational recovery.** Smallest change that stops the Kalshi/Day 8 restatement loop without weakening the git-status breaker.

## Assumptions

- A progress-class tool is exactly `GOAL_PROGRESS_TOOL_NAMES`. `get_goal` is not progress and is a yield if it is the only tool.
- User input still resets the chain.
- Active delegated/background ownership still suppresses the breaker.
- Models cannot pause/block the goal; this yield is the allowed stop.

## Verification

- Tool-free `end_turn` after a user/checkpoint prompt opens the circuit on that run and queues no continuation.
- Three unchanged observational shell runs still recover twice then circuit.
- Productive mutations still reset the breaker.
- Awaiting child/background ownership is unchanged.
