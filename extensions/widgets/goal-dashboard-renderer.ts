/**
 * Unified dashboard renderer (plan §5, §4).
 *
 * Renders the shared dashboard view model (goal-dashboard-model.ts) as the
 * compact above-editor widget, the expanded full dashboard (which replaces the
 * task overlay), and the unfocused panel. Pure presentation: all data comes
 * from the model; this file owns the §5 visual spec (borders, status symbols,
 * progress bars, responsive layouts, width-safe ANSI/Unicode handling) and
 * must never emit a line wider than the requested terminal width.
 *
 * Layout modes (§5.5): wide ≥100, medium 70–99, narrow 50–69, minimal <50.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	anchoredScrollOffset,
	compactTaskViewportRows,
	deriveTaskListViewport,
	formatAuditElapsed,
	formatBudget,
	type DashboardStatusCode,
	type DashboardTaskNode,
	type GoalDashboardModel,
	type TaskListViewport,
} from "./goal-dashboard-model.ts";
import type { GoalActivityItem } from "../goal-activity.ts";
import { truncateText } from "../goal-core.ts";

type RenderColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text" | "mdHeading" | "mdLink">;

// ── §5.1 border system ──────────────────────────────────────────────────────

const H = "─";
const V = "│";

/** Outer box frame: light steel gray-blue (mdLink) — clearly lighter than the
 * interior rules and in the same hue family as pi's own borders. */
function frame(theme: Theme, value: string): string {
	return theme.fg("mdLink", value);
}

/** Interior rules: theme gray (muted) — subtle hierarchy inside the frame. */
function border(theme: Theme, value: string): string {
	return theme.fg("muted", value);
}

function fit(value: string, width: number): string {
	return visibleWidth(value) > width ? truncateToWidth(value, width, "…") : value;
}

function boxHeader(theme: Theme, width: number, left: string, right = ""): string {
	const inner = Math.max(4, width - 2);
	// The leading/trailing dashes belong to the frame, so they carry the same
	// color as the fill; only the corners stay plain.
	const l = `${frame(theme, H)} ${left}`;
	const r = right ? ` ${right} ${frame(theme, H)}` : "";
	const fixed = visibleWidth(l) + visibleWidth(r);
	if (fixed > inner - 2) {
		// Too tight: truncate the title so the right-side meta survives.
		const budget = Math.max(4, inner - visibleWidth(r) - 4);
		const l2 = `${frame(theme, H)} ${fit(left, budget)}`;
		const fill = Math.max(1, inner - visibleWidth(l2) - visibleWidth(r));
		return `╭${l2}${frame(theme, H.repeat(fill))}${r}╮`;
	}
	const fill = Math.max(1, inner - fixed);
	return `╭${l}${frame(theme, H.repeat(fill))}${r}╮`;
}

function boxLine(theme: Theme, width: number, content: string): string {
	const inner = Math.max(2, width - 2);
	const contentFit = fit(content, inner - 1);
	const pad = Math.max(0, inner - 1 - visibleWidth(contentFit));
	return `${V} ${contentFit}${" ".repeat(pad)}${V}`;
}

function boxRule(theme: Theme, width: number): string {
	return `├${border(theme, H.repeat(Math.max(1, width - 2)))}┤`;
}

/** Section separator with a label: `├─ Tasks ──────────┤` (§5.1). */
function boxSectionRule(theme: Theme, width: number, label: string): string {
	const inner = Math.max(4, width - 2);
	const left = border(theme, `${H} ${label} `);
	const fill = Math.max(1, inner - visibleWidth(left));
	return `├${left}${border(theme, H.repeat(fill))}┤`;
}

function boxFooter(theme: Theme, width: number, content: string): string {
	const inner = Math.max(4, width - 2);
	if (!content) {
		return `╰${frame(theme, H.repeat(inner))}╯`;
	}
	// The footer is one frame tone: leading dash, hint text and trailing fill
	// all carry the frame color, so the blue-gray spans the whole line.
	const l = frame(theme, `${H} ${fit(content, inner - 4)}`);
	const fill = Math.max(1, inner - visibleWidth(l));
	return `╰${l}${frame(theme, H.repeat(fill))}╯`;
}

// ── §5.2 status symbols / colors ────────────────────────────────────────────

