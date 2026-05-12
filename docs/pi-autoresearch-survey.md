# Implemented Borrowed Patterns

This document records the external patterns that are actually implemented in `pi-goal` today.

## From pi-codex-goal

`pi-goal` uses several goal-loop stability patterns inspired by `pi-codex-goal`:

- **Goal-id continuation markers**: continuation prompts include a goal id so stale prompts can be detected.
- **Context interceptor**: stale continuation context is neutralized instead of letting an old goal keep driving the agent.
- **Abort pause**: user abort / Ctrl-C pauses the active goal rather than leaving it in a misleading active state.
- **Disk-backed active goal file**: the current objective is materialized on disk and can be audited outside the chat.

## From pi-autoresearch

`pi-goal` uses several autonomous-loop safety patterns inspired by `pi-autoresearch`:

- **Auto-continue cap**: `PI_GOAL_MAX_AUTOCONTINUE_TURNS` prevents runaway continuation chains.
- **Empty-turn gate**: Sisyphus auto-continue does not advance when the agent did no meaningful work.
- **Structured metrics**: `step_complete` emits machine-readable `METRIC name=value` lines for harness grading.
- **Verification command gate**: optional `verifyCommand` must exit 0 before a Sisyphus step is marked complete.
- **Post-compaction resync**: Sisyphus goals receive a one-shot reminder after compaction so the agent resumes with correct step state.

## pi-goal-specific work

The current extension also adds behavior specific to goal drafting and lifecycle safety:

- **Draft-before-run**: `/goal-set` and `/goal-sis` start a drafting interview instead of immediate execution.
- **Confirm-before-commit**: `propose_goal_draft` is the normal creation path; `create_goal` stays hidden.
- **Full creation output**: after confirmation, the finalized objective is printed directly into the conversation.
- **Full completion output**: completion prints a report directly into the conversation, including optional evidence and full goal details.
- **Built-in question tools**: `goal_question` and `goal_questionnaire` provide package-local user-dialogue tools with `goal_` prefixes.
- **Centralized tool names**: published tool names and allowlists live in `goal-tool-names.ts`.
- **Questionnaire componentization**: normalization, answer formatting, proposal confirmation, and question-tool registration live in `goal-questionnaire.ts`.

## Current validation

The local unit suite covers the extracted helper modules. The end-to-end experiment harness covers runtime behavior with real pi sessions and model calls.

Run locally:

```bash
npm test
npm run check
npm pack --dry-run
```
