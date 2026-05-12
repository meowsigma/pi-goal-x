import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderGoalWidgetLines, type GoalWidgetRecord } from "../extensions/goal-widget.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

function goal(overrides: Partial<GoalWidgetRecord> = {}): GoalWidgetRecord {
	return {
		objective: "=== Goal ===\nObjective: Componentize the goal widget\nSuccess criteria: tests pass",
		status: "active",
		autoContinue: true,
		tokenBudget: 10_000,
		usage: { activeSeconds: 65, tokensUsed: 2500 },
		sisyphus: true,
		totalSteps: 2,
		stepsCompleted: 1,
		activePath: ".pi/goals/active_goal.md",
		...overrides,
	};
}

test("renderGoalWidgetLines renders a distinct Sisyphus goal beacon", () => {
	const lines = renderGoalWidgetLines(goal(), theme, 100);
	assert.match(lines[0], /╭─ ◆ Sisyphus running/);
	assert.match(lines[0], /\[▰▰▰▰▰▱▱▱▱▱\] 1\/2/);
	assert.match(lines[1], /⟡ Componentize the goal widget/);
	assert.match(lines[2], /pulse sisyphus running · auto · 1m05s · 2\.5K/);
	assert.match(lines[3], /budget 10K .* remaining 7\.5K/);
	assert.match(lines.at(-1) ?? "", /╰─ \.pi\/goals\/active_goal\.md/);
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
	assert.match(lines.join("\n"), /blocker Missing API token/);
	assert.match(lines.join("\n"), /next Set TOKEN and run \/goal-resume/);
});
