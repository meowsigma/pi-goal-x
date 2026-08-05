import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderGoalWidgetLines, renderAuditorWidgetLines, renderAuditResultCardView, GoalWidgetComponent, type GoalWidgetRecord, type AuditorWidgetProgress } from "../extensions/widgets/goal-widget.ts";
import { createMockTUI, createMockTheme } from "./tui-test-utils.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

function goal(overrides: Partial<GoalWidgetRecord> = {}): GoalWidgetRecord {
	return {
		id: "test-goal-001",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		objective: "=== Goal ===\nObjective: Componentize the goal widget\nSuccess criteria: tests pass",
		status: "active",
		autoContinue: true,
		usage: { activeSeconds: 65, tokensUsed: 2500 },
		sisyphus: true,
		activePath: ".pi/goals/active_goal.md",
		...overrides,
	};
}

function auditorProgress(overrides: Partial<AuditorWidgetProgress> = {}): AuditorWidgetProgress {
	return {
		currentTool: "read",
		currentToolArgs: '{"path":"test.txt"}',
		currentToolStartedAt: Date.now() - 5000,
		recentOutput: ["checking file exists...", "confirming test coverage..."],
		phase: "tool_executing",
		elapsedMs: 5000,
		...overrides,
	};
}

test("renderGoalWidgetLines renders the unified compact dashboard", () => {
	const lines = renderGoalWidgetLines(goal(), theme, 100);
	assert.match(lines[0], /^╭─ pi-goal-x ─ Componentize the goal widget/);
	assert.match(lines[0], /1m05s · 2\.5K tok/);
	assert.match(lines[1], /● In progress · Focused: yes/);
	assert.match(lines.at(-1) ?? "", /^╰─ .*Ctrl\+Shift\+T: expand/);
});

test("renderGoalWidgetLines shows the complete state", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "complete",
		autoContinue: false,
		sisyphus: false,
		archivedPath: ".pi/goals/archived/goal.md",
	}), theme, 100);
	assert.match(lines[0], /1m05s · 2\.5K/);
	assert.match(lines.join("\n"), /All required work is complete/);
});


test("renderGoalWidgetLines highlights blocked state with reason and action", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "blocked",
		autoContinue: false,
		pauseReason: "Missing API token",
		pauseSuggestedAction: "Set TOKEN and run /goal-resume",
	}), theme, 100);
	assert.match(lines.join("\n"), /⊘ Blocked/);
	assert.match(lines.join("\n"), /Blocker  Missing API token/);
	assert.match(lines.join("\n"), /Action   Set TOKEN and run \/goal-resume/);
});

test("renderGoalWidgetLines shows paused reason and who paused", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "paused",
		autoContinue: false,
		stopReason: "agent",
		pauseReason: "waiting on the user",
	}), theme, 100);
	assert.match(lines.join("\n"), /◐ Paused \(agent\)/);
	assert.match(lines.join("\n"), /Reason   waiting on the user/);
});

test("renderGoalWidgetLines shows other open goals and unfocused multi-goal guidance", () => {
	const focused = renderGoalWidgetLines(goal(), theme, 100, { openGoalCount: 3 });
	assert.match(focused[1], /Other goals: 2/);

	const unfocused = renderGoalWidgetLines(null, theme, 100, { openGoalCount: 2 });
	assert.match(unfocused[0], /^╭─ pi-goal-x ─ Goal focus required/);
	assert.match(unfocused.join("\n"), /2 open goals are available/);
	assert.match(unfocused.join("\n"), /\/goal-focus/);
});

test("renderAuditorWidgetLines shows the structured audit dashboard (§15.3)", () => {
	const progress = auditorProgress({ auditorLabel: "anthropic/claude" });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	assert.match(lines[0], /Independent completion audit ─ anthropic\/claude/);
	// Five check stages in order.
	const text = lines.join("\n");
	assert.ok(text.indexOf("Objective and success criteria") < text.indexOf("Verification contracts"));
	assert.ok(text.indexOf("Verification contracts") < text.indexOf("Tasks and recorded evidence"));
	assert.ok(text.indexOf("Tasks and recorded evidence") < text.indexOf("Workspace inspection"));
	assert.ok(text.indexOf("Workspace inspection") < text.indexOf("Final decision"));
	// Active audit footer.
	assert.match(lines.at(-1) ?? "", /Esc: stop audit/);
	// Tool + output details are hidden by default (shown only in expanded/debug).
	assert.doesNotMatch(text, /tool read/);
	assert.doesNotMatch(text, /checking file exists/);
});

