# Continue through blockers — coach, not kill switch

## Problem

The no-progress breaker has only two moves: keep auto-continuing, or halt the whole goal. That produced two failures:

- Empty restatement loops (status/`get_goal`/identical git).
- False stops on real work (`computer_use_linux_*`, `reach_search`) and on *small* gates (COGS, Kalshi license) while other tasks remained.

The product goal is: **keep doing productive work**. “I don’t see a path” is not a stop. A physical-human blocker is last-case NOT PROVEN, not a circuit.

## Policy (approved)

The focused goal stays `running` with `autoContinue` on. The system never opens a kill switch because a turn had no tools.

| Signal | Action |
|---|---|
| Real host tools (including `reach_search`, desktop, MCP) | Count as work. Reset restatement counter. Continue. |
| Same restatement, no new evidence | Not a stop. Inject a coach prompt. Queue the next continuation. |
| One task proven blocked on a physical human (tried X/Y/Z, why each failed, why siblings don’t need it) | Mark that task NOT PROVEN / skip. Continue other tasks. |
| Every remaining task has that proof | Then and only then stop auto-continue. Goal still `running`. Wait for the user. |

Reload must not replay a halt and must not freeze a goal that still has unproven work.

`update_goal({status:"blocked"|"paused"})` stays forbidden. No purchases, account changes, or legal acceptance unless the user already authorized that exact action. “Work around payment” means find a non-purchase path or prove none exists.

NQA / `$full-throttle` uses the same rule. The halt they hit is **pi-goal-x**, not NQA.

## Mechanism

Replace `pi-goal:no-progress-circuit-open` as a continuation killer.

On `agent_end` for an actionable focused goal:

1. Child/`bg_run` awaiting → unchanged: they own continuation.
2. Progress-class tools this run → reset restatement counter; queue continuation.
3. No new evidence → increment restatement counter; inject escalating coach prompt; **still queue continuation**.
   - 1st: research concrete options, journal the comparison, pick one with evidence, attempt it.
   - 2nd: do not repeat the blocker; attempt a different method or prove why the last attempt failed.
   - 3rd+: dual-sided packet for *that task only*; skip/NOT PROVEN if the packet exists; continue siblings; do not stop the goal.
4. Remove the yellow “stopped automatic continuation” notify (or replace with a non-halting research nudge if UI is needed).
5. Stop emitting `pi-goal:no-progress-circuit-open` for this path so NQA does not suspend its own continuation on a false halt.
6. Reload / `session_start`: restore restatement count from trailing empty runs; inject the *next* coach prompt and continue. Do not freeze. Do not replay a halt.

`get_goal`, `create_goal`, `bg_status`, and `subagent status`/`list`/`models` remain non-progress. 0.30.17 denylist for other host tools stays.

## Tests

- Three text-only turns still queue continuation, with coach prompts 1 → 2 → dual-sided packet, and do **not** emit `pi-goal:no-progress-circuit-open` or the yellow halt.
- `reach_search` / `computer_use_linux_*` still reset the restatement counter.
- `get_goal` / `subagent status` still do not.
- Reload after three restatements continues with the next coach prompt, not silence and not a halt.
- Child/`bg_run` ownership unchanged.

## Out of scope

Auditor, widgets, allowing `update_goal blocked`, purchases/account changes, detecting “impossibility proof” with an LLM judge in v1 (prompt + task skip tools only).

## Rejected

- Immediate tool-free latch (0.30.15): killed running goals on `get_goal`.
- No breaker / infinite empty loop: historical OutputReady token burn.
- Halt after three quiet turns (0.30.18): treats restatement as goal death.
