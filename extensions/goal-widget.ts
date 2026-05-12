import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	displayObjectiveTitle,
	formatDuration,
	formatRemainingTokens,
	formatTokenBudget,
	formatTokenValue,
	truncateText,
	type GoalDisplayRecordLike,
} from "./goal-core.ts";

const SISYPHUS_BAR_WIDTH = 10;

type GoalWidgetColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text">;

export interface GoalWidgetRecord extends GoalDisplayRecordLike {
	activePath?: string | null;
	archivedPath?: string | null;
	totalSteps?: number | null;
	stepsCompleted?: number;
	pauseReason?: string;
	pauseSuggestedAction?: string;
}

export interface GoalWidgetOptions {
	theme: Theme;
	tui: TUI;
	getGoal: () => GoalWidgetRecord | null;
}

function fit(value: string, width: number): string {
	return visibleWidth(value) > width ? truncateToWidth(value, width, "…") : value;
}

function line(theme: Theme, width: number, marker: "top" | "mid" | "tail", content: string): string {
	const prefix = marker === "top" ? "╭─" : marker === "tail" ? "╰─" : "│ ";
	const color: ThemeColor = marker === "top" || marker === "tail" ? "borderMuted" : "dim";
	return fit(`${theme.fg(color, prefix)} ${content}`, width);
}

function ruleHeading(theme: Theme, width: number, left: string, right = ""): string {
	const leftPart = `${theme.fg("borderMuted", "╭─")} ${left}`;
	if (!right) return fit(leftPart, width);
	const rightPart = ` ${right}`;
	const fill = Math.max(1, width - visibleWidth(leftPart) - visibleWidth(rightPart));
	return fit(`${leftPart}${theme.fg("borderMuted", "─".repeat(fill))}${rightPart}`, width);
}

function displayIcon(goal: GoalWidgetRecord): { icon: string; color: GoalWidgetColor; label: string } {
	if (goal.status === "complete") return { icon: "✓", color: "success", label: "complete" };
	if (goal.status === "paused") {
		return goal.stopReason === "agent"
			? { icon: "⊘", color: "warning", label: "blocked" }
			: { icon: "◐", color: "muted", label: "paused" };
	}
	if (goal.status === "budgetLimited") return { icon: "◑", color: "warning", label: "budget" };
	if (goal.sisyphus) return { icon: "◆", color: "accent", label: goal.autoContinue ? "sisyphus running" : "sisyphus idle" };
	return goal.autoContinue ? { icon: "●", color: "accent", label: "goal running" } : { icon: "○", color: "muted", label: "goal idle" };
}

function sisyphusBar(goal: GoalWidgetRecord, theme: Theme): string {
	const total = goal.totalSteps ?? 0;
	if (!goal.sisyphus || total <= 0) return "";
	const done = Math.min(goal.stepsCompleted ?? 0, total);
	const filled = Math.max(0, Math.min(SISYPHUS_BAR_WIDTH, Math.round((done / total) * SISYPHUS_BAR_WIDTH)));
	const empty = SISYPHUS_BAR_WIDTH - filled;
	return `[${theme.fg("accent", "▰".repeat(filled))}${theme.fg("dim", "▱".repeat(empty))}] ${done}/${total}`;
}

function headingMeta(goal: GoalWidgetRecord, theme: Theme): string {
	const bits: string[] = [];
	const bar = sisyphusBar(goal, theme);
	if (bar) bits.push(bar);
	if (goal.status === "active" && goal.autoContinue) bits.push("auto");
	if (goal.usage.activeSeconds > 0) bits.push(formatDuration(goal.usage.activeSeconds));
	if (goal.usage.tokensUsed > 0) bits.push(formatTokenValue(goal.usage.tokensUsed));
	return bits.join(" · ");
}

export function renderGoalWidgetLines(goal: GoalWidgetRecord | null, theme: Theme, width: number): string[] {
	if (!goal) return [];
	const safeWidth = Math.max(1, width);
	const { icon, color, label } = displayIcon(goal);
	const mode = goal.sisyphus ? "Sisyphus" : "Goal";
	const headingLeft = `${theme.fg(color, icon)} ${theme.fg(color, theme.bold(mode))} ${theme.fg("muted", label.replace(/^sisyphus |^goal /, ""))}`;
	const headingRight = theme.fg("muted", headingMeta(goal, theme));
	const lines: string[] = [ruleHeading(theme, safeWidth, headingLeft, headingRight)];

	const titleWidth = Math.max(12, safeWidth - 8);
	const objective = truncateText(displayObjectiveTitle(goal.objective), titleWidth);
	lines.push(line(theme, safeWidth, "mid", `${theme.fg("accent", "⟡")} ${theme.fg("text", objective)}`));

	if (goal.tokenBudget !== null) {
		lines.push(line(theme, safeWidth, "mid", `${theme.fg("dim", "budget")} ${theme.fg("muted", `${formatTokenBudget(goal)} · remaining ${formatRemainingTokens(goal)}`)}`));
	}

	if (goal.status === "paused" && goal.stopReason === "agent" && goal.pauseReason) {
		lines.push(line(theme, safeWidth, "mid", `${theme.fg("warning", "blocker")} ${theme.fg("warning", truncateText(goal.pauseReason, Math.max(12, safeWidth - 14)))}`));
		if (goal.pauseSuggestedAction) {
			lines.push(line(theme, safeWidth, "mid", `${theme.fg("dim", "next")} ${theme.fg("muted", truncateText(goal.pauseSuggestedAction, Math.max(12, safeWidth - 10)))}`));
		}
	}

	const path = goal.status === "complete" ? goal.archivedPath : goal.activePath;
	if (path) {
		lines.push(line(theme, safeWidth, "tail", theme.fg("dim", path)));
	} else {
		const last = lines.pop() ?? "";
		lines.push(fit(last.replace(theme.fg("dim", "│ "), theme.fg("borderMuted", "╰─")), safeWidth));
	}

	return lines;
}

export class GoalWidgetComponent implements Component {
	private theme: Theme;
	private tui: TUI;
	private getGoal: () => GoalWidgetRecord | null;

	constructor(options: GoalWidgetOptions) {
		this.theme = options.theme;
		this.tui = options.tui;
		this.getGoal = options.getGoal;
	}

	update(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return renderGoalWidgetLines(this.getGoal(), this.theme, width);
	}

	invalidate(): void {
		this.tui.requestRender();
	}
}