test("renderAuditorWidgetLines shows tool and output details in expanded/debug mode", () => {
	const progress = auditorProgress();
	const lines = renderAuditorWidgetLines(progress, theme, 100, { showToolDetails: true });
	const text = lines.join("\n");
	assert.match(text, /tool read/);
	assert.match(text, /test\.txt/);
	assert.match(text, /checking file exists/);
});

test("renderAuditorWidgetLines drives check states from percentage bands (§15.2)", () => {
	const progress = auditorProgress({ phase: "running", percentage: 72, recentOutput: [] });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	const text = lines.join("\n");
	assert.match(text, /✓ Objective and success criteria/);
	assert.match(text, /✓ Verification contracts/);
	assert.match(text, /✓ Tasks and recorded evidence/);
	assert.match(text, /◌ Workspace inspection/);
	assert.match(text, /· Final decision/);
	assert.match(text, /72%/);
});

test("renderAuditorWidgetLines shows the progress bar at 0% and 100%", () => {
	const zero = renderAuditorWidgetLines(auditorProgress({ phase: "running", percentage: 0, recentOutput: [] }), theme, 100).join("\n");
	assert.match(zero, /0%/);
	const hundred = renderAuditorWidgetLines(auditorProgress({ phase: "running", percentage: 100, recentOutput: [] }), theme, 100).join("\n");
	assert.match(hundred, /100%/);
});

test("renderAuditorWidgetLines shows no percentage when undefined", () => {
	const progress = auditorProgress({ phase: "running", label: "Working..." });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	assert.match(lines.join("\n"), /Working/);
	assert.doesNotMatch(lines.join("\n"), /\d+%/);
});

test("renderAuditorWidgetLines shows the done phase without the stop hint", () => {
	const progress = auditorProgress({ phase: "done", currentTool: undefined, currentToolArgs: undefined, recentOutput: [] });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	assert.doesNotMatch(lines.join("\n"), /Esc: stop audit/);
});

test("audit progress overrides normal goal display when provided", () => {
	const progress = auditorProgress();
	const lines = renderGoalWidgetLines(goal(), theme, 100, { auditorProgress: progress });
	assert.match(lines[0], /Independent completion audit/);
	assert.doesNotMatch(lines[0], /pi-goal-x ─/);
});