const STATUS_SYMBOL: Record<DashboardStatusCode, string> = {
	running: "●",
	idle: "○",
	paused: "◐",
	blocked: "⊘",
	budget_limited: "⛽",
	complete: "✓",
};

const STATUS_COLOR: Record<DashboardStatusCode, RenderColor> = {
	running: "accent",
	idle: "muted",
	paused: "muted",
	blocked: "error",
	budget_limited: "mdHeading",
	complete: "success",
};

// ── §5.3 progress bars ──────────────────────────────────────────────────────

function progressBar(theme: Theme, pct: number, barWidth: number): string {
	const safeBar = Math.max(2, barWidth);
	const filled = Math.min(safeBar, Math.max(0, Math.round((pct / 100) * safeBar)));
	return `[${theme.fg("accent", "█".repeat(filled))}${theme.fg("dim", "░".repeat(safeBar - filled))}]`;
}

// ── Layout modes (§5.5) ─────────────────────────────────────────────────────

type LayoutMode = "wide" | "medium" | "narrow" | "minimal";

function layoutMode(width: number): LayoutMode {
	if (width >= 100) return "wide";
	if (width >= 70) return "medium";
	if (width >= 50) return "narrow";
	return "minimal";
}

interface LayoutSpec {
	barWidth: number;
	showFocused: boolean;
	showOtherGoals: boolean;
	showPath: boolean;
	showPauseAction: boolean;
	footerHint: string;
	statusLine: "full" | "brief";
}

function specFor(mode: LayoutMode): LayoutSpec {
	switch (mode) {
		case "wide":
			return { barWidth: 26, showFocused: true, showOtherGoals: true, showPath: true, showPauseAction: true, footerHint: "Ctrl+Shift+T: expand tasks", statusLine: "full" };
		case "medium":
			return { barWidth: 18, showFocused: true, showOtherGoals: true, showPath: true, showPauseAction: true, footerHint: "Ctrl+Shift+T: expand tasks", statusLine: "full" };
		case "narrow":
			return { barWidth: 12, showFocused: true, showOtherGoals: true, showPath: false, showPauseAction: false, footerHint: "Ctrl+Shift+T: expand", statusLine: "brief" };
		case "minimal":
			return { barWidth: 8, showFocused: false, showOtherGoals: false, showPath: false, showPauseAction: false, footerHint: "Ctrl+Shift+T: expand", statusLine: "brief" };
	}
}

// ── shared row helpers ──────────────────────────────────────────────────────

function muted(theme: Theme, value: string): string {
	return theme.fg("muted", value);
}

function dim(theme: Theme, value: string): string {
	return theme.fg("dim", value);
}

function accent(theme: Theme, value: string): string {
	return theme.fg("accent", value);
}

function success(theme: Theme, value: string): string {
	return theme.fg("success", value);
}

/** Pastel accent helpers (§5): amber for tasks, teal for current/progress,
 * muted gray for chrome, soft red for blockers, muted green for complete. */
function amber(theme: Theme, value: string): string {
	return theme.fg("mdHeading", value);
}

// ── task tree rows (§9.2) ───────────────────────────────────────────────────

/** Task rows: pending amber ·, complete muted-green ✓, skipped gray ~, and
 * the current task teal ▸ with accent text; row text is pastel amber. */
function taskMarker(node: DashboardTaskNode): { symbol: string; color: RenderColor } {
	if (node.isCurrent) return { symbol: "▸", color: "accent" };
	if (node.status === "complete") return { symbol: "✓", color: "success" };
	if (node.status === "skipped") return { symbol: "~", color: "muted" };
	return { symbol: "·", color: "mdHeading" };
}

function renderTaskRow(theme: Theme, node: DashboardTaskNode, indent: number, available: number): string {
	const marker = taskMarker(node);
	const indentText = "  ".repeat(indent);
	const prefix = `${indentText}${marker.symbol} ${node.id}  `;
	const contractMark = node.verificationContract ? dim(theme, " ☑") : "";
	const titleBudget = Math.max(4, available - visibleWidth(prefix) - visibleWidth(contractMark));
	const title = fit(node.title, titleBudget);
	const markerText = theme.fg(marker.color, marker.symbol);
	// Colour-coded: the id shares the marker color (amber pending, green
	// complete, gray skipped, teal current); titles stay amber, the current
	// task is fully accent.
	const idText = node.isCurrent ? accent(theme, node.id) : theme.fg(marker.color, node.id);
	const titleText = node.isCurrent ? accent(theme, title) : amber(theme, title);
	return `${indentText}${markerText} ${idText}  ${titleText}${contractMark}`;
}

