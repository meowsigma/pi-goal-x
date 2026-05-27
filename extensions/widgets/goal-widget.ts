import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	displayObjectiveTitle,
	formatDuration,
	formatTokenValue,
	truncateText,
	type GoalDisplayRecordLike,
} from "../goal-core.ts";


type GoalWidgetColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text">;

export interface GoalWidgetRecord extends GoalDisplayRecordLike {
	activePath?: string | null;
	archivedPath?: string | null;
	pauseReason?: string;
	pauseSuggestedAction?: string;
}

export interface AuditorWidgetProgress {
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	recentOutput: string[];
	phase: "running" | "tool_executing" | "producing_report" | "thinking" | "done";
	elapsedMs: number;
	/** Current step label shown to the user */
	label?: string;
	/** Completion percentage from 0 to 100 */
	percentage?: number;
}

export interface GoalWidgetOptions {
	theme: Theme;
	tui: TUI;
	getGoal: () => GoalWidgetRecord | null;
	getOpenGoalCount?: () => number;
	getAuditorProgress?: () => AuditorWidgetProgress | null;
}

function fit(value: string, width: number): string {
	return visibleWidth(value) > width ? truncateToWidth(value, width, "…") : value;
}

function heading(theme: Theme, width: number, left: string, right = ""): string {
	if (!right) return fit(left, width);
	const rightPart = ` ${right}`;
	const fill = Math.max(1, width - visibleWidth(left) - visibleWidth(rightPart));
	return fit(`${left}${theme.fg("dim", " ".repeat(fill))}${rightPart}`, width);
}

function branchLine(theme: Theme, width: number, isLast: boolean, content: string): string {
	const prefix = isLast ? "└─" : "├─";
	return fit(`${theme.fg("dim", prefix)} ${content}`, width);
}

function progressBar(pct: number, barWidth: number, theme: Theme): string {
	const safeBar = Math.max(3, barWidth);
	const filled = Math.min(safeBar, Math.max(0, Math.round((pct / 100) * safeBar)));
	const empty = safeBar - filled;
	return `[${theme.fg("accent", "█".repeat(filled))}${theme.fg("dim", "░".repeat(empty))}]`;
}

function displayIcon(goal: GoalWidgetRecord): { icon: string; color: GoalWidgetColor; label: string } {
	if (goal.status === "complete") return { icon: "✓", color: "success", label: "complete" };
	if (goal.status === "paused") {
		return goal.stopReason === "agent"
			? { icon: "⊘", color: "warning", label: "blocked" }
			: { icon: "◐", color: "muted", label: "paused" };
	}
	if (goal.sisyphus) return { icon: "◆", color: "accent", label: goal.autoContinue ? "sisyphus running" : "sisyphus idle" };
	return goal.autoContinue ? { icon: "●", color: "accent", label: "goal running" } : { icon: "○", color: "muted", label: "goal idle" };
}

function headingMeta(goal: GoalWidgetRecord, otherOpenGoalCount = 0): string {
	const bits: string[] = [];
	if (goal.status === "active" && goal.autoContinue) bits.push("auto");
	if (goal.usage.activeSeconds > 0) bits.push(formatDuration(goal.usage.activeSeconds));
	if (goal.usage.tokensUsed > 0) bits.push(formatTokenValue(goal.usage.tokensUsed));
	if (otherOpenGoalCount > 0) bits.push(`+${otherOpenGoalCount} open`);
	return bits.join(" · ");
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]!;
}

export function renderAuditorWidgetLines(progress: AuditorWidgetProgress, theme: Theme, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const isActive = progress.phase !== "done";
	const isThinking = progress.phase === "thinking";
	const icon = isActive
		? isThinking
			? theme.fg("muted", "⟡")
			: theme.fg("accent", spinnerFrame())
		: theme.fg("success", "✓");
	const label = isActive
		? isThinking
			? "thinking..."
			: "auditing"
		: "audit complete";
	// formatDuration expects seconds, progress.elapsedMs is in milliseconds
	const duration = formatDuration(Math.floor(progress.elapsedMs / 1000));
	const lines: string[] = [
		heading(
			theme,
			safeWidth,
			`${icon} ${theme.fg("accent", theme.bold("Audit"))} ${theme.fg("muted", label)}`,
			theme.fg("muted", duration),
		),
	];

	// Show step label when available
	if (progress.label) {
		lines.push(branchLine(
			theme,
			safeWidth,
			false,
			`${theme.fg("text", truncateText(progress.label, Math.max(8, safeWidth - 6)))}`,
		));
	}

	// Show progress bar when percentage is available
	if (typeof progress.percentage === "number") {
		const barWidth = Math.max(6, Math.min(safeWidth - 10, 30));
		const bar = progressBar(progress.percentage, barWidth, theme);
		const pct = `${theme.fg("muted", `${Math.round(progress.percentage)}%`)}`;
		lines.push(branchLine(
			theme,
			safeWidth,
			isActive && !progress.currentTool && progress.recentOutput.length === 0 && !isThinking,
			`${bar} ${pct}`,
		));
	}

	if (isActive && !isThinking && progress.currentTool) {
		const argText = progress.currentToolArgs
			? truncateText(progress.currentToolArgs, Math.max(10, safeWidth - 24))
			: "";
		const toolDuration = progress.currentToolStartedAt
			? ` ${theme.fg("dim", formatDuration(Date.now() - progress.currentToolStartedAt))}`
			: "";
		lines.push(branchLine(
			theme,
			safeWidth,
			false,
			`${theme.fg("accent", "tool")} ${theme.fg("text", progress.currentTool)}${argText ? ` ${theme.fg("dim", argText)}` : ""}${toolDuration}`,
		));
	}

	if (progress.recentOutput.length > 0) {
		// Show separator
		lines.push(branchLine(
			theme,
			safeWidth,
			!isActive,
			theme.fg("dim", "─".repeat(Math.max(4, safeWidth - 6))),
		));
		for (const [index, line] of progress.recentOutput.entries()) {
			const isLast = index === progress.recentOutput.length - 1 && !isActive;
			lines.push(branchLine(
				theme,
				safeWidth,
				isLast,
				theme.fg("dim", truncateText(line, Math.max(8, safeWidth - 6))),
			));
		}
	}

	// Show skip hint when audit is actively running
	if (isActive && !isThinking) {
		lines.push(branchLine(
			theme,
			safeWidth,
			true,
			theme.fg("warning", "Esc to skip") + theme.fg("dim", " — abort the audit and let the user decide"),
		));
	}

	return lines;
}