test("finished audit shows the result card view (§15.4)", () => {
	const approved = renderAuditResultCardView({ verdict: "approved", report: "ok" }, theme, 100);
	assert.match(approved[0], /Audit result ─ APPROVED/);
	const approvedText = approved.join("\n");
	assert.match(approvedText, /✓ Objective satisfied\./);
	assert.match(approvedText, /✓ Verification requirements satisfied\./);
	assert.match(approvedText, /✓ Required tasks and evidence accepted\./);

	const rejected = renderAuditResultCardView({ verdict: "disapproved", report: "- Tests were not run after the final change.\n- Task \"docs\" has no evidence." }, theme, 100);
	const rejectedText = rejected.join("\n");
	assert.match(rejectedText, /Audit result ─ CHANGES REQUIRED/);
	assert.match(rejectedText, /✗ Tests were not run after the final change\./);
	assert.match(rejectedText, /✗ Task \"docs\" has no evidence\./);
});

const testProposedAt = "2026-01-01T00:00:00.000Z";

test("renderGoalWidgetLines shows top-level task progress (§9.1, skipped counts as done)", () => {
	const lines = renderGoalWidgetLines(goal({
		taskList: {
			tasks: [
				{ id: "t1", title: "Task 1", status: "complete" },
				{ id: "t2", title: "Task 2", status: "pending" },
				{ id: "t3", title: "Task 3", status: "skipped" },
			],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100);
	assert.match(lines.join("\n"), /Tasks  \[.*\] 2\/3 · 67%/);
});

test("renderGoalWidgetLines shows the current task (first pending, inferred)", () => {
	const lines = renderGoalWidgetLines(goal({
		taskList: {
			tasks: [
				{ id: "t1", title: "Task 1", status: "complete" },
				{ id: "t2", title: "Task 2", status: "pending" },
				{ id: "t3", title: "Task 3", status: "pending" },
			],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100);
	const body = lines.join("\n");
	assert.match(body, /Tasks  \[.*\] 1\/3 · 33%/);
	assert.match(body, /Current  t2 · Task 2/);
});

test("renderGoalWidgetLines shows 'All tasks complete' when all done (§9.4)", () => {
	const lines = renderGoalWidgetLines(goal({
		taskList: {
			tasks: [
				{ id: "t1", title: "Task 1", status: "complete" },
				{ id: "t2", title: "Task 2", status: "skipped" },
			],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100);
	assert.match(lines.join("\n"), /Tasks  \[.*\] 2\/2 · 100%/);
	assert.match(lines.join("\n"), /Current  All tasks complete/);
});

test("renderGoalWidgetLines omits task rows when no taskList", () => {
	const lines = renderGoalWidgetLines(goal(), theme, 100);
	const body = lines.join("\n");
	assert.equal(body.includes("Tasks"), false);
	assert.equal(body.includes("Current"), false);
});

// ── Subtask widget display ──────────────────────────────────────────────

test("renderGoalWidgetLines shows subtask progress for the current parent task (§9.3)", () => {
	const lines = renderGoalWidgetLines(goal({
		currentTaskId: "t1",
		taskList: {
			tasks: [{
				id: "t1", title: "Parent", status: "pending",
				subtasks: [
					{ id: "t1a", title: "Child", status: "complete" },
					{ id: "t1b", title: "Child2", status: "complete" },
				],
			}],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100);
	assert.match(lines.join("\n"), /Subtasks \[.*\] 2\/2 · 100%/);
});

test("renderGoalWidgetLines infers a pending subtask as current at any depth", () => {
	const lines = renderGoalWidgetLines(goal({
		taskList: {
			tasks: [{
				id: "t1", title: "Parent", status: "complete",
				subtasks: [
					{ id: "t1a", title: "Child", status: "pending" },
				],
			}],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100);
	const body = lines.join("\n");
	assert.match(body, /Current  t1a · Child/);
});

test("renderGoalWidgetLines shows all complete when subtasks are done", () => {
	const lines = renderGoalWidgetLines(goal({
		taskList: {
			tasks: [{
				id: "t1", title: "Parent", status: "complete",
				subtasks: [
					{ id: "t1a", title: "Child", status: "complete" },
				],
			}],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100);
	const body = lines.join("\n");
	assert.match(body, /Current  All tasks complete/);
});

test("renderGoalWidgetLines suppresses task info when disableTasks is true with subtasks (§9.5)", () => {
	const lines = renderGoalWidgetLines(goal({
		taskList: {
			tasks: [{
				id: "t1", title: "Parent", status: "pending",
				subtasks: [{ id: "t1a", title: "Child", status: "pending" }],
			}],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100, { disableTasks: true });
	const body = lines.join("\n");
	assert.equal(body.includes("Tasks"), false);
	assert.equal(body.includes("t1a"), false);
	assert.equal(body.includes("Current"), false);
});

// ── TUI rendering path: GoalWidgetComponent ───────────────────────────

test("GoalWidgetComponent renders through mock TUI path", () => {
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
	});

	const lines = component.render(100);
	assert.ok(lines.length > 0, "Component renders lines");
	assert.match(lines[0], /^╭─ pi-goal-x ─ Componentize the goal widget/);
	assert.match(lines[1], /● In progress · Focused: yes/);
});

test("GoalWidgetComponent shows open goal count when > 1", () => {
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 3,
		getSettings: () => ({}),
	});

	const lines = component.render(100);
	const text = lines.join("\n");
	assert.match(text, /Other goals: 2/);
});

test("GoalWidgetComponent update triggers requestRender", () => {
	const { tui, state } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
	});

	const before = state.requestRenderCalls;
	component.update();
	assert.ok(state.requestRenderCalls > before, "update() triggers requestRender");
});

test("GoalWidgetComponent invalidate triggers requestRender", () => {
	const { tui, state } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
	});

	const before = state.requestRenderCalls;
	component.invalidate();
	assert.ok(state.requestRenderCalls > before, "invalidate() triggers requestRender");
});

test("GoalWidgetComponent renders the audit dashboard when audit progress is present", () => {
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getAuditorProgress: () => ({
			currentTool: "read",
			currentToolArgs: '{"path":"test.txt"}',
			currentToolStartedAt: Date.now() - 5000,
			recentOutput: ["checking..."],
			phase: "tool_executing",
			elapsedMs: 5000,
		}),
		getSettings: () => ({}),
	});

	const lines = component.render(100);
	const text = lines.join("\n");
	assert.match(text, /Independent completion audit/);
	assert.match(text, /Objective and success criteria/);
	// Tool details are hidden unless the dashboard is expanded (debug/audit mode).
	assert.doesNotMatch(text, /tool read/);
});

test("GoalWidgetComponent renders with disableTasks setting", () => {
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
getGoal: () => goal({
			taskList: {
				tasks: [{ id: "t1", title: "Task 1", status: "pending" }],
				blockCompletion: false,
				proposedAt: "2026-01-01T00:00:00.000Z",
			},
		}),
		getOpenGoalCount: () => 1,
		getSettings: () => ({ disableTasks: true }),
	});

	const lines = component.render(100);
	const text = lines.join("\n");
	assert.equal(text.includes("Tasks"), false, "Tasks hidden when disableTasks is true");
	assert.equal(text.includes("Current"), false, "Current hidden when disableTasks is true");
});

test("GoalWidgetComponent shows completed goal status", () => {
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal({ status: "complete", archivedPath: ".pi/goals/archived/g.md", sisyphus: false }),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
	});

	const lines = component.render(100);
	assert.match(lines.join("\n"), /All required work is complete/);
});

for (const width of [50, 70, 100, 109, 120]) {
	test(`GoalWidgetComponent safety net at width ${width} with long content`, () => {
		const { tui } = createMockTUI();
		const component = new GoalWidgetComponent({
			tui,
			theme: createMockTheme(),
			getGoal: () => goal({
				objective: "x".repeat(500),
				activePath: "/very/long/path/that/should/definitely/be/truncated/because/it/exceeds/the/available/width/by/a/lot/and/would/cause/a/crash/if/not/truncated".repeat(3),
			}),
			getOpenGoalCount: () => 8,
			getSettings: () => ({}),
		});

		const lines = component.render(width);
		for (let i = 0; i < lines.length; i++) {
			assert.ok(
				visibleWidth(lines[i]) <= width,
				`Line ${i} has visible width ${visibleWidth(lines[i])} > ${width}: ${JSON.stringify(lines[i].slice(0, 80))}`,
			);
		}
	});
}

test("GoalWidgetComponent with auditor progress at width 109 (crash regression)", () => {
	const { tui } = createMockTUI();
	const width = 109; // Matches the crash terminal width
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal({
			objective: "Achieve full end-to-end test suite pass on Linux x86_64 with 100% vendor parity — all e2e pass (no skips). The constraints should be exactly those as per the design document and the previous goals. We need to dissassemble the vendor's implementation live, stepping through, to ensure we implement this in full.".repeat(2),
			activePath: "/Users/tom/projects/some-very-long-project-path-that-exceeds-terminal-width/when-combined-with-prefix-characters/and-wrapping-scenarios/src/extremely/nested/deeply/nested/module/that/makes/this/really/long/really/long/really/long.ts".repeat(2),
		}),
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
		getAuditorProgress: () => ({
			phase: "thinking" as const,
			label: "Very long auditor label that should not cause an overflow even when rendered at narrow terminal width with all the prefixes and padding",
			percentage: 45,
			recentOutput: [],
			elapsedMs: 5000,
		}),
	});

	const lines = component.render(width);
	for (let i = 0; i < lines.length; i++) {
		assert.ok(
			lines[i] === "" || visibleWidth(lines[i]) <= width,
			`Line ${i} has visible width ${visibleWidth(lines[i])} > ${width}: ${JSON.stringify(lines[i].slice(0, 80))}`,
		);
	}
});

test("GoalWidgetComponent unfocused with 38 open goals at width 109", () => {
	const { tui } = createMockTUI();
	const width = 109;
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => null,
		getOpenGoalCount: () => 38,
		getSettings: () => ({}),
	});

	const lines = component.render(width);
	for (let i = 0; i < lines.length; i++) {
		assert.ok(
			lines[i] === "" || visibleWidth(lines[i]) <= width,
			`Line ${i} has visible width ${visibleWidth(lines[i])} > ${width}: ${JSON.stringify(lines[i].slice(0, 80))}`,
		);
	}
});

// ── §19.5 dashboard interaction tests ────────────────────────────────────────

import { syncTerminalInputPause } from "../extensions/goal-widget.ts";

const CTRL_SHIFT_T = "\u001b[27;6;84~";

function keybindingHarness(initialExpanded = false) {
	let expanded = initialExpanded;
	const consumed: string[] = [];
	let inputCb: ((data: string) => unknown) | undefined;
	const ctx = {
		hasUI: true,
		ui: {
			onTerminalInput: (cb: unknown) => { inputCb = cb as (data: string) => unknown; return () => {}; },
			notify: () => {},
		},
	} as never;
	const core = {
		goalModalDepth: 0,
		auditProgress: null,
		state: { goal: null },
		pauseActiveGoal: () => { consumed.push("pause"); },
		abortAudit: () => { consumed.push("abort-audit"); },
		isDashboardExpanded: () => expanded,
		toggleDashboardExpanded: () => { expanded = !expanded; consumed.push("toggle"); },
		terminalInputUnsubscribe: null,
	} as never;
	syncTerminalInputPause(core as never, ctx as never);
	return {
		core,
		fire: (data: string) => inputCb?.(data),
		expanded: () => expanded,
		consumed,
	};
}

test("compact mode is the default and the task shortcut expands and collapses", () => {
	const h = keybindingHarness();
	const compact = renderGoalWidgetLines(goal({ taskList: { tasks: [{ id: "t1", title: "T1", status: "pending" }], blockCompletion: false, proposedAt: testProposedAt } }), theme, 100);
	assert.match(compact.join("\n"), /Ctrl\+Shift\+T: expand tasks/);

	h.fire(CTRL_SHIFT_T);
	assert.equal(h.expanded(), true, "ctrl+shift+t expands the dashboard");
	h.fire(CTRL_SHIFT_T);
	assert.equal(h.expanded(), false, "the same shortcut collapses it");
	assert.deepEqual(h.consumed, ["toggle", "toggle"]);
});

test("escape collapses the expanded dashboard instead of pausing", () => {
	const h = keybindingHarness(true);
	h.fire("\u001b");
	assert.equal(h.expanded(), false, "escape collapses the expanded dashboard");
	assert.deepEqual(h.consumed, ["toggle"]);
	assert.equal(h.consumed.includes("pause"), false, "escape while expanded must not pause the goal");
});

test("escape still pauses a running goal when the dashboard is compact", () => {
	const h = keybindingHarness(false);
	(h.core as unknown as { state: { goal: unknown } }).state.goal = { status: "active", autoContinue: true };
	h.fire("\u001b");
	assert.deepEqual(h.consumed, ["pause"]);
});

test("expanded mode renders the full dashboard without mutating editor state", () => {
	const { tui } = createMockTUI();
	const g = goal({ taskList: { tasks: [{ id: "t1", title: "T1", status: "pending" }], blockCompletion: false, proposedAt: testProposedAt } });
	const expanded = { current: false };
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => g,
		getOpenGoalCount: () => 1,
		getExpanded: () => expanded.current,
		getSettings: () => ({}),
	});
	const compactLines = component.render(100);
	expanded.current = true;
	const expandedLines = component.render(100);
	const text = expandedLines.join("\n");
	assert.match(text, /├─ Tasks /);
	assert.match(text, /Esc\/Ctrl\+Shift\+T: collapse/);
	// Rendering is pure: re-rendering returns identical lines.
	assert.deepEqual(component.render(100), expandedLines);
	expanded.current = false;
	assert.deepEqual(component.render(100), compactLines, "collapsing returns the compact view");
});

test("goal state updates are visible in both modes", () => {
	const { tui } = createMockTUI();
	let current = goal({ objective: "=== Goal ===\nObjective: First objective" });
	const expanded = { current: false };
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => current,
		getOpenGoalCount: () => 1,
		getExpanded: () => expanded.current,
		getSettings: () => ({}),
	});
	assert.match(component.render(100).join("\n"), /First objective/);
	current = goal({ objective: "=== Goal ===\nObjective: Second objective" });
	assert.match(component.render(100).join("\n"), /Second objective/);
	expanded.current = true;
	assert.match(component.render(100).join("\n"), /Second objective/, "expanded mode sees updated state");
});