/**
 * Compact task-list rows (§9.2, §9.6): top-level tasks shown in a window over
 * the plan-ordered list with colored markers and truncated titles, an aligned
 * id column, and `↑ N more` / `… +N more` indicator rows so the widget height
 * stays bounded. The window is a viewport (offset + rows) derived from the
 * shared model — the default (anchored) offset is computed by the caller when
 * no explicit offset is given.
 */
function renderCompactTaskRows(theme: Theme, nodes: DashboardTaskNode[], viewport: TaskListViewport, available: number): string[] {
	const rows: string[] = [];
	if (viewport.hiddenAbove > 0) {
		rows.push(muted(theme, `↑ ${viewport.hiddenAbove} more task${viewport.hiddenAbove === 1 ? "" : "s"}`));
	}
	const shown = nodes.slice(viewport.offset, viewport.offset + viewport.rows);
	const idWidth = shown.length === 0 ? 0 : Math.min(10, Math.max(...shown.map((node) => node.id.length)));
	for (const node of shown) {
		const marker = taskMarker(node);
		const contractMark = node.verificationContract ? dim(theme, " ☑") : "";
		const id = node.id.padEnd(idWidth);
		const prefix = `${marker.symbol} ${id}  `;
		const titleBudget = Math.max(4, available - visibleWidth(prefix) - visibleWidth(contractMark));
		const title = fit(node.title, titleBudget);
		const markerText = theme.fg(marker.color, marker.symbol);
		// Colour-coded: id shares the marker color; titles amber; current accent.
		const idText = node.isCurrent ? accent(theme, id) : theme.fg(marker.color, id);
		const body = node.isCurrent ? accent(theme, title) : amber(theme, title);
		rows.push(`${markerText} ${idText}  ${body}${contractMark}`);
	}
	if (viewport.hiddenBelow > 0) {
		rows.push(muted(theme, `… +${viewport.hiddenBelow} more task${viewport.hiddenBelow === 1 ? "" : "s"}`));
	}
	return rows;
}

// ── activity rows ───────────────────────────────────────────────────────────

function activityMarker(item: GoalActivityItem): { symbol: string; color: RenderColor } {
	if (item.marker === "done") return { symbol: "✓", color: "success" };
	if (item.marker === "current") return { symbol: "▸", color: "accent" };
	if (item.marker === "skipped") return { symbol: "~", color: "mdHeading" };
	return { symbol: "·", color: "muted" };
}

// ── COMPACT DASHBOARD (§4.1) ────────────────────────────────────────────────

/**
 * Persistent summary above the editor while a goal is focused. Visually rich
 * but compact; the footer hints at the expansion shortcut.
 */
