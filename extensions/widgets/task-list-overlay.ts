import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { displayObjectiveTitle, statusLabel } from "../goal-core.ts";
import { openGoalsFromPool } from "../goal-pool.ts";

import type { GoalRecord, GoalTask, GoalTaskList } from "../goal-record.ts";

/**
 * Show a scrollable modal overlay displaying all open goals with their task lists.
 * Triggered by Ctrl+Shift+T. Dismisses on Escape.
 * Scroll via ↑↓, j/k, PgUp/PgDn, Home/End.
 */
export async function showTaskListOverlay(
	ctx: ExtensionContext,
	goalsById: Map<string, GoalRecord>,
): Promise<void> {
	if (!ctx.hasUI) return;

	await ctx.ui.custom<void>(
		(tui: TUI, theme: Theme, _keybindings: unknown, done: () => void): Component => {
			const accent = (s: string) => theme.fg("accent", s);
			const dim = (s: string) => theme.fg("dim", s);
			const success = (s: string) => theme.fg("success", s);
			const muted = (s: string) => theme.fg("muted", s);
			const bold = (s: string) => theme.bold(s);

			const ICONS = {
				goalActive: accent("●"),
				goalSisyphus: accent("◆"),
				goalPaused: muted("⏸"),
				done: success("✓"),
				skipped: dim("—"),
				pending: muted("◌"),
				branch: dim("├─"),
				branchLast: dim("└─"),
			} as const;

			// ── Build styled line buffer ──────────────────────────────────
			const lines: string[] = [];
			let openGoalCount = 0;
			let totalTasks = 0;

			const openGoals = openGoalsFromPool(goalsById);
			for (const [gIdx, goal] of openGoals.entries()) {
				if (goal.taskList) {
					totalTasks += countAllTasks(goal.taskList.tasks);
				}

				if (gIdx > 0) {
					lines.push(""); // blank separator between goals
				}

				// Goal header
				const icon = goal.status === "paused"
					? ICONS.goalPaused
					: goal.sisyphus ? ICONS.goalSisyphus : ICONS.goalActive;
				const title = displayObjectiveTitle(goal.objective);
				const label = statusLabel(goal);
				lines.push(`${icon}  ${bold(title)}  ${dim(label)}`);

				// Task summary & task list
				if (goal.taskList && goal.taskList.tasks.length > 0) {
					const { total, complete, skipped } = countAllWithStatus(goal.taskList.tasks);
					const summary = `${complete}/${total} done${skipped > 0 ? ` (${skipped} skipped)` : ""}`;
					lines.push(`   ${dim(summary)}`);

					const tasks = goal.taskList.tasks;
					for (let i = 0; i < tasks.length; i++) {
						const isLast = i === tasks.length - 1;
						renderTaskLines(tasks[i], 1, isLast, lines, ICONS);
					}
				} else {
					lines.push(`   ${dim("(no tasks)")}`);
				}

				openGoalCount++;
			}

			if (openGoals.length === 0) {
				lines.push(dim("No open goals."));
			}

			// ── Scroll state ──────────────────────────────────────────────
			const lineCount = lines.length;
			let scrollOffset = 0;
			let lastRenderWidth = 80; // fallback

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

					function line(content: string): string {
						const vis = visibleWidth(content);
						const fill = innerWidth - vis;
						return accent("│") + content + (fill > 0 ? " ".repeat(fill) : "") + accent("│");
					}

					const horiz = "─".repeat(innerWidth);
					const p = "  ";
					const out: string[] = [];

					out.push(accent(`┌${horiz}┐`));

					const goalWord = openGoalCount === 1 ? "goal" : "goals";
					const taskWord = totalTasks === 1 ? "task" : "tasks";
					const h = bold(` Tasks (${openGoalCount} ${goalWord}, ${totalTasks} ${taskWord})`);
					out.push(line(p + h));
					out.push(accent(`├${horiz}┤`));

					const visibleHeight = computeVisibleHeight(innerWidth);
					const maxOffset = Math.max(0, lineCount - visibleHeight);
					if (scrollOffset > maxOffset) scrollOffset = maxOffset;

					const canScrollUp = scrollOffset > 0;
					const canScrollDown = scrollOffset < maxOffset;

					if (canScrollUp) {
						out.push(line(p + dim(`▴  ${scrollOffset}/${lineCount} lines`)));
					}

					const end = Math.min(scrollOffset + visibleHeight, lineCount);
					for (let i = scrollOffset; i < end; i++) {
						const raw = lines[i];
						if (raw === "") {
							out.push(line(p + dim("·")));
							continue;
						}
						const truncated = visibleWidth(raw) > innerWidth
							? truncateToWidth(raw, innerWidth, "…")
							: raw;
						out.push(line(p + truncated));
					}

					if (canScrollDown) {
						out.push(line(p + dim(`▾  ${lineCount - end} more lines`)));
					}

					if (lineCount === 0) {
						out.push(line(p + dim("No open goals.")));
					}

					out.push(accent(`├${horiz}┤`));
					const footer = dim("↑↓ or j/k to scroll  ·  PgUp/PgDn  ·  Home/End  ·  Esc to close");
					out.push(line(p + footer));
					out.push(accent(`└${horiz}┘`));

					return out;
				},

				handleInput(data: string): void {
					const tw = Math.min(lastRenderWidth, 100);
					const innerW = Math.min(tw, 90) - 2;
					const visibleH = computeVisibleHeight(innerW);
					const maxO = Math.max(0, lineCount - visibleH);

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

// ── Task counting (inline, replaces non-exported countSubtreeTasks) ────

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

// ── Tree rendering ────────────────────────────────────────────────────

interface Icons {
	done: string;
	skipped: string;
	pending: string;
	branch: string;
	branchLast: string;
}

function renderTaskLines(
	task: GoalTask,
	depth: number,
	isLast: boolean,
	lines: string[],
	icons: Readonly<Icons>,
): void {
	const branch = isLast ? icons.branchLast : icons.branch;
	let statusIcon: string;
	switch (task.status) {
		case "complete": statusIcon = icons.done; break;
		case "skipped": statusIcon = icons.skipped; break;
		default: statusIcon = icons.pending;
	}

	const indent = "   " + "  ".repeat(depth - 1);
	lines.push(`${indent} ${branch} ${statusIcon} ${task.title}`);

	if (task.subtasks && task.subtasks.length > 0) {
		for (let i = 0; i < task.subtasks.length; i++) {
			const subLast = i === task.subtasks.length - 1;
			renderTaskLines(task.subtasks[i], depth + 1, subLast, lines, icons);
		}
	}
}
