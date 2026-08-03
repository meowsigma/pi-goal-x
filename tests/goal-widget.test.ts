import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderGoalWidgetLines, renderAuditorWidgetLines, GoalWidgetComponent, type GoalWidgetRecord, type AuditorWidgetProgress } from "../extensions/widgets/goal-widget.ts";
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

test("renderGoalWidgetLines renders a distinct Sisyphus goal beacon", () => {
	const lines = renderGoalWidgetLines(goal(), theme, 100);
	assert.match(lines[0], /^◆ Sisyphus running/);
	assert.match(lines[0], /auto · 1m05s · 2\.5K/);
	assert.doesNotMatch(lines[0], /▰|▱/);
	assert.match(lines[1], /^├─ ⟡ Componentize the goal widget/);
	assert.doesNotMatch(lines.join("\n"), /pulse/);
	assert.match(lines.at(-1) ?? "", /^└─ \.pi\/goals\/active_goal\.md/);
});

test("renderGoalWidgetLines merges complete usage into the heading", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "complete",
		autoContinue: false,
		sisyphus: false,
		archivedPath: ".pi/goals/archived/goal.md",
	}), theme, 100);
	assert.match(lines[0], /^✓ Goal complete/);
	assert.match(lines[0], /1m05s · 2\.5K/);
	assert.doesNotMatch(lines.join("\n"), /pulse/);
});


test("renderGoalWidgetLines highlights agent blockers and suggested action", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "paused",
		autoContinue: false,
		stopReason: "agent",
		pauseReason: "Missing API token",
		pauseSuggestedAction: "Set TOKEN and run /goal-resume",
	}), theme, 100);
	assert.match(lines[0], /⊘ Sisyphus blocked/);
	assert.match(lines.join("\n"), /^├─ blocker Missing API token/m);
	assert.match(lines.join("\n"), /^├─ next Set TOKEN and run \/goal-resume/m);
});

test("renderGoalWidgetLines shows other open goals and unfocused multi-goal guidance", () => {
	const focused = renderGoalWidgetLines(goal(), theme, 100, { openGoalCount: 3 });
	assert.match(focused[0], /\+2 open/);

	const unfocused = renderGoalWidgetLines(null, theme, 100, { openGoalCount: 2 });
	assert.match(unfocused[0], /^◇ Goal unfocused/);
	assert.match(unfocused[0], /2 open/);
	assert.match(unfocused.join("\n"), /\/goal-focus/);
});

test("renderAuditorWidgetLines shows auditor progress with current tool", () => {
	const progress = auditorProgress();
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	// Should show audit heading with duration (5s)
	assert.match(lines[0], /Audit/);
	assert.match(lines[0], /auditing/);
	// Should show current tool
	assert.match(lines.join("\n"), /tool.*read.*test\.txt/);
	// Should show recent output lines
	assert.match(lines.join("\n"), /checking file exists/);
	assert.match(lines.join("\n"), /confirming test coverage/);
});

test("renderAuditorWidgetLines shows done phase with success icon", () => {
	const progress = auditorProgress({ phase: "done", currentTool: undefined, currentToolArgs: undefined });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	assert.match(lines[0], /✓.*audit complete/);
	assert.doesNotMatch(lines.join("\n"), /tool/);
});

test("renderAuditorWidgetLines handles empty recent output", () => {
	const progress = auditorProgress({ recentOutput: [], phase: "running" });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	assert.match(lines[0], /Audit.*auditing/);
	// Should have heading + tool line, but no separator dash line (which contains 4+ ─ characters)
	assert.equal(lines.filter((l) => l.includes("────")).length, 0);
});

test("auditor progress overrides normal goal display when provided", () => {
	// When auditorProgress is passed to renderGoalWidgetLines, should show auditor instead of goal
	const progress = auditorProgress();
	const lines = renderGoalWidgetLines(goal(), theme, 100, { auditorProgress: progress });
	assert.match(lines[0], /Audit/);
	assert.doesNotMatch(lines[0], /Sisyphus|Goal/);
});

test("renderAuditorWidgetLines shows Esc to skip hint when audit is active", () => {
	const progress = auditorProgress({ phase: "running" });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	// The skip hint should appear when audit is actively running
	const allText = lines.join("\n");
	assert.match(allText, /Esc to skip/);
	assert.match(allText, /abort the audit/);
	// Skip hint should be on the last line (closing branch)
	assert.match(lines[lines.length - 1], /Esc to skip/);
});

test("renderAuditorWidgetLines omits skip hint when audit is done", () => {
	const progress = auditorProgress({ phase: "done" });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	const allText = lines.join("\n");
	assert.doesNotMatch(allText, /Esc to skip/);
	assert.doesNotMatch(allText, /abort the audit/);
});

