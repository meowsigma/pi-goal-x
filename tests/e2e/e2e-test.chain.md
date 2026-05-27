---
name: e2e-test
description: "Run end-to-end tests for the pi-goal extension: deferred archival."
---

# e2e-test

These tests verify the actual `complete_goal` tool handler execution through the pi runtime using forked context (preserving the current session's goal state).

**Automated alternative**: The tests in `tests/e2e/run.ts` use `pi --mode json --fork` with `--append-system-prompt` + `--tools` to achieve deterministic behavior (the AI model is forced to make the required tool calls). No free-text AI output is parsed — only structured JSONL events (`tool_execution_start`/`tool_execution_end`).

**Manual chain**: Use this chain file for exploratory/interactive testing via `/run-chain e2e-test`.

**Source**: `tests/e2e/e2e-test.chain.md` (copy to `.pi/chains/` for use).

**Install**: `mkdir -p .pi/chains && cp tests/e2e/e2e-test.chain.md .pi/chains/e2e-test.chain.md`

## Test 1: Deferred archival (complete without sync)

Run: `/run e2e-test-runner "Test scenario: deferred archival"`

Steps the subagent performs:
1. Get current goal state
2. Call `complete_goal({status: 'complete', completionSummary: 'e2e test archival'})`
3. Verify goal is complete but NOT archived (still in active dir)
4. Note the deferred archival state
5. Report PASS/FAIL

Expected result: Status=complete but activePath still set, archivedPath not set.

---

## Results

The subagent reports structured PASS/FAIL for each test step. To inspect the goal state after the test, run `get_goal` or check `.pi/goals/`.

**Important**: The subagent runs in forked context — changes to the goal do NOT affect the parent session's goal state.