export function renderGoalWidgetLines(goal: GoalWidgetRecord | null, theme: Theme, width: number, options: { openGoalCount?: number; auditorProgress?: AuditorWidgetProgress | null } = {}): string[] {
	// When auditor progress is active, show auditor display instead of normal goal widget
	if (options.auditorProgress) {
		return renderAuditorWidgetLines(options.auditorProgress, theme, width);
	}
	if (!goal) {
		const openGoalCount = options.openGoalCount ?? 0;
		if (openGoalCount <= 0) return [];
		const safeWidth = Math.max(1, width);
		return [
			heading(theme, safeWidth, `${theme.fg("warning", "◇")} ${theme.fg("warning", theme.bold("Goal"))} ${theme.fg("muted", "unfocused")}`, theme.fg("muted", `${openGoalCount} open`)),
			branchLine(theme, safeWidth, true, `${theme.fg("muted", "Run /goal-focus to choose this session's goal")}`),
		];
	}
	const safeWidth = Math.max(1, width);
	const { icon, color, label } = displayIcon(goal);
	const mode = goal.sisyphus ? "Sisyphus" : "Goal";
	const headingLeft = `${theme.fg(color, icon)} ${theme.fg(color, theme.bold(mode))} ${theme.fg("muted", label.replace(/^sisyphus |^goal /, ""))}`;
	const otherOpenGoalCount = Math.max(0, (options.openGoalCount ?? (goal ? 1 : 0)) - 1);
	const headingRight = theme.fg("muted", headingMeta(goal, otherOpenGoalCount));
	const lines: string[] = [heading(theme, safeWidth, headingLeft, headingRight)];
	const body: string[] = [];

	const titleWidth = Math.max(12, safeWidth - 8);
	const objective = truncateText(displayObjectiveTitle(goal.objective), titleWidth);
	body.push(`${theme.fg("accent", "⟡")} ${theme.fg("text", objective)}`);

	if (goal.status === "paused" && goal.stopReason === "agent" && goal.pauseReason) {
		body.push(`${theme.fg("warning", "blocker")} ${theme.fg("warning", truncateText(goal.pauseReason, Math.max(12, safeWidth - 14)))}`);
		if (goal.pauseSuggestedAction) {
			body.push(`${theme.fg("dim", "next")} ${theme.fg("muted", truncateText(goal.pauseSuggestedAction, Math.max(12, safeWidth - 10)))}`);
		}
	}

	const path = goal.status === "complete" ? goal.archivedPath : goal.activePath;
	if (path) {
		body.push(theme.fg("dim", path));
	}

	for (const [index, content] of body.entries()) {
		lines.push(branchLine(theme, safeWidth, index === body.length - 1, content));
	}

	return lines;
}

export class GoalWidgetComponent implements Component {
	private theme: Theme;
	private tui: TUI;
	private getGoal: () => GoalWidgetRecord | null;
	private getOpenGoalCount: () => number;
	private getAuditorProgress: () => AuditorWidgetProgress | null;

	constructor(options: GoalWidgetOptions) {
		this.theme = options.theme;
		this.tui = options.tui;
		this.getGoal = options.getGoal;
		this.getOpenGoalCount = options.getOpenGoalCount ?? (() => (this.getGoal() ? 1 : 0));
		this.getAuditorProgress = options.getAuditorProgress ?? (() => null);
	}

	update(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return renderGoalWidgetLines(this.getGoal(), this.theme, width, {
			openGoalCount: this.getOpenGoalCount(),
			auditorProgress: this.getAuditorProgress(),
		});
	}

	invalidate(): void {
		this.tui.requestRender();
	}
}
