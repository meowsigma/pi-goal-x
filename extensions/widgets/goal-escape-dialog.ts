import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

/**
 * Result of the Escape dialog during audit.
 */
export type EscapeDialogResult = "complete_without_audit" | "continue_working";

/**
 * Show a TUI confirmation dialog when the user presses Escape during a completion audit.
 *
 * Presents two choices:
 *   - Mark complete without audit (skips auditor, marks goal complete immediately)
 *   - Continue working (returns to agent, goal stays active)
 *
 * Returns the user's choice. Escape or Enter on a focused option submits the selection.
 */
export async function showEscapeDialog(
	ctx: ExtensionContext,
	goalObjective: string,
): Promise<EscapeDialogResult> {
	if (!ctx.hasUI) {
		// Fallback for headless/RPC mode — return "continue" as the safe default
		return "continue_working";
	}

	return await ctx.ui.custom<EscapeDialogResult>(
		(tui: TUI, theme: Theme, _keybindings: unknown, done: (result: EscapeDialogResult) => void): Component => {
			const wasHardwareCursorShown = tui.getShowHardwareCursor();
			tui.setShowHardwareCursor(false);

			let selectedIndex = 1; // Default: "Continue working" (index 1)
			let cancelled = false;

			const OPTIONS: Array<{ label: string; value: EscapeDialogResult; description: string }> = [
				{
					label: "Mark complete without audit",
					value: "complete_without_audit",
					description: "Bypass the auditor and mark the goal complete now.",
				},
				{
					label: "Continue working",
					value: "continue_working",
					description: "Resume work on the goal. The audit will not run this turn.",
				},
			];

			const accent = (s: string) => theme.fg("accent", s);
			const dim = (s: string) => theme.fg("dim", s);
			const warning = (s: string) => theme.fg("warning", s);

			// ── Component ────────────────────────────────────────────────────
			const component: Component & { dispose?(): void } = {
				dispose() {
					tui.setShowHardwareCursor(wasHardwareCursorShown);
				},

				invalidate(): void {
					// No cached state to invalidate
				},

				render(width: number): string[] {
					const termWidth = Math.min(width, 80);
					const innerWidth = Math.min(termWidth, 64) - 2; // inner content width between ││

					/** Build a bordered line: fits exactly `innerWidth` visible chars between ││ */
					function line(leftContent: string): string {
						const vis = visibleWidth(leftContent);
						const fill = innerWidth - vis;
						return accent("│") + leftContent + (fill > 0 ? " ".repeat(fill) : "") + accent("│");
					}

					const horizLine = "─".repeat(innerWidth);
					const lines: string[] = [];
					const p = "  "; // left padding inside the border

					// ── Header ────────────────────────────────────────────────
					lines.push(accent(`┌${horizLine}┐`));
					lines.push(line(p + theme.bold("Audit interrupted by Escape") + dim("  (continue = default)")));
					const truncatedObjective = truncateToWidth(goalObjective, innerWidth - 14, "…");
					lines.push(line(p + dim("Goal: ") + dim(truncatedObjective)));
					lines.push(accent(`├${horizLine}┤`));

					// ── Options ─────────────────────────────────────────────
					OPTIONS.forEach((opt, i) => {
						const isSelected = i === selectedIndex && !cancelled;
						const marker = isSelected ? "▸ " : "  ";
						const label = isSelected ? warning(opt.label) : opt.label;
						const truncLabel = truncateToWidth(label, innerWidth - 6, "…");
						lines.push(line(p + marker + truncLabel));
						if (isSelected && opt.description) {
							const desc = dim(opt.description);
							const truncDesc = truncateToWidth(desc, innerWidth - 10, "…");
							lines.push(line(p + " ".repeat(4) + truncDesc));
						}
					});

					// ── Footer ───────────────────────────────────────────────
					lines.push(accent(`├${horizLine}┤`));
					const footerText = dim("Enter to select  ·  ↑↓ to navigate  ·  Esc = continue working");
						const truncFooter = truncateToWidth(footerText, innerWidth - 2, "…");
					lines.push(line(p + truncFooter));
					lines.push(accent(`└${horizLine}┘`));

					return lines;
				},

				handleInput(data: string): void {
					if (matchesKey(data, "up")) {
						selectedIndex = (selectedIndex - 1 + OPTIONS.length) % OPTIONS.length;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "down")) {
						selectedIndex = (selectedIndex + 1) % OPTIONS.length;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "enter")) {
						cancelled = false;
						done(OPTIONS[selectedIndex].value);
						return;
					}
					if (matchesKey(data, "escape")) {
						cancelled = true;
						done("continue_working");
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
				width: "70%",
				minWidth: 50,
				maxHeight: "50%",
			},
		},
	);
}