export function renderCompactDashboard(
	model: GoalDashboardModel,
	theme: Theme,
	width: number,
	opts: { footerHint?: string; scrollOffset?: number } = {},
): string[] {
	const safeWidth = Math.max(10, width);
	const mode = layoutMode(safeWidth);
	const spec = specFor(mode);
	const inner = safeWidth - 2;
	const lines: string[] = [];

	const usageRight = mode !== "minimal" && (model.usage.activeSeconds > 0 || model.usage.tokens > 0)
		? `${model.usage.elapsedLabel} · ${model.usage.tokenLabel}`
		: "";
	lines.push(boxHeader(theme, safeWidth, `${accent(theme, "pi-goal-x")} ${frame(theme, `─ ${model.title}`)}`, usageRight ? frame(theme, usageRight) : ""));

	// Status line.
	if (model.status.code === "complete") {
		lines.push(boxLine(theme, safeWidth, `${success(theme, "✓")} ${success(theme, "All required work is complete.")}`));
	} else {
		const symbol = STATUS_SYMBOL[model.status.code];
		const color = STATUS_COLOR[model.status.code];
		const bits = [`${theme.fg(color, symbol)} ${theme.fg(color, model.status.label)}`];
		if (spec.showFocused) bits.push(muted(theme, `Focused: ${model.focused ? "yes" : "no"}`));
		if (spec.showOtherGoals && model.otherOpenGoals > 0) bits.push(muted(theme, `Other goals: ${model.otherOpenGoals}`));
		lines.push(boxLine(theme, safeWidth, bits.join(" · ")));
	}

	// Budget (when configured): fuel gauge + amount, amber until the budget is
	// exhausted, then soft red.
	if (model.budget) {
		const fuel = model.budget.used >= model.budget.total ? "error" : "mdHeading";
		lines.push(boxLine(theme, safeWidth, `${theme.fg(fuel as RenderColor, "⛽")} ${muted(theme, "Budget")} ${theme.fg(fuel as RenderColor, formatBudget(model.budget.used, model.budget.total))}`));
	}

	// Overall task progress (§9.1). The fraction is muted like the percent:
	// only the bar itself stays colourful.
	if (model.taskProgress) {
		const bar = progressBar(theme, model.taskProgress.percentage, spec.barWidth);
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Tasks")}  ${bar} ${muted(theme, `${model.taskProgress.completed}/${model.taskProgress.total} · ${model.taskProgress.percentage}%`)}`));
	}

	// §9.2/§9.6 compact task list: a window over the top-level tasks, anchored
	// by default so the most recently completed tasks are visible; when the
	// list overflows the window, the footer advertises Ctrl+Shift+↑↓ to scroll
	// it. Subtasks of the current task stay inline via the subtask progress
	// line below.
	const topLevel = model.taskTree.filter((node) => node.depth === 0);
	const compactRows = compactTaskViewportRows(safeWidth);
	const listOverflows = topLevel.length > compactRows;
	if (topLevel.length > 0) {
		const offset = opts.scrollOffset ?? anchoredScrollOffset(topLevel, compactRows);
		const viewport = deriveTaskListViewport(topLevel.length, compactRows, offset);
		lines.push(boxSectionRule(theme, safeWidth, "Tasks"));
		for (const row of renderCompactTaskRows(theme, topLevel, viewport, inner)) {
			lines.push(boxLine(theme, safeWidth, row));
		}
	}

	// §9.4: all top-level tasks done and no current task → "All tasks complete".
	if (!model.currentTask && model.taskProgress && model.taskProgress.completed === model.taskProgress.total && model.status.code !== "complete") {
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Current")}  ${accent(theme, "All tasks complete")}`));
	}

	// Current task (persisted focus or inferred first pending).
	if (model.currentTask) {
		if (mode === "minimal") {
			lines.push(boxLine(theme, safeWidth, `${accent(theme, "▸")} ${accent(theme, fit(model.currentTask.title, inner - 3))}`));
		} else {
			const titleBudget = inner - visibleWidth(`Current  ${model.currentTask.id} · `);
			lines.push(boxLine(theme, safeWidth, `${muted(theme, "Current")}  ${accent(theme, model.currentTask.id)} · ${accent(theme, fit(model.currentTask.title, titleBudget))}`));
		}
	}

	// Current-task subtask progress (§9.3).
	if (model.currentTask && model.currentTask.totalSubtasks > 0 && mode !== "minimal") {
		const bar = progressBar(theme, model.currentTask.subtaskPercentage, spec.barWidth);
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Subtasks")} ${bar} ${accent(theme, `${model.currentTask.completedSubtasks}/${model.currentTask.totalSubtasks}`)} · ${muted(theme, `${model.currentTask.subtaskPercentage}%`)}`));
	}

	// Goal-level verification (§11.1): truncated first line in compact.
	if (model.goalVerificationContract && mode !== "minimal") {
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Verify")}   ${fit(model.goalVerificationContract.replace(/\s+/g, " "), inner - 9)}`));
	}

	// Blocked details (§4.5).
	if (model.status.code === "blocked") {
		if (model.status.reason) lines.push(boxLine(theme, safeWidth, `${theme.fg("error", "Blocker")}  ${muted(theme, fit(model.status.reason, inner - 10))}`));
		if (spec.showPauseAction && model.status.suggestedAction) lines.push(boxLine(theme, safeWidth, `${muted(theme, "Action")}   ${fit(model.status.suggestedAction, inner - 9)}`));
	}

	// Paused details (§4.4).
	if (model.status.code === "paused" && model.status.reason) {
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Reason")}   ${fit(model.status.reason, inner - 9)}`));
	}

	// File path (§4.1 example shows the active file).
	if (spec.showPath && model.filePath) {
		lines.push(boxLine(theme, safeWidth, `${dim(theme, `File     ${model.filePath}`)}`));
	}

	const footerHint = opts.footerHint
		?? (listOverflows
			? mode === "minimal"
				? "↑↓: scroll"
				: mode === "narrow"
					? "Ctrl+Shift+↑↓: scroll"
					: "Ctrl+Shift+T: expand · Ctrl+Shift+↑↓: scroll"
			: spec.footerHint);
	lines.push(boxFooter(theme, safeWidth, footerHint));
	return lines;
}

