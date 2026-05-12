# pi-goal Architecture

This document describes the shipped `pi-goal` extension as it exists now. It intentionally focuses on implemented behavior rather than design explorations.

## Runtime shape

`extensions/goal.ts` is the orchestration layer. It owns pi integration points:

- slash commands;
- tool registration;
- session events;
- active/archived goal file IO;
- auto-continue timers;
- usage accounting;
- above-editor widget rendering.

Reusable logic is split into smaller modules:

| Module | Responsibility |
|---|---|
| `goal-core.ts` | Step counting, token-budget parsing, compact display formatting, status labels, objective title cleanup |
| `goal-draft.ts` | Drafting prompts, draft summary construction, draft proposal validation, drafting-stage tool gate |
| `goal-policy.ts` | Lifecycle policy, pause/resume/complete validation, Sisyphus step validation, verify-command classification, budget/compaction policy, full result reports |
| `goal-questionnaire.ts` | Built-in questionnaire types, normalization, answer formatting, TUI question runner, proposal confirmation dialog, question-tool registration |
| `goal-tool-names.ts` | Published tool-name constants, active-tool lists, post-stop allowlist, Sisyphus work-tool list, question-like tool detection |

## Lifecycle

```text
/user command
  ├─ /goal-set or /goal-sis
  │    └─ draftingFor = {...}
  │         ├─ agent may ask via chat / goal_question / goal_questionnaire
  │         ├─ workhorse tools are blocked
  │         └─ propose_goal_draft validates and asks user to confirm
  │              ├─ Continue Chatting: stay in drafting
  │              └─ Confirm: create active goal, write .pi/goals file, print full objective
  │
  ├─ active goal
  │    ├─ autoContinue queues checkpoint turns
  │    ├─ pause_goal pauses on real blockers
  │    ├─ step_complete advances Sisyphus progress
  │    └─ update_goal complete archives and prints full completion report
  │
  └─ /goal-clear archives or cancels drafting
```

## Goal modes

### Regular goal

Regular goals are open-ended objectives. The agent decides the next concrete action each checkpoint turn, then completes only after the objective is actually satisfied.

### Sisyphus goal

Sisyphus goals are strict ordered plans. The extension parses numbered steps from the objective and tracks:

- `totalSteps`
- `stepsCompleted`
- `currentStep`

`step_complete` only accepts the next step. It rejects skipped, duplicate, out-of-order, empty-evidence, wrong-mode, paused, stale, or already-finished calls.

`update_goal(status="complete")` is rejected until all steps are complete.

## Drafting and confirmation

Drafting is a user-intent collection phase. The agent may clarify through normal chat or built-in question tools, but cannot inspect or edit the repo before the user confirms the goal.

`propose_goal_draft` enforces:

- a drafting flow must be active;
- no unfinished goal may already exist;
- objective must be non-empty;
- `sisyphus` must match the command the user invoked;
- Sisyphus drafts must preserve the user's numbered plan instead of inventing extra steps.

On confirmation, the result prints the full finalized objective in the conversation. The same objective is also written to the active goal file.

## Tool visibility

Tool visibility is recomputed whenever state changes.

- Drafting exposes `goal_question`, `goal_questionnaire`, `get_goal`, and `propose_goal_draft`.
- Tweak drafting exposes question tools, `get_goal`, and `apply_goal_tweak`.
- Active goals expose `get_goal`, `update_goal`, and `pause_goal`.
- Active Sisyphus goals additionally expose `step_complete`.
- `create_goal` remains hidden in normal user flows.

The `tool_call` interceptor blocks:

- workhorse/reconnaissance tools during drafting;
- non-`get_goal` tools after a stop tool has fired in the same turn.

## Disk format

Active and archived goal files live under `.pi/goals/`.

```text
.pi/goals/active_goal_<timestamp>_<id>.md
.pi/goals/archived/goal_<timestamp>_<id>.md
```

Each file has extension-owned metadata and a user-editable `# Goal Prompt` section. The extension reads back the prompt body so users can revise the objective in a text editor, while lifecycle state remains controlled by schema-gated tools.

Path safety checks reject absolute paths, traversal, NUL bytes, symlinks, and paths outside the goal directories.

## Auto-continue and stop conditions

When `autoContinue` is on, the extension queues continuation prompts after agent turns. The loop stops or pauses when:

- the agent calls `update_goal(status="complete")`;
- the agent calls `pause_goal`;
- the user invokes `/goal-pause` or `/goal-clear`;
- the user aborts the turn;
- the token budget is exhausted;
- `PI_GOAL_MAX_AUTOCONTINUE_TURNS` is reached;
- Sisyphus mode detects an empty turn without meaningful work.

Continuation prompts include a goal id so stale prompts can be detected and neutralized.

## Completion output

Completion is intentionally verbose in the tool result. The user sees:

- a `Goal complete.` header;
- the agent's optional completion summary/evidence;
- the full current goal details.

This mirrors creation: the finalized goal is visible when created, and the final report is visible when completed.

## Tests

Fast local tests live in `tests/` and run with:

```bash
npm test
npm run check
```

They cover:

- parsing and display helpers;
- token-budget extraction;
- drafting prompt and drafting gates;
- questionnaire normalization and answer formatting;
- tool-name constants and question-like detection;
- lifecycle policy;
- Sisyphus step validation;
- verify-command classification;
- budget and auto-continue cap behavior;
- full creation/completion report formatting.

The `experiments/` harness provides end-to-end coverage with real pi sessions and model calls.
