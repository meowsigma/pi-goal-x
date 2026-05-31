import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { displayObjectiveTitle, statusLabel } from "../goal-core.ts";
import { openGoalsFromPool } from "../goal-pool.ts";
import type { GoalRecord, GoalTask } from "../goal-record.ts";

// ── Structured line entries ──────────────────────────────────────────

type LineEntry =
	| { type: "separator" }
	| { type: "goal-header"; icon: string; title: string; status: string }
	| { type: "task-summary"; text: string }
	| { type: "task"; prefix: string; title: string }
	| { type: "empty-message"; text: string };

// ── Public API ───────────────────────────────────────────────────────

/**
 * Show a scrollable modal overlay displaying the current goal's task list.
 * Press 'a' to toggle between the current goal and all open goals.
 * Triggered by Ctrl+Shift+T. Dismisses on Escape.
 */
export async function showTaskListOverlay(
	ctx: ExtensionContext,
	goalsById: Map<string, GoalRecord>,
	focusedGoalId: string | null,
): Promise<void> {
	if (!ctx.hasUI) return;

	await ctx.ui.custom<void>(
		(tui: TUI, theme: Theme, _keybindings: unknown, done: () => void): Component => {
			// ── Theme helpers ─────────────────────────────────────────────
			const accent = (s: string) => theme.fg("accent", s);
			const dim = (s: string) => theme.fg("dim", s);
			const success = (s: string) => theme.fg("success", s);
			const muted = (s: string) => theme.fg("muted", s);
			const bold = (s: string) => theme.bold(s);

			// ── State ─────────────────────────────────────────────────────
			let showAllGoals = false;
			let entries: LineEntry[] = [];
			let totalOpenGoals = 0;
			let totalTaskCount = 0;

			function rebuildEntries(): void {
				entries = [];
				totalOpenGoals = 0;
				totalTaskCount = 0;

				const openGoals = openGoalsFromPool(goalsById);
				const targetGoals = showAllGoals
					? openGoals
					: openGoals.filter((g) => g.id === focusedGoalId);

				if (targetGoals.length === 0) {
					entries.push({ type: "empty-message", text: "No open goals to display." });
					return;
				}

				for (const [gIdx, goal] of targetGoals.entries()) {
					if (goal.taskList) {
						totalTaskCount += countAllTasks(goal.taskList.tasks);
					}

					if (gIdx > 0) {
						entries.push({ type: "separator" });
					}

					// Goal header
					const icon = goal.status === "paused" ? "⏸"
						: goal.sisyphus ? "◆" : "●";
					const title = displayObjectiveTitle(goal.objective);
					const label = statusLabel(goal);
					entries.push({ type: "goal-header", icon, title, status: label });

					// Task summary & task list
					if (goal.taskList && goal.taskList.tasks.length > 0) {
						const { total, complete, skipped } = countAllWithStatus(goal.taskList.tasks);
						const summary = `${complete}/${total} done${skipped > 0 ? ` (${skipped} skipped)` : ""}`;
						entries.push({ type: "task-summary", text: summary });

						const tasks = goal.taskList.tasks;
						for (let i = 0; i < tasks.length; i++) {
							const isLast = i === tasks.length - 1;
							collectTaskEntries(tasks[i], 1, isLast, entries);
						}
					} else {
						entries.push({ type: "empty-message", text: "(no tasks)" });
					}

					totalOpenGoals++;
				}
			}

			// Build initial entries
			rebuildEntries();

			// ── Render helpers ────────────────────────────────────────────

			/** Render a single line entry into styled wrapped lines */
			function renderEntry(entry: LineEntry, innerWidth: number): string[] {
				switch (entry.type) {
					case "separator":
						return [dim("·")];

					case "goal-header": {
						const icon = entry.icon === "⏸" ? muted("⏸") : entry.icon === "◆" ? accent("◆") : accent("●");
						const status = dim(entry.status);
						const prefix = `${icon}  ${bold("")}`; // placeholder, we'll build below
						const rawPrefix = `${entry.icon}  `; // raw width: icon + 2 spaces
						const prefixWidth = visibleWidth(rawPrefix);
						const available = innerWidth - prefixWidth;
						const wrappedTitle = wrapTextWithAnsi(bold(entry.title), Math.max(1, available));
						const lines: string[] = [];
						wrappedTitle.forEach((segment, i) => {
							if (i === 0) {
								lines.push(`${icon}  ${segment}  ${status}`);
							} else {
								lines.push(`   ${" ".repeat(rawPrefix.length - 3)}${segment}`);
							}
						});
						// If title alone fits, status needs to be on same line
						// But we already handle it above for i=0. The status might overflow.
						// If status doesn't fit on first line after title, put it on its own line
						const firstLine = lines[0];
						const allOnFirst = `${icon}  ${entry.title}  ${entry.status}`;
						if (visibleWidth(firstLine) > innerWidth) {
							// Status overflowed — put status on a separate dim line
							lines[0] = `${icon}  ${wrappedTitle[0]}`;
							if (wrappedTitle.length === 1) {
								lines.push(`   ${dim(entry.status)}`);
							} else {
								// insert status after last wrapped title segment
								const lastLine = wrappedTitle[wrappedTitle.length - 1];
								lines[lines.length - 1] = `   ${" ".repeat(rawPrefix.length - 3)}${lastLine}`;
								lines.push(`   ${dim(entry.status)}`);
							}
						}
						// Re-truncate any over-long lines just in case
						return lines.map((l) => visibleWidth(l) > innerWidth ? truncateToWidth(l, innerWidth, "…") : l);
					}

					case "task-summary": {
						const content = dim(entry.text);
						return [visibleWidth(content) > innerWidth ? truncateToWidth(content, innerWidth, "…") : content];
					}

					case "task": {
						const prefixWidth = visibleWidth(entry.prefix);
						const available = innerWidth - prefixWidth;
						const wrappedTitle = wrapTextWithAnsi(entry.title, Math.max(1, available));
						const lines: string[] = [];
						wrappedTitle.forEach((segment, i) => {
							if (i === 0) {
								lines.push(`${dim(entry.prefix)} ${segment}`);
							} else {
								lines.push(`${" ".repeat(prefixWidth + 1)}${segment}`);
							}
						});
						return lines.map((l) => visibleWidth(l) > innerWidth ? truncateToWidth(l, innerWidth, "…") : l);
					}

					case "empty-message": {
						const content = dim(entry.text);
						return [visibleWidth(content) > innerWidth ? truncateToWidth(content, innerWidth, "…") : content];
					}

					default:
						return [];
				}
			}

			// ── Scroll state ──────────────────────────────────────────────
			let scrollOffset = 0;
			let lastRenderWidth = 80;

			// The "logical line count" is the number of entries (before wrapping).
			// We store rendered line count too since wrapped entries expand.
			let renderedLineCount = 0;

			function computeVisibleHeight(innerWidth: number): number {
				return Math.max(8, Math.floor(innerWidth / 2.8));
			}

			const wasHardwareCursorShown = tui.getShowHardwareCursor();
			tui.setShowHardwareCursor(false);

			// ── Component ─────────────────────────────────────────────────
			const component: Component & { dispose?(): void } = {
				dispose() {
					tui.setShowHardwareCursor(wasHardwareCursorShown);
				},

				invalidate(): void {},

				render(width: number): string[] {
					lastRenderWidth = width;

					const termWidth = Math.min(width, 100);
					const innerWidth = Math.min(termWidth, 90) - 2;
					const p = "  ";

					function line(content: string): string {
						const vis = visibleWidth(content);
						const fill = innerWidth - vis;
						return accent("│") + content + (fill > 0 ? " ".repeat(fill) : "") + accent("│");
					}

					// ── Render all entries into flat text lines ────────────
					const renderedLines: string[] = [];
					for (const entry of entries) {
						const wrapped = renderEntry(entry, innerWidth);
						renderedLines.push(...wrapped);
					}
					renderedLineCount = renderedLines.length;

					const horiz = "─".repeat(innerWidth);
					const out: string[] = [];

					out.push(accent(`┌${horiz}┐`));

					// Header
					const viewLabel = showAllGoals
						? `${totalOpenGoals} ${totalOpenGoals === 1 ? "goal" : "goals"}`
						: "current goal";
					const taskWord = totalTaskCount === 1 ? "task" : "tasks";
					const h = bold(` Tasks (${viewLabel}, ${totalTaskCount} ${taskWord})`);
					out.push(line(p + h));
					out.push(accent(`├${horiz}┤`));

					// Content with scrolling
					const visibleHeight = computeVisibleHeight(innerWidth);
					const maxOffset = Math.max(0, renderedLineCount - visibleHeight);
					if (scrollOffset > maxOffset) scrollOffset = maxOffset;

					const canScrollUp = scrollOffset > 0;
					const canScrollDown = scrollOffset < maxOffset;

					if (canScrollUp) {
						out.push(line(p + dim(`▴  ${scrollOffset}/${renderedLineCount} lines`)));
					}

					const end = Math.min(scrollOffset + visibleHeight, renderedLineCount);
					for (let i = scrollOffset; i < end; i++) {
						const raw = renderedLines[i];
						// Each rendered line from renderEntry already wraps/truncates,
						// but double-check for safety
						const safe = visibleWidth(raw) > innerWidth
							? truncateToWidth(raw, innerWidth, "…")
							: raw;
						out.push(line(p + safe));
					}

					if (canScrollDown) {
						out.push(line(p + dim(`▾  ${renderedLineCount - end} more lines`)));
					}

					if (renderedLineCount === 0) {
						out.push(line(p + dim("No tasks to display.")));
					}

					out.push(accent(`├${horiz}┤`));
					const toggleHint = showAllGoals ? "show current" : "show all";
					const footer = dim(`↑↓/jk scroll  ·  'a' to ${toggleHint}  ·  Esc close`);
					out.push(line(p + footer));
					out.push(accent(`└${horiz}┘`));

					return out;
				},

				handleInput(data: string): void {
					const tw = Math.min(lastRenderWidth, 100);
					const innerW = Math.min(tw, 90) - 2;
					const visibleH = computeVisibleHeight(innerW);
					const maxO = Math.max(0, renderedLineCount - visibleH);

					if (matchesKey(data, "up") || matchesKey(data, "k")) {
						scrollOffset = Math.max(0, scrollOffset - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "down") || matchesKey(data, "j")) {
						scrollOffset = Math.min(maxO, scrollOffset + 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "pageUp")) {
						scrollOffset = Math.max(0, scrollOffset - visibleH);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "pageDown")) {
						scrollOffset = Math.min(maxO, scrollOffset + visibleH);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "home")) {
						scrollOffset = 0;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "end")) {
						scrollOffset = maxO;
						tui.requestRender();
						return;
					}
					// Toggle view
					if (matchesKey(data, "a")) {
						showAllGoals = !showAllGoals;
						rebuildEntries();
						scrollOffset = 0;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
						done();
						return;
					}
				},
			};

			return component;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "80%",
				minWidth: 60,
				maxHeight: "80%",
			},
		},
	);
}