// ── EXPANDED DASHBOARD (§4.2) ───────────────────────────────────────────────

/**
 * The full dashboard: goal header, status, usage, progress, a window over the
 * task tree, current-task details with contract/evidence, verification, and
 * recent activity. Replaces the separate task overlay. The task-tree window
 * defaults to the whole tree; pass `rows` (and optionally `scrollOffset`) to
 * bound the panel for interactive scrolling — the default offset anchors to
 * the most recently completed task.
 */
export function renderExpandedDashboard(
	model: GoalDashboardModel,
	theme: Theme,
	width: number,
	opts: { scrollOffset?: number; rows?: number } = {},
): string[] {
	const safeWidth = Math.max(10, width);
	const mode = layoutMode(safeWidth);
	const spec = specFor(mode);
	const inner = safeWidth - 2;
	const lines: string[] = [];

	const usageRight = mode !== "minimal" && (model.usage.activeSeconds > 0 || model.usage.tokens > 0)
		? `${model.usage.elapsedLabel} · ${model.usage.tokenLabel}`
		: "";
	lines.push(boxHeader(theme, safeWidth, `${accent(theme, "pi-goal-x")} ${frame(theme, `─ ${model.title}`)}`, usageRight ? frame(theme, usageRight) : ""));

	const symbol = STATUS_SYMBOL[model.status.code];
	const color = STATUS_COLOR[model.status.code];
	const statusBits = [
		`Status: ${theme.fg(color, symbol)} ${theme.fg(color, model.status.label)}`,
		...((spec.showFocused ? [muted(theme, `Focused: ${model.focused ? "yes" : "no"}`)] : []) as string[]),
		...((spec.showOtherGoals && model.otherOpenGoals > 0 ? [muted(theme, `Other goals: ${model.otherOpenGoals}`)] : []) as string[]),
	];
	lines.push(boxLine(theme, safeWidth, statusBits.join(" · ")));

	if (spec.showPath && model.filePath) {
		lines.push(boxLine(theme, safeWidth, dim(theme, `File: ${model.filePath}`)));
	}
	if (model.budget) {
		lines.push(boxLine(theme, safeWidth, `${theme.fg("mdHeading", "⛽")} ${muted(theme, `Budget ${formatBudget(model.budget.used, model.budget.total)}`)}`));
	}

	// Progress section (§4.2).
	if (model.taskProgress) {
		lines.push(boxSectionRule(theme, safeWidth, "Progress"));
		const bar = progressBar(theme, model.taskProgress.percentage, Math.max(10, spec.barWidth + 8));
		lines.push(boxLine(theme, safeWidth, `${bar} ${muted(theme, `${model.taskProgress.completed}/${model.taskProgress.total} tasks · ${model.taskProgress.percentage}%`)}`));
	}

	// Tasks section: a window over the recursive tree (§9.2, §9.6). With no
	// explicit rows the whole tree is shown (backward compatible); with a row
	// budget the panel stays bounded and ↑/↓ keys move the window.
	if (model.taskTree.length > 0) {
		lines.push(boxSectionRule(theme, safeWidth, "Tasks"));
		const totalRows = model.taskTree.length;
		const rows = opts.rows ?? totalRows;
		const offset = opts.scrollOffset ?? anchoredScrollOffset(model.taskTree, rows);
		const viewport = deriveTaskListViewport(totalRows, rows, offset);
		if (viewport.hiddenAbove > 0) {
			lines.push(boxLine(theme, safeWidth, dim(theme, `↑ ${viewport.hiddenAbove} more task${viewport.hiddenAbove === 1 ? "" : "s"}`)));
		}
		for (const node of model.taskTree.slice(viewport.offset, viewport.offset + viewport.rows)) {
			const indent = Math.min(node.depth, 6);
			lines.push(boxLine(theme, safeWidth, renderTaskRow(theme, node, indent, inner)));
		}
		if (viewport.hiddenBelow > 0) {
			lines.push(boxLine(theme, safeWidth, dim(theme, `… +${viewport.hiddenBelow} more task${viewport.hiddenBelow === 1 ? "" : "s"}`)));
		}
	}

	// Current-task section (§4.2).
	if (model.currentTask) {
		lines.push(...renderCurrentTaskBlock(model, theme, safeWidth, spec.barWidth));
	}

	// Goal-level verification section (§11.1).
	if (model.goalVerificationContract) {
		lines.push(boxSectionRule(theme, safeWidth, "Verification"));
		lines.push(...wrappedBlock(theme, safeWidth, "", model.goalVerificationContract));
	}

	// Recent activity section (§12).
	if (model.recentActivity.length > 0) {
		lines.push(...renderActivityBlock(model.recentActivity, theme, safeWidth));
	}

	lines.push(boxFooter(theme, safeWidth, "Esc/Ctrl+Shift+T: collapse"));
	return lines;
}

