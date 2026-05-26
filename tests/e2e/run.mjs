# pi-goal e2e test runner

This directory contains manual end-to-end tests that exercise the actual
`update_goal` tool handler through the real pi runtime. These tests use
forked-context subagents so they do not affect the parent session.

## Prerequisites

- The pi-goal extension must be loaded in the current session.
- A goal must be active (any active goal works — the handler is tested,
  not the specific goal content).
- The `e2e-test-runner` subagent must be available:
  `/run e2e-test-runner --help`

## Running the tests

### Test 1: Quick-sync objective

```bash
/run e2e-test-runner "Test scenario: quick-sync via update_goal({updatedObjective})"
```

**Expected behavior**: The subagent calls `get_goal`, then `update_goal({updatedObjective})`,
then `get_goal` again. The objective should change, status must remain active,
and the tool must NOT return `terminate: true`.

### Test 2: Combined sync + complete

```bash
/run e2e-test-runner "Test scenario: combined sync+complete"
```

**Expected behavior**: The subagent calls `update_goal({updatedObjective, status:'complete'})`.
The completion report must reference the updated (not the original) objective.
The goal file on disk must show both the updated objective and status=complete.

### Test 3: Deferred archival (complete without sync)

```bash
/run e2e-test-runner "Test scenario: deferred archival"
```

**Expected behavior**: After `update_goal({status:'complete'})`, the goal must
have status=complete but still be in the active directory (archivedPath not
set). This verifies that archival is deferred to turn_end.

### Running via chain

```bash
/run-chain e2e-test
```

This runs all three test scenarios as documented in `.pi/chains/e2e-test.chain.md`.

## Interpreting results

The subagent outputs a structured PASS/FAIL report for each step. A passing
test reports:

```
PASS: get_goal returned active goal
PASS: update_goal({updatedObjective}) succeeded without termination
PASS: get_goal shows updated objective
PASS: file on disk contains new objective
...
```

If any step reports FAIL, the test has caught a regression in the handler logic.