// ── Task counting ─────────────────────────────────────────────────────

function countAllTasks(tasks: GoalTask[]): number {
	let n = 0;
	for (const t of tasks) {
		n += 1 + countAllTasks(t.subtasks ?? []);
	}
	return n;
}

function countAllWithStatus(tasks: GoalTask[]): { total: number; complete: number; skipped: number; pending: number } {
	let total = 0;
	let complete = 0;
	let skipped = 0;
	for (const t of tasks) {
		total++;
		if (t.status === "complete") complete++;
		else if (t.status === "skipped") skipped++;
		if (t.subtasks) {
			const child = countAllWithStatus(t.subtasks);
			total += child.total;
			complete += child.complete;
			skipped += child.skipped;
		}
	}
	return { total, complete, skipped, pending: total - complete - skipped };
}

// ── Tree entry collection ─────────────────────────────────────────────

const STATUS_ICONS = { complete: "✓", skipped: "—", pending: "◌" } as const;
const BRANCH = "├─";
const BRANCH_LAST = "└─";

function collectTaskEntries(
	task: GoalTask,
	depth: number,
	isLast: boolean,
	entries: LineEntry[],
): void {
	const branch = isLast ? BRANCH_LAST : BRANCH;
	const statusIcon = STATUS_ICONS[task.status] ?? STATUS_ICONS.pending;

	const indent = "   " + "  ".repeat(depth - 1);
	const prefix = `${indent} ${branch} ${statusIcon}`;
	entries.push({ type: "task", prefix, title: task.title });

	if (task.subtasks && task.subtasks.length > 0) {
		for (let i = 0; i < task.subtasks.length; i++) {
			collectTaskEntries(task.subtasks[i], depth + 1, i === task.subtasks.length - 1, entries);
		}
	}
}
