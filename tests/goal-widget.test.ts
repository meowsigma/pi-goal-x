import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderGoalWidgetLines, renderAuditorWidgetLines, renderAuditResultCardView, GoalWidgetComponent, type GoalWidgetRecord, type AuditorWidgetProgress } from "../extensions/widgets/goal-widget.ts";
import type { GoalTask } from "../extensions/goal-record.ts";
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
	assert.doesNotMatch(lines[0], /1m05s/, "usage moved from the header into the status line");
	assert.match(lines[1], /goal: sisyphus running \[1m05s 2\.5K\]/);
	assert.match(lines.at(-1) ?? "", /^╰─ .*Ctrl\+Shift\+T: expand/);
});

test("renderGoalWidgetLines shows the complete state", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "complete",
		autoContinue: false,
		sisyphus: false,
		archivedPath: ".pi/goals/archived/goal.md",
	}), theme, 100);
	assert.match(lines.join("\n"), /All required work is complete/);
});


test("renderGoalWidgetLines highlights blocked state with reason and action", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "blocked",
		autoContinue: false,
		pauseReason: "Missing API token",
		pauseSuggestedAction: "Set TOKEN and run /goal-resume",
	}), theme, 100);
	assert.match(lines.join("\n"), /goal: sisyphus blocked/);
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
	assert.match(lines.join("\n"), /goal: sisyphus paused \(agent\)/);
	assert.match(lines.join("\n"), /Reason   waiting on the user/);
});