test("renderAuditorWidgetLines shows progress bar when percentage is set", () => {
	const progress = auditorProgress({
		phase: "running",
		percentage: 40,
		label: "Inspecting files...",
	});
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	const allText = lines.join("\n");
	// Should show step label
	assert.match(allText, /Inspecting files/);
	// Should show percentage
	assert.match(allText, /40%/);
	// Should show a progress bar (brackets with filled/empty chars)
	assert.match(allText, /\[.*█.*░.*\]/);
});

test("renderAuditorWidgetLines shows thinking phase with distinct icon", () => {
	const progress = auditorProgress({
		phase: "thinking",
		label: "Analyzing goal...",
		recentOutput: [],
	});
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	const allText = lines.join("\n");
	// Should show thinking label
	assert.match(allText, /thinking\.\.\./);
	// Should not show Esc to skip hint during thinking
	assert.doesNotMatch(allText, /Esc to skip/);
});

test("renderAuditorWidgetLines shows step label when present", () => {
	const progress = auditorProgress({
		phase: "running",
		label: "Verifying success criteria...",
		percentage: 50,
	});
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	const allText = lines.join("\n");
	assert.match(allText, /Verifying success criteria/);
	// Should show both label and percentage
	assert.match(allText, /50%/);
});

test("renderAuditorWidgetLines handles progress bar at 0% and 100%", () => {
	const zero = renderAuditorWidgetLines(auditorProgress({ phase: "running", percentage: 0 }), theme, 100).join("\n");
	assert.match(zero, /0%/);

	const hundred = renderAuditorWidgetLines(auditorProgress({ phase: "done", percentage: 100 }), theme, 100).join("\n");
	assert.match(hundred, /100%/);
});

test("renderAuditorWidgetLines no progress bar when percentage is undefined", () => {
	const progress = auditorProgress({ phase: "running", label: "Working..." });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	const allText = lines.join("\n");
	// Should show label but no percentage
	assert.match(allText, /Working/);
	assert.doesNotMatch(allText, /\d+%/);
});

const testProposedAt = "2026-01-01T00:00:00.000Z";

test("renderGoalWidgetLines shows task count in heading when taskList present", () => {
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
	const heading = lines[0];
	assert.ok(heading);
	assert.match(heading, /2\/3 tasks/);
});

test("renderGoalWidgetLines shows next pending task in body", () => {
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
	const body = lines.slice(1).join(" ");
	assert.match(body, /◻/);
	assert.match(body, /next/);
});

test("renderGoalWidgetLines shows 'All tasks complete' when all done", () => {
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
	const body = lines.slice(1).join(" ");
	assert.match(body, /All tasks complete/);
});

test("renderGoalWidgetLines omits task line when no taskList", () => {
	const lines = renderGoalWidgetLines(goal(), theme, 100);
	const body = lines.slice(1).join(" ");
	assert.equal(body.includes("tasks"), false);
});

// ── Subtask widget display ──────────────────────────────────────────────

test("renderGoalWidgetLines counts subtasks recursively in heading", () => {
	const lines = renderGoalWidgetLines(goal({
		taskList: {
			tasks: [{
				id: "t1", title: "Parent", status: "complete",
				subtasks: [
					{ id: "t1a", title: "Child", status: "pending" },
					{ id: "t1b", title: "Child2", status: "pending" },
				],
			}],
			blockCompletion: false,
			proposedAt: testProposedAt,
		},
	}), theme, 100);
	// Heading: 1/3 tasks (1 parent complete + 2 pending children)
	assert.match(lines[0], /1\/3 tasks/);
});

test("renderGoalWidgetLines finds first pending at any depth (BFS)", () => {
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
	const body = lines.slice(1).join(" ");
	// Should show t1a as next, not t1 (t1 is complete, t1a is pending)
	assert.match(body, /t1a/);
	assert.match(body, /next/);
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
	const body = lines.slice(1).join(" ");
	assert.match(body, /All tasks complete/);
});

test("renderGoalWidgetLines suppresses task info when disableTasks is true with subtasks", () => {
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
	const body = lines.slice(1).join(" ");
	assert.equal(body.includes("tasks"), false);
	assert.equal(body.includes("t1a"), false);
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
	assert.match(lines[0], /◆ Sisyphus running/);
	assert.match(lines[1], /├─ ⟡ Componentize the goal widget/);
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
assert.match(text, /\+2 open/);
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

test("GoalWidgetComponent renders auditor progress when present", () => {
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
	assert.match(text, /read/);
	assert.match(text, /test\.txt/);
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
	assert.equal(text.includes("tasks"), false, "Tasks hidden when disableTasks is true");
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
	assert.match(lines[0], /Goal complete/);
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
