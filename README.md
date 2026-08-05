# pi-goal-x

`pi-goal-x` is a goal-management extension for [pi](https://github.com/earendil-works/pi-coding-agent).

It gives the agent a persistent objective, a structured plan, visible progress, and an independent completion review. Goals remain available across sessions, so the agent can continue working with the same objective and progress record.

## Features

### Regular goals

Regular goals describe an outcome for the agent to achieve. The agent can investigate the work, choose an appropriate sequence, create tasks, and adapt its plan as it progresses.

Regular goals work well for research, implementation, debugging, documentation, and other work where the desired result is clear and the execution path can be determined during the task.

### Sisyphus goals

Sisyphus goals describe work that should be completed in a specific order. The agent follows the listed sequence one step at a time and preserves dependencies between steps.

Sisyphus goals work well for migrations, staged refactors, release procedures, data-processing workflows, and other tasks where each step prepares the way for the next.

### Guided goal creation

The `/goal` and `/sisyphus` commands start a guided drafting process. The agent can ask focused questions, clarify the objective, and propose a task plan for confirmation.

### Direct goal creation

The `/goal-direct` and `/sisyphus-direct` commands create a goal immediately from a complete objective.

### Persistent progress

Open goals are stored in `.pi/goals/`. Their objectives, tasks, status, and progress remain available across sessions and context changes.

### Multiple open goals

A project can contain several open goals. Each session focuses on one goal at a time, and you can switch between them with `/goal-focus`.

### Tasks and subtasks

Goals can include structured tasks and subtasks. The agent updates their status and records completion evidence as work progresses.

### Verification contracts

Goals and tasks can include plain-text completion requirements, such as:

```text
Run npm test with zero failures.
```

The completion auditor checks these requirements against evidence from the workspace.

### Independent completion review

When the agent reports a goal as complete, a separate pi agent reviews the objective, tasks, verification requirements, and workspace.

Approved goals are archived as complete. Goals requiring additional work remain open with review feedback.

### Visible status

An above-editor widget shows the focused goal, its status, file path, and progress.

### Goal controls

Slash commands let you pause, resume, revise, select, unfocus, and archive goals.

### Configurable behaviour

The settings menu controls task support, verification contracts, subtask depth, goal selection, and the completion auditor.

## Install

Install from npm:

```bash
pi install npm:pi-goal-x
```

Install from a local checkout:

```bash
pi install .
```

Run it once from a local checkout:

```bash
pi -e .
```

## Choose a goal style

Use a **regular goal** when you have a clear outcome and want the agent to determine how to reach it.

For example:

```text
/goal Add account deletion to the application, including the user interface, data cleanup, documentation, and tests.
```

The agent can decide how to investigate the application, divide the work, and order the implementation.

Use a **Sisyphus goal** when you already know the required sequence and want the agent to follow it step by step.

For example:

```text
/sisyphus Migrate authentication in this order:
1. Add the new token validator.
2. Update login to use it.
3. Update session refresh to use it.
4. Remove the old validator.
5. Run the authentication test suite.
```

The agent completes the migration in the stated order, preserving the dependency between each stage.

## Create a guided goal

Start a guided regular goal:

```text
/goal add structured logging to the authentication module
```

The agent can ask questions and propose a complete objective and task plan. Confirm the proposal to create the goal and begin work.

Start a guided Sisyphus goal:

```text
/sisyphus prepare and perform the customer-data migration
```

The agent can help define the ordered steps and present them for confirmation.

## Create a goal directly

Use `/goal-direct` when the objective already describes a complete outcome:

```text
/goal-direct Add a health-check endpoint that verifies database connectivity, returns the service status as JSON, documents the endpoint, and includes passing tests.
```

This creates and focuses the regular goal immediately.

Use `/sisyphus-direct` when the objective already contains the complete ordered process:

```text
/sisyphus-direct Upgrade the payment integration in this order:
1. Add support for the new API version.
2. Update payment creation.
3. Update refund handling.
4. Migrate the test fixtures.
5. Run the payment test suite.
6. Remove the old API integration.
```

This creates and focuses the ordered goal immediately.

## Manage goals

List open goals:

```text
/goal-list
```

Show the focused goal:

```text
/goal-status
```

Select an open goal for the current session:

```text
/goal-focus
```

Remove the current session’s focus while keeping the goal open:

```text
/goal-unfocus
```

Revise the focused objective and task plan:

```text
/goal-tweak <change>
```

Pause or resume the focused goal:

```text
/goal-pause
/goal-resume
```

Archive the focused goal:

```text
/goal-clear
```

Cancel an unconfirmed guided draft:

```text
/goal-cancel
```

Open the settings menu:

```text
/goal-settings
```

Pressing `Esc` during active work pauses the goal.

## Tasks and verification

The agent can divide a goal into tasks and subtasks and update them as work progresses.

Verification contracts describe the evidence required for completion. They can apply to the entire goal or to an individual task.

Examples include:

```text
Run npm test with zero failures.
```

```text
Confirm the new command appears in the help menu.
```

```text
Verify that the generated report contains every required section.
```

## Completion review

When the agent reports a goal as complete, `pi-goal-x` starts an independent completion review.

The auditor examines:

* The objective
* The task plan and recorded evidence
* Verification contracts
* The current workspace

An approved goal is archived as complete. Review feedback is added to any goal that requires further work.

Press `Esc` to stop an active audit.

## Goal storage

Open goals are stored in:

```text
.pi/goals/
```

Completed and cleared goals are stored in:

```text
.pi/goals/archived/
```

Each session can focus on one goal while the project keeps other goals open.

## Commands

```text
/goal [seed]                 Start a guided regular goal
/sisyphus [seed]             Start a guided ordered goal
/goal-direct <objective>     Create a regular goal immediately
/sisyphus-direct <objective> Create an ordered goal immediately
/goal-list                   List open goals
/goal-status                 Show the focused goal
/goal-focus                  Select an open goal
/goal-unfocus                Remove the session’s focus
/goal-tweak <change>         Revise the focused goal
/goal-pause                  Pause the focused goal
/goal-resume                 Resume a paused or blocked goal
/goal-settings               Open the settings menu
/goal-clear                  Archive the focused goal
/goal-cancel                 Cancel the current draft
```

## Configuration

Settings are stored in:

```text
.pi/pi-goal-x-settings.json
```

Use `/goal-settings` to configure task lists, verification contracts, subtask depth, automatic goal selection, and completion auditing.

## License

MIT