test("renderGoalWidgetLines shows other open goals and unfocused multi-goal guidance", () => {
	const focused = renderGoalWidgetLines(goal(), theme, 100, { openGoalCount: 3 });
	assert.match(focused[1], /goal: sisyphus running \[1m05s 2\.5K\] \(\+2 open\)/);

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
	assert.match(lines.join("\n"), /Tasks · ✓2 done · 1 open/);
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
	assert.match(body, /Tasks · ✓1 done · 2 open/);
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
	assert.match(lines.join("\n"), /Tasks · ✓2 done · 0 open/);
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
	assert.match(lines.join("\n"), /· Sub 2\/2 \[.*\]/, "subtask bar sits beside the task bar in the header");
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
	assert.match(lines[1], /goal: sisyphus running \[1m05s 2\.5K\]/);
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
	assert.match(text, /goal: sisyphus running \[1m05s 2\.5K\] \(\+2 open\)/);
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
const CTRL_SHIFT_A = "\u001b[27;6;65~";

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
		toggleGoalAuditor: () => { consumed.push("toggle-auditor"); },
		goalWidgetComponentRef: { current: { invalidate: () => { consumed.push("invalidate"); } } },
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

test("ctrl+shift+a toggles the focused goal's auditor and refreshes the widget", () => {
	const h = keybindingHarness();
	(h.core as unknown as { state: { goal: unknown } }).state.goal = { status: "active", autoContinue: true };
	h.fire(CTRL_SHIFT_A);
	assert.deepEqual(h.consumed, ["toggle-auditor", "invalidate"], "auditor toggle + widget refresh");
	assert.equal(h.expanded(), false, "auditor toggle must not expand the dashboard");
});

test("ctrl+shift+a is inert while a goal modal is open", () => {
	const h = keybindingHarness();
	(h.core as unknown as { goalModalDepth: number }).goalModalDepth = 1;
	(h.core as unknown as { state: { goal: unknown } }).state.goal = { status: "active", autoContinue: true };
	h.fire(CTRL_SHIFT_A);
	assert.deepEqual(h.consumed, [], "modal depth guard swallows the chord");
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

// ── §9.6 task-list scrolling ─────────────────────────────────────────────────

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";
// Ctrl+Shift chords (free in pi — the editor owns the plain arrows).
const CS_UP = "\x1b[1;6A";
const CS_DOWN = "\x1b[1;6B";
const CS_HOME = "\x1b[1;6H";
const CS_END = "\x1b[1;6F";
const CS_PGUP = "\x1b[5;6~";
const CS_PGDN = "\x1b[6;6~";

/** 30 top-level tasks with t5 and t20 completed (t20 latest, mid-list): both
 * the compact (5 rows @100) and expanded (20 rows @100) views overflow, the
 * anchored window is a middle slice that can scroll in BOTH directions, and
 * the earliest task row is hidden by default. */
function manyTasksGoal(): GoalWidgetRecord {
	const tasks: GoalTask[] = Array.from({ length: 30 }, (_, i) => ({
		id: `t${i + 1}`,
		title: `Task number ${i + 1}`,
		status: "pending" as const,
	}));
	tasks[4] = { ...tasks[4]!, status: "complete", completedAt: "2026-01-01T10:00:00.000Z" };
	tasks[19] = { ...tasks[19]!, status: "complete", completedAt: "2026-01-01T11:00:00.000Z" };
	return goal({ taskList: { tasks, blockCompletion: false, proposedAt: testProposedAt } });
}

function scrollHarness(initialExpanded = false, g: GoalWidgetRecord = manyTasksGoal()) {
	let expanded = initialExpanded;
	const consumed: string[] = [];
	let inputCb: ((data: string) => unknown) | undefined;
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => g,
		getOpenGoalCount: () => 1,
		getExpanded: () => expanded,
		getSettings: () => ({}),
	});
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
		goalWidgetComponentRef: { current: component },
		terminalInputUnsubscribe: null,
	} as never;
	syncTerminalInputPause(core as never, ctx as never);
	return {
		fire: (data: string) => {
			const result = inputCb?.(data);
			if (result && typeof result === "object" && (result as { consume?: boolean }).consume) {
				consumed.push(`c:${data}`);
			}
			return result;
		},
		expanded: () => expanded,
		consumed,
		component,
	};
}

test("compact default viewport is anchored to the most recently completed tasks", () => {
	const lines = renderGoalWidgetLines(manyTasksGoal(), theme, 100);
	const text = lines.join("\n");
	assert.match(text, /↑ 15 more tasks/, "earliest tasks are hidden above the anchored window");
	assert.match(text, /Task number 20/, "the latest completion is the last visible row");
	assert.match(text, /Task number 16/, "the window is a middle slice around the anchor");
	assert.doesNotMatch(text, /[✓▸·~] t1\s/, "the earliest task row is not shown");
	assert.match(text, /… \+10 more tasks/, "pending tasks after the anchor stay reachable below");
});

test("plain arrows are never consumed in compact mode; the editor keeps them", () => {
	const h = scrollHarness(false);
	h.component.render(100);
	h.fire(UP);
	h.fire(DOWN);
	h.fire(PGUP);
	h.fire(PGDN);
	assert.deepEqual(h.consumed, [], "plain arrow/page keys belong to the editor in compact mode");
});

test("Ctrl+Shift+↑/↓ scroll the compact list one row; Esc is untouched", () => {
	const h = scrollHarness(false);
	h.component.render(100);
	assert.match(h.component.render(100).join("\n"), /↑ 15 more tasks/, "anchored window hides the earliest tasks");
	h.fire(CS_UP);
	assert.ok(h.consumed.includes("c:" + CS_UP), "Ctrl+Shift+↑ is consumed");
	assert.match(h.component.render(100).join("\n"), /↑ 14 more tasks/, "up scrolls the compact window");
	h.fire(CS_DOWN);
	assert.match(h.component.render(100).join("\n"), /↑ 15 more tasks/, "down scrolls the compact window back");
	// plain arrows and Esc still reach the editor afterwards — nothing to disengage
	h.fire(UP);
	h.fire("\u001b");
	assert.equal(h.consumed.filter((c) => c === "c:" + UP).length, 0, "plain ↑ is never consumed");
	assert.equal(h.consumed.includes("c:\u001b"), false, "Esc is not consumed when not expanded");
});

test("Ctrl+Shift+Home/End/PgUp/PgDn jump and page in the compact list", () => {
	const h = scrollHarness(false);
	h.component.render(100);
	h.fire(CS_HOME);
	assert.doesNotMatch(h.component.render(100).join("\n"), /↑ \d+ more tasks/, "home jumps to the top");
	assert.match(h.component.render(100).join("\n"), /[✓▸·~] t1\s/, "the earliest task row is visible");
	h.fire(CS_END);
	assert.match(h.component.render(100).join("\n"), /↑ 25 more tasks/, "end jumps to the tail (max offset 25)");
	assert.doesNotMatch(h.component.render(100).join("\n"), /… \+\d+ more tasks/);
	h.fire(CS_PGDN); // at max: clamped, still consumed
	assert.match(h.component.render(100).join("\n"), /↑ 25 more tasks/);
	h.fire(CS_PGUP); // page up 5 rows → offset 20
	assert.match(h.component.render(100).join("\n"), /↑ 20 more tasks/);
});

test("compact overflow shows the scroll hint in the footer; a short list does not", () => {
	const overflowing = scrollHarness(false);
	assert.match(overflowing.component.render(100).join("\n"), /Ctrl\+Shift\+T: expand · Ctrl\+Shift\+↑↓: scroll/);
	const narrow = scrollHarness(false);
	assert.match(narrow.component.render(40).join("\n"), /↑↓: scroll/, "minimal layout shortens the hint");
	const g = goal({ taskList: { tasks: [
		{ id: "t1", title: "One", status: "pending" },
		{ id: "t2", title: "Two", status: "pending" },
		{ id: "t3", title: "Three", status: "pending" },
	], blockCompletion: false, proposedAt: testProposedAt } });
	const short = scrollHarness(false, g);
	assert.match(short.component.render(100).join("\n"), /Ctrl\+Shift\+T: expand tasks/, "no overflow → no scroll hint");
});

test("Ctrl+Shift chords are not consumed when the compact list fits", () => {
	const g = goal({ taskList: { tasks: [
		{ id: "t1", title: "One", status: "pending" },
		{ id: "t2", title: "Two", status: "pending" },
		{ id: "t3", title: "Three", status: "pending" },
	], blockCompletion: false, proposedAt: testProposedAt } });
	const h = scrollHarness(false, g);
	h.component.render(100);
	h.fire(CS_UP);
	h.fire(CS_DOWN);
	assert.deepEqual(h.consumed, [], "nothing to scroll → chords pass through");
});

test("expanded mode scrolls the task tree with arrows, Home, End, and page keys", () => {
	const h = scrollHarness(true);
	h.component.render(100); // expanded rows 20 over 30 nodes; anchor t20 → offset 0
	assert.doesNotMatch(h.component.render(100).join("\n"), /↑ \d+ more tasks/, "anchored window starts at the top");
	assert.match(h.component.render(100).join("\n"), /Task number 20/, "the latest completion is the last visible row");
	h.fire(DOWN);
	assert.match(h.component.render(100).join("\n"), /↑ 1 more task/, "down moves the expanded window");
	h.fire(HOME);
	assert.doesNotMatch(h.component.render(100).join("\n"), /↑ \d+ more tasks/, "home jumps to the top");
	h.fire(UP); // at top: clamped, still consumed
	h.fire(END);
	assert.match(h.component.render(100).join("\n"), /↑ 10 more tasks/, "end jumps to the tail (max offset 10)");
	h.fire(PGDN); // at max: clamped, still consumed
	assert.match(h.component.render(100).join("\n"), /↑ 10 more tasks/);
	h.fire(PGUP); // page up 20 rows → top
	assert.doesNotMatch(h.component.render(100).join("\n"), /↑ \d+ more tasks/);
	assert.ok(h.consumed.filter((c) => c.startsWith("c:")).length >= 6, "every navigation key is consumed while expanded");
});

test("Ctrl+Shift+T toggles expansion; plain arrows scroll only while expanded", () => {
	const h = scrollHarness(false);
	h.component.render(100);
	h.fire(CS_UP); // compact scroll — chord
	assert.ok(h.consumed.includes("c:" + CS_UP));
	h.fire(CTRL_SHIFT_T); // expand
	assert.equal(h.expanded(), true);
	h.fire(UP); // expanded is modal → plain arrow scrolls
	assert.ok(h.consumed.includes("c:" + UP));
	h.fire("\u001b"); // collapse
	assert.equal(h.expanded(), false);
	h.fire(UP);
	assert.equal(h.consumed.filter((c) => c.startsWith("c:")).length, 4, "chord + Ctrl+Shift+T + expanded ↑ + Esc consumed; plain ↑ reaches the editor after collapse");
});

test("a new completion re-anchors the viewport to the latest completed task", () => {
	let current = manyTasksGoal();
	const { tui } = createMockTUI();
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => current,
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
	});
	// anchored to t20 → compact window t16..t20
	assert.match(component.render(100).join("\n"), /↑ 15 more tasks/);
	// scroll to the top with the compact chord
	assert.equal(component.handleCompactScrollKey("home"), true, "compact list overflows → chord consumed");
	assert.doesNotMatch(component.render(100).join("\n"), /↑ \d+ more tasks/);
	assert.match(component.render(100).join("\n"), /[✓▸·~] t1\s/, "the earliest task row is visible after scrolling up");
	// a short list: the chord is inert
	assert.equal(component.handleCompactScrollKey("down"), true, "still overflows → consumed");
	// a new completion (t9, later than t20) arrives → re-anchor to t9
	const tasks = (current.taskList!.tasks as GoalTask[]).map((t) => ({ ...t }));
	tasks[8] = { ...tasks[8]!, status: "complete", completedAt: "2026-01-01T12:00:00.000Z" };
	current = { ...current, taskList: { tasks, blockCompletion: false, proposedAt: testProposedAt } };
	const text = component.render(100).join("\n");
	assert.match(text, /↑ 4 more tasks/, "re-anchored window shows the new completion (offset 4)");
	assert.match(text, /Task number 9/, "the newest completion is visible at the bottom of the window");
});