test("audit mode temporarily replaces the normal view and returns after", () => {
	const { tui } = createMockTUI();
	let audit: AuditorWidgetProgress | null = auditorProgress();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal(),
		getOpenGoalCount: () => 1,
		getAuditorProgress: () => audit,
		getSettings: () => ({}),
	});
	const during = component.render(100).join("\n");
	assert.match(during, /Independent completion audit/);
	assert.doesNotMatch(during, /pi-goal-x ─/);
	audit = null;
	const after = component.render(100).join("\n");
	assert.match(after, /pi-goal-x ─/);
	assert.doesNotMatch(after, /audit complete|auditing/);
});

test("ledger events flow into the dashboard recent-activity feed", () => {
	const { tui } = createMockTUI();
	const events = [
		{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: "2026-01-01T09:00:00.000Z" },
		{ type: "task_started", goalId: "g1", taskId: "t1", at: "2026-01-01T09:01:00.000Z" },
	] as never;
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => goal({ id: "g1", taskList: { tasks: [{ id: "t1", title: "T1", status: "pending" }], blockCompletion: false, proposedAt: testProposedAt } }),
		getOpenGoalCount: () => 1,
		getExpanded: () => true,
		getLedgerEvents: () => events as never,
		getSettings: () => ({}),
	});
	const text = component.render(100).join("\n");
	assert.match(text, /Started “T1”\./, "ledger task_started maps to readable activity with the task title");
});