/**
 * The current-task detail block (§4.2): title, subtask progress, contract,
 * evidence, and the inferred-focus note. Shared by the expanded dashboard and
 * the standard /goal-status output (§13.3).
 */
export function renderCurrentTaskBlock(
	model: GoalDashboardModel,
	theme: Theme,
	width: number,
	barWidth = 16,
): string[] {
	const safeWidth = Math.max(10, width);
	const inner = safeWidth - 2;
	const lines: string[] = [];
	lines.push(boxSectionRule(theme, safeWidth, "Current task"));
	lines.push(boxLine(theme, safeWidth, `${accent(theme, model.currentTask!.id)} · ${fit(model.currentTask!.title, inner - visibleWidth(`${model.currentTask!.id} · `))}`));
	if (model.currentTask!.totalSubtasks > 0) {
		const bar = progressBar(theme, model.currentTask!.subtaskPercentage, Math.max(8, barWidth));
		lines.push(boxLine(theme, safeWidth, `${muted(theme, "Subtasks")} ${bar} ${model.currentTask!.completedSubtasks}/${model.currentTask!.totalSubtasks} · ${model.currentTask!.subtaskPercentage}%`));
	}
	if (model.currentTask!.verificationContract) {
		lines.push(...wrappedBlock(theme, safeWidth, "Contract", model.currentTask!.verificationContract));
	}
	if (model.currentTask!.evidence) {
		lines.push(...wrappedBlock(theme, safeWidth, "Evidence", model.currentTask!.evidence));
	}
	if (model.currentTask!.inferred) {
		lines.push(boxLine(theme, safeWidth, dim(theme, "Inferred from the first pending task — no persisted current task.")));
	}
	return lines;
}

/** The recent-activity block (§12), shared by the expanded dashboard and /goal-status. */
export function renderActivityBlock(items: GoalActivityItem[], theme: Theme, width: number): string[] {
	const safeWidth = Math.max(10, width);
	const inner = safeWidth - 2;
	const lines: string[] = [];
	lines.push(boxSectionRule(theme, safeWidth, "Recent activity"));
	for (const item of items) {
		const marker = activityMarker(item);
		const text = fit(item.text, inner - 4);
		lines.push(boxLine(theme, safeWidth, `${theme.fg(marker.color, marker.symbol)} ${text}`));
	}
	return lines;
}

/** Wrap long contract/evidence text safely at the inner width (§11.1). */
function wrappedBlock(theme: Theme, width: number, label: string, text: string): string[] {
	const inner = Math.max(4, width - 2);
	const prefix = label ? `${label}: ` : "";
	const indent = " ".repeat(visibleWidth(prefix));
	const wrapped = wrapTextWithAnsi(text.replace(/\s+/g, " ").trim(), Math.max(8, inner - visibleWidth(prefix)));
	const lines: string[] = [];
	for (const [index, segment] of wrapped.entries()) {
		const content = index === 0 ? `${prefix}${segment}` : `${indent}${segment}`;
		lines.push(boxLine(theme, width, muted(theme, content)));
	}
	return lines;
}

// ── UNFOCUSED PANEL (§4.3) ──────────────────────────────────────────────────

/**
 * Shown when open goals exist but none is focused. The widget's default
 * no-goal branch renders nothing (surfaces without goals).
 */
