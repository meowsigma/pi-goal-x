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
import type { GoalTask, GoalTaskList, TaskStatus } from "../goal-record.ts";
import type { GoalSettings } from "../goal-settings.ts";

type GoalWidgetColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text">;

export interface GoalWidgetRecord extends GoalDisplayRecordLike {
	id: string;
	createdAt: string;
	updatedAt: string;
	activePath?: string | null;
	archivedPath?: string | null;
	pauseReason?: string;
	pauseSuggestedAction?: string;
	taskList?: GoalTaskList | null;
	verificationContract?: string;
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
	getSettings?: () => GoalSettings;
	getDebugMode?: () => boolean;
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

function countFlatTasks(tasks: GoalTask[]): { total: number; done: number } {
	let total = 0;
	let done = 0;
	for (const t of tasks) {
		total++;
		if (t.status === "complete" || t.status === "skipped") done++;
		if (t.subtasks && t.subtasks.length > 0) {
			const child = countFlatTasks(t.subtasks);
			total += child.total;
			done += child.done;
		}
	}
	return { total, done };
}

function findFirstPending(tasks: GoalTask[]): GoalTask | undefined {
	const queue = [...tasks];
	while (queue.length > 0) {
		const t = queue.shift()!;
		if (t.status === "pending") return t;
		if (t.subtasks) queue.push(...t.subtasks);
	}
	return undefined;
}

function headingMeta(goal: GoalWidgetRecord, otherOpenGoalCount = 0, disableTasks = false): string {
	const bits: string[] = [];
	if (goal.status === "active" && goal.autoContinue) bits.push("auto");
	if (goal.usage.activeSeconds > 0) bits.push(formatDuration(goal.usage.activeSeconds));
	if (goal.usage.tokensUsed > 0) bits.push(formatTokenValue(goal.usage.tokensUsed));
	if (!disableTasks && goal.taskList && goal.taskList.tasks.length > 0) {
		const { total, done } = countFlatTasks(goal.taskList.tasks);
		bits.push(`${done}/${total} tasks`);
	}
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

export function renderGoalWidgetLines(goal: GoalWidgetRecord | null, theme: Theme, width: number, options: { openGoalCount?: number; auditorProgress?: AuditorWidgetProgress | null; disableTasks?: boolean } = {}): string[] {
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
	const headingRight = theme.fg("muted", headingMeta(goal, otherOpenGoalCount, options.disableTasks));
	const lines: string[] = [heading(theme, safeWidth, headingLeft, headingRight)];
	const body: string[] = [];

	const titleWidth = Math.max(12, safeWidth - 8);
	const objective = truncateText(displayObjectiveTitle(goal.objective), titleWidth);
	body.push(`${theme.fg("accent", "⟡")} ${theme.fg("text", objective)}`);

	if (!options.disableTasks && goal.taskList && goal.taskList.tasks.length > 0) {
		const { total, done } = countFlatTasks(goal.taskList.tasks);
		if (done === total) {
			body.push(`${theme.fg("success", "✓")} ${theme.fg("muted", "All tasks complete")}`);
		} else {
			const firstPending = findFirstPending(goal.taskList.tasks);
			if (firstPending) {
				body.push(`${theme.fg("warning", "◻")} ${theme.fg("muted", `${firstPending.id}: ${truncateText(firstPending.title, Math.max(8, safeWidth - 20))} (next)`)}`);
			}
		}
	}

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
	private getSettings: () => GoalSettings;
	private getDebugMode: () => boolean;

	constructor(options: GoalWidgetOptions) {
		this.theme = options.theme;
		this.tui = options.tui;
		this.getGoal = options.getGoal;
		this.getOpenGoalCount = options.getOpenGoalCount ?? (() => (this.getGoal() ? 1 : 0));
		this.getAuditorProgress = options.getAuditorProgress ?? (() => null);
		this.getSettings = options.getSettings ?? (() => ({}));
		this.getDebugMode = options.getDebugMode ?? (() => false);
	}

	update(): void {
		this.tui.requestRender();
	}

	/** Render debug info panel when debug mode is active */
	private renderDebugPanel(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		const safeWidth = Math.max(20, width);

		// Divider
		lines.push(t.fg("dim", "─".repeat(safeWidth)));
		lines.push(t.fg("warning", "⊙ [DEBUG MODE]"));
		lines.push("");

		const goal = this.getGoal();
		if (goal) {
			lines.push(t.fg("dim", `  id: ${goal.id}`));
			lines.push(t.fg("dim", `  status: ${goal.status}`));
			lines.push(t.fg("dim", `  objective: ${truncateText(goal.objective, 80)}`));
			lines.push(t.fg("dim", `  sisyphus: ${goal.sisyphus}`));
			lines.push(t.fg("dim", `  autoContinue: ${goal.autoContinue}`));
			lines.push(t.fg("dim", `  tokens: ${goal.usage.tokensUsed}`));
			lines.push(t.fg("dim", `  activeSeconds: ${goal.usage.activeSeconds}`));
			lines.push(t.fg("dim", `  createdAt: ${goal.createdAt}`));
			lines.push(t.fg("dim", `  updatedAt: ${goal.updatedAt}`));
			if (goal.pauseReason) lines.push(t.fg("dim", `  pauseReason: ${goal.pauseReason}`));
			if (goal.pauseSuggestedAction) lines.push(t.fg("dim", `  pauseSuggestedAction: ${goal.pauseSuggestedAction}`));
			if (goal.stopReason) lines.push(t.fg("dim", `  stopReason: ${goal.stopReason}`));
			if (goal.activePath) lines.push(t.fg("dim", `  activePath: ${goal.activePath}`));
			if (goal.archivedPath) lines.push(t.fg("dim", `  archivedPath: ${goal.archivedPath}`));
			if (goal.verificationContract) lines.push(t.fg("dim", `  vContract: ${truncateText(goal.verificationContract, 60)}`));

			// Task tree summary
			if (goal.taskList && goal.taskList.tasks.length > 0) {
				const { total, done } = countFlatTasks(goal.taskList.tasks);
				lines.push(t.fg("dim", `  tasks: ${done}/${total}`));
				const firstPending = findFirstPending(goal.taskList.tasks);
				if (firstPending) lines.push(t.fg("dim", `  next: ${firstPending.id} (${truncateText(firstPending.title, 40)})`));
			}
		} else {
			lines.push(t.fg("dim", "  (no goal)"));
		}

		lines.push("");
		lines.push(t.fg("dim", "── Debug keybindings ──"));
		lines.push(t.fg("dim", "  Ctrl+Shift+X  Toggle debug mode"));
		lines.push(t.fg("dim", "  Ctrl+Shift+N  Create test goal"));
		lines.push(t.fg("dim", "  Ctrl+Shift+T  Inject sample tasks"));
		lines.push(t.fg("dim", "  Ctrl+Shift+R  Mock audit animation"));
		lines.push(t.fg("dim", "  Ctrl+Shift+O  Open proposal dialog"));

		return lines;
	}

	render(width: number): string[] {
		const settings = this.getSettings();
		let lines = renderGoalWidgetLines(this.getGoal(), this.theme, width, {
			openGoalCount: this.getOpenGoalCount(),
			auditorProgress: this.getAuditorProgress(),
			disableTasks: settings.disableTasks,
		});
		if (this.getDebugMode()) {
			lines.push(...this.renderDebugPanel(width));
		}
		// Safety net: ensure no returned line exceeds the terminal width
		for (let i = 0; i < lines.length; i++) {
			if (visibleWidth(lines[i]) > width) {
				lines[i] = truncateToWidth(lines[i], width);
			}
		}
		return lines;
	}

	invalidate(): void {
		this.tui.requestRender();
	}
}