export function renderUnfocusedDashboard(openGoalCount: number, theme: Theme, width: number): string[] {
	const safeWidth = Math.max(10, width);
	const lines: string[] = [];
	lines.push(boxHeader(theme, safeWidth, frame(theme, "pi-goal-x ─ Goal focus required")));
	const goals = openGoalCount === 1 ? "1 open goal is available." : `${openGoalCount} open goals are available.`;
	lines.push(boxLine(theme, safeWidth, muted(theme, goals)));
	lines.push(boxLine(theme, safeWidth, muted(theme, "Run /goal-focus to choose the goal for this session.")));
	lines.push(boxFooter(theme, safeWidth, ""));
	return lines;
}

// ── width safety net (defense in depth) ─────────────────────────────────────

/** Clamp every rendered line to the terminal width (used by the component). */
export function clampLinesToWidth(lines: string[], width: number): string[] {
	return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
}

// ── AUDIT DASHBOARD (§15) ───────────────────────────────────────────────────

import type { AuditorDashboardModel, AuditResultCard } from "./auditor-dashboard-model.ts";

const CHECK_SYMBOL = { passed: "✓", running: "◌", pending: "·", failed: "✗" } as const;
const CHECK_COLOR = { passed: "success", running: "accent", pending: "muted", failed: "error" } as const;

/**
 * Structured audit dashboard (§15.3): five check stages, a progress bar, and
 * the elapsed duration, using the same visual system as the goal dashboard.
 * Raw tools and recent output appear only when showToolDetails is set
 * (expanded/debug audit mode) or when the audit finished with a failure.
 */
export function renderAuditorDashboard(
	model: AuditorDashboardModel,
	theme: Theme,
	width: number,
	opts: { showToolDetails?: boolean } = {},
): string[] {
	const safeWidth = Math.max(10, width);
	const inner = safeWidth - 2;
	const lines: string[] = [];
	const duration = formatAuditElapsed(model.elapsedMs);
	lines.push(boxHeader(theme, safeWidth, frame(theme, `Independent completion audit ─ ${model.auditorLabel}`), frame(theme, duration)));

	for (const check of model.checks) {
		const symbol = CHECK_SYMBOL[check.state];
		const color = CHECK_COLOR[check.state];
		lines.push(boxLine(theme, safeWidth, `${theme.fg(color as RenderColor, symbol)} ${check.label}`));
	}

	if (model.percentage !== undefined) {
		const barWidth = Math.max(8, Math.min(inner - 12, 30));
		const bar = progressBar(theme, model.percentage, barWidth);
		lines.push(boxLine(theme, safeWidth, `${bar} ${theme.fg("muted", `${model.percentage}%`)}`));
	}

	const showDiagnostics = opts.showToolDetails === true || model.verdict === "disapproved" || model.verdict === "error";
	if (showDiagnostics) {
		if (model.currentTool) {
			const args = model.currentToolArgs ? ` ${dim(theme, truncateText(model.currentToolArgs, Math.max(10, inner - 20)))}` : "";
			lines.push(boxLine(theme, safeWidth, `${accent(theme, "tool")} ${model.currentTool}${args}`));
		}
		if (model.recentOutput.length > 0) {
			lines.push(boxLine(theme, safeWidth, dim(theme, "─".repeat(Math.max(4, inner - 8)))));
			for (const output of model.recentOutput.slice(0, 3)) {
				lines.push(boxLine(theme, safeWidth, dim(theme, truncateText(output, Math.max(8, inner - 4)))));
			}
		}
	}

	lines.push(boxFooter(theme, safeWidth, model.active ? "Esc: stop audit" : ""));
	return lines;
}

/** Audit result card (§15.4): APPROVED or CHANGES REQUIRED / ERROR. */
export function renderAuditResultCard(card: AuditResultCard, theme: Theme, width: number): string[] {
	const safeWidth = Math.max(10, width);
	const inner = safeWidth - 2;
	const lines: string[] = [];
	const success = card.verdict === "approved";
	const accentColor = success ? "success" : "error";
	lines.push(boxHeader(theme, safeWidth, frame(theme, `Audit result ─ ${card.label}`)));
	for (const line of card.lines) {
		const symbol = success ? "✓" : "✗";
		lines.push(boxLine(theme, safeWidth, `${theme.fg(accentColor as RenderColor, symbol)} ${fit(line, inner - 4)}`));
	}
	lines.push(boxFooter(theme, safeWidth, ""));
	return lines;
}
