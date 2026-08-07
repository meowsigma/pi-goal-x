import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";


export type GoalDraftingFocus = "goal" | "sisyphus";

export interface GoalQuestionnaireQuestion {
	id: string;
	question: string;
	context?: string;
	options: string[];
	recommended?: number;
	allowCustom?: boolean;
}

export interface GoalQuestionnaireAnswer {
	id: string;
	question: string;
	answer: string;
	wasCustom: boolean;
}

export interface GoalQuestionnaireResult {
	questions: GoalQuestionnaireQuestion[];
	answers: GoalQuestionnaireAnswer[];
	cancelled: boolean;
	auditorEnabled?: boolean;
}

export type ProposalDecision = "confirm" | "continue" | "cancel";

/**
 * Bound a custom dialog using the regular renderer's frame cache when
 * available. The pi 0.84 fullscreen renderer does not expose that cache, so
 * reserve four rows for host chrome and use the remaining terminal height.
 */
export function computeDialogLineLimit(args: { terminalRows?: number; baseFrameLines?: number }): number | undefined {
	const rows = args.terminalRows;
	if (!rows || rows <= 0) return undefined;
	if (args.baseFrameLines && args.baseFrameLines > 0) {
		return Math.min(rows, Math.max(10, rows - args.baseFrameLines + 1));
	}
	return Math.min(rows, Math.max(4, rows - 4));
}

/**
 * Proposal-confirmation segment descriptor: absolute line indices of the
 * tasks section (header + every task line) and the start of the options tail
 * inside a rendered questionnaire dialog.
 */
export interface ProposalPresentationSegments {
	tasksStart: number;
	tasksEnd: number;
	tailStart: number;
}

/**
 * Locate the proposal tasks segment and the options tail in a rendered dialog.
 * Returns null when the dialog is not a proposal-style confirmation (no
 * "Tasks proposed for confirmation:" header / "┌─ TASKS ─" box).
 */
export function findProposalPresentationSegments(lines: string[], tailStart: number): ProposalPresentationSegments | null {
	if (tailStart < 0) return null;
	const tasksStart = lines.findIndex((l) => l.includes("Tasks proposed for confirmation:") || l.includes("┌─ TASKS ─"));
	if (tasksStart < 0 || tasksStart >= tailStart) return null;
	let tasksEnd = tasksStart;
	for (let i = tasksStart + 1; i < tailStart; i++) {
		if (/^\s*\[[ x~]\]/.test(lines[i])) tasksEnd = i;
		else break;
	}
	return { tasksStart, tasksEnd, tailStart };
}

/**
 * Fit a rendered dialog to the terminal-height bound without ever hiding the
 * question. The protected head (top border + tabs + question line) is always
 * kept; the remaining budget is spent on the tail — options/footer/bottom
 * border — so long context blocks (proposal confirmations) are sliced from
 * their head exactly as the pre-fix tail-slice did (383ae52 surface). When the
 * options block starts immediately after the head (plain agent questions with
 * no context block), the TOP options are kept instead of the tail so the
 * recommended/first option stays visible; the footer hint and bottom border
 * are always the last rendered lines. Never returns more than maxDialogLines.
 *
 * Proposal confirmations (proposal segments given) keep the head, the tasks
 * section (header + every task line), and the options/footer/bottom border in
 * frame; only the objective-box middle is sacrificed in-frame — the full
 * objective is always present in the scrollable transcript presentation
 * (propose_goal_draft renderCall), so nothing of the goal is ever omitted.
 */
export function fitDialogLines(
	lines: string[],
	maxDialogLines: number,
	protectedHead: number,
	optionsImmediatelyAfterHead = false,
	proposal: ProposalPresentationSegments | null = null,
): string[] {
	if (maxDialogLines <= 0 || lines.length <= maxDialogLines) return lines;
	const keepHead = Math.min(protectedHead, maxDialogLines);
	const budget = maxDialogLines - keepHead;
	if (budget <= 0) return lines.slice(0, keepHead);
	const rest = lines.slice(protectedHead);
	if (rest.length <= budget) return [...lines.slice(0, keepHead), ...rest];
	if (proposal) {
		return fitProposalPresentation(lines, maxDialogLines, keepHead, proposal);
	}
	if (optionsImmediatelyAfterHead) {
		// Plain select-mode question: keep the footer hint + bottom border (as
		// many as fit), then spend the remaining room on the TOP options so the
		// recommended/first option stays visible; leading blank separators are
		// dropped first when room is short. Never exceeds maxDialogLines.
		const headLines = lines.slice(0, keepHead);
		const firstContent = rest.findIndex((l) => l.trim().length > 0);
		const lead = firstContent > 0 ? rest.slice(0, firstContent) : [];
		const contentStart = firstContent > 0 ? firstContent : 0;
		const tailBudget = Math.min(2, budget); // footer hint + bottom border
		const tail = rest.slice(-tailBudget);
		const room = budget - tailBudget;
		const keepContent = Math.max(0, Math.min(rest.length - contentStart, room));
		const keepLead = Math.max(0, Math.min(lead.length, room - keepContent));
		const content = rest.slice(contentStart, contentStart + keepContent);
		return [...headLines, ...lead.slice(0, keepLead), ...content, ...tail];
	}
	// Context-heavy / input / submit dialogs: keep the head and the tail
	// (options, footer, bottom border) exactly as the pre-fix tail-slice did.
	return [...lines.slice(0, keepHead), ...rest.slice(rest.length - budget)];
}

/**
 * Proposal confirmation fit: keep the protected head, the tasks section, and
 * the options/footer/bottom border; the objective-box middle is sacrificed
 * in-frame (it stays fully readable in the scrollback presentation). Interior
 * blank spacing lines are dropped first when room is short; task lines are
 * only dropped after that, from the end, when the bound is exhausted (those
 * lines remain in the scrollback presentation). Never exceeds maxDialogLines.
 */
function fitProposalPresentation(
	lines: string[],
	maxDialogLines: number,
	keepHead: number,
	proposal: ProposalPresentationSegments,
): string[] {
	const { tasksStart, tasksEnd, tailStart } = proposal;
	const head = lines.slice(0, keepHead);
	const tasks = lines.slice(Math.max(tasksStart, keepHead), Math.min(tasksEnd, tailStart) + 1);
	const tail = lines.slice(Math.max(tailStart, keepHead));
	const candidate = [...head, ...tasks, ...tail];
	if (candidate.length <= maxDialogLines) return candidate;
	// Tight: drop blank spacing lines below the head (e.g. the blank between
	// the options and the footer hint) before touching any content line.
	const stripped = candidate.filter((l, i) => i < keepHead || l.trim() !== "");
	if (stripped.length <= maxDialogLines) return stripped;
	// Bound still exhausted: keep the head, then spend the room on the tail
	// first (options/footer/bottom border — the actionable decision surface —
	// kept from its end so the border and footer never drop), then on the
	// tasks from the start. The dropped task lines remain fully readable in
	// the scrollback presentation. Never exceeds maxDialogLines.
	const tailNoBlanks = tail.filter((l) => l.trim() !== "");
	const keepTail = Math.min(tailNoBlanks.length, Math.max(0, maxDialogLines - keepHead));
	const tailKept = tailNoBlanks.slice(tailNoBlanks.length - keepTail);
	const keepTasks = Math.min(tasks.length, Math.max(0, maxDialogLines - keepHead - keepTail));
	return [...head, ...tasks.slice(0, keepTasks), ...tailKept];
}

export function normalizeQuestionnaireQuestions(rawQuestions: GoalQuestionnaireQuestion[]): GoalQuestionnaireQuestion[] {
	const seenIds = new Set<string>();
	return rawQuestions.map((q, i) => {
		let id = q.id.trim() || `q${i + 1}`;
		if (seenIds.has(id)) id = `${id}-${i + 1}`;
		seenIds.add(id);
		const options = q.options.filter((option) => option.trim().length > 0);
		const recommended = q.recommended !== undefined && q.recommended >= 0 && q.recommended < options.length
			? q.recommended
			: undefined;
		return { ...q, id, options, recommended, allowCustom: q.allowCustom ?? true };
	});
}

export function formatQuestionnaireAnswers(result: GoalQuestionnaireResult): string {
	return result.answers.map((answer) => {
		const question = result.questions.find((q) => q.id === answer.id);
		const lines = [`**Q:** ${answer.question}`];
		if (question?.context) lines.push(`\n${question.context}`);
		if (question && question.options.length > 0) lines.push(`\nOptions: ${question.options.join(" / ")}`);
		lines.push(`\n**A:** ${answer.answer}`);
		return lines.join("");
	}).join("\n\n---\n\n");
}

export function shouldAutoConfirmProposal(args: { hasUI: boolean; autoConfirmEnv?: string }): boolean {
	if (args.autoConfirmEnv === "0") return false; // explicit opt-out (benchmarking)
	return !args.hasUI || args.autoConfirmEnv === "1";
}

export function proposalDecisionFromQuestionnaireResult(args: { cancelled: boolean; answer?: string }): ProposalDecision {
	if (args.cancelled) return "continue"; // never trapped; escape keeps refining
	if ((args.answer ?? "").startsWith("Confirm")) return "confirm";
	if ((args.answer ?? "").startsWith("Cancel")) return "cancel";
	return "continue";
}

export function isHeadlessQuestionSufficientForDraft(args: { topic: string; questionText: string }): boolean {
	const topic = args.topic.toLowerCase();
	void args;
	const vagueTopic = topic.trim().length < 20 || /(整理笔记|organize notes|notes|笔记)$/.test(topic.trim());
	return !vagueTopic;
}

export function proposalDialogFailureMessage(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `Goal draft confirmation failed: ${detail}. The goal was NOT created; drafting remains active.`;
}

/**
 * Shared question UI used by both the agent-callable goal_questionnaire tool and
 * the internal draft-confirm prompt. This keeps pi-goal self-contained and
 * avoids depending on external question/questionnaire packages.
 */
export async function runGoalQuestionnaire(ctx: ExtensionContext, rawQuestions: GoalQuestionnaireQuestion[], auditorToggleInit?: { defaultEnabled: boolean }): Promise<GoalQuestionnaireResult> {
	if (!ctx.hasUI) {
		return { questions: [], answers: [], cancelled: true };
	}

	const questions = normalizeQuestionnaireQuestions(rawQuestions);
	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1;

	return await ctx.ui.custom<GoalQuestionnaireResult>((tui, theme, _kb, done) => {
		// Suppress hardware cursor during dialog to reduce TUI auto-scroll
		// (the TUI render loop runs at ~60fps and writes ANSI cursor positioning
		// sequences every cycle, which can cause terminal viewport snapping).
		const wasHardwareCursorShown = tui.getShowHardwareCursor();
		tui.setShowHardwareCursor(false);
		// Pause pi's working spinner for the dialog duration: its ~80ms
		// re-renders write output while the user is scrolled up reading the
		// proposal, which snaps the terminal viewport back to the bottom
		// ("terminal scrolls back down after X seconds"). Restored on close.
		ctx.ui.setWorkingVisible(false);
		// Terminal-height bound: the dialog renders in the editor slot, so the opened
		// frame height is (pre-dialog frame - 1) + dialog lines. Bound the dialog so
		// the frame never exceeds the terminal height — without this, closing a dialog
		// taller than the terminal triggers pi-tui's generic shrink full-render
		// (\x1b[2J\x1b[H\x1b[3J), erasing terminal scrollback and yanking the viewport
		// so the window takes ~10s to scroll back to the bottom. The slice keeps
		// the question and the actionable options/footer in view (see
		// fitDialogLines); content that fits renders exactly as the
		// pre-regression (383ae52) UI. Only applies with real TUI dimensions.
		const tuiInfo = tui as unknown as { terminal?: { rows?: number }; previousLines?: string[] };
		const terminalRows = tuiInfo.terminal?.rows;
		const baseFrame = tuiInfo.previousLines?.length;
		const maxDialogLines = computeDialogLineLimit({ terminalRows, baseFrameLines: baseFrame });
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let cachedLines: string[] | undefined;
		let optionsStartIndex = -1;
		let auditorEnabled = auditorToggleInit?.defaultEnabled ?? true;
		const answers = new Map<string, GoalQuestionnaireAnswer>();
		const drafts = new Map<string, string>();

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean) {
			// Restore hardware cursor now that the dialog is closing
			tui.setShowHardwareCursor(wasHardwareCursorShown);
			// Resume pi's working spinner (the agent run is still active until agent_end).
			ctx.ui.setWorkingVisible(true);
			const ordered = questions.map((q) => answers.get(q.id)).filter((a): a is GoalQuestionnaireAnswer => !!a);
			done({ questions, answers: ordered, cancelled, auditorEnabled: auditorToggleInit ? auditorEnabled : undefined });
		}

		function currentQuestion(): GoalQuestionnaireQuestion | undefined {
			return questions[currentTab];
		}

		function displayOptions(): Array<{ label: string; isCustom?: boolean }> {
			const q = currentQuestion();
			if (!q) return [];
			const opts: Array<{ label: string; isCustom?: boolean }> = q.options.map((label) => ({ label }));
			if (q.allowCustom !== false) opts.push({ label: "Write your own answer...", isCustom: true });
			return opts;
		}

		function allAnswered(): boolean {
			return questions.every((q) => answers.has(q.id));
		}

		function enterQuestion(q: GoalQuestionnaireQuestion) {
			const existing = answers.get(q.id);
			const draft = drafts.get(q.id);
			if (q.options.length === 0) {
				inputMode = true;
				inputQuestionId = q.id;
				editor.setText(draft ?? (existing?.wasCustom ? existing.answer : ""));
			} else if (existing?.wasCustom) {
				optionIndex = q.options.length;
			} else if (existing && !existing.wasCustom) {
				const idx = q.options.indexOf(existing.answer);
				optionIndex = idx >= 0 ? idx : 0;
			} else {
				optionIndex = q.recommended ?? 0;
			}
		}

		function advanceAfterAnswer() {
			if (!isMulti) {
				submit(false);
				return;
			}
			if (currentTab < questions.length - 1) currentTab++;
			else currentTab = questions.length;
			const nextQ = currentQuestion();
			if (nextQ) enterQuestion(nextQ);
			else optionIndex = 0;
			refresh();
		}

		function saveAnswer(qId: string, value: string, wasCustom: boolean) {
			const q = questions.find((qq) => qq.id === qId);
			answers.set(qId, { id: qId, question: q?.question ?? qId, answer: value, wasCustom });
		}

		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const trimmed = value.trim();
			if (!trimmed) {
				refresh();
				return;
			}
			drafts.delete(inputQuestionId);
			saveAnswer(inputQuestionId, trimmed, true);
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
			advanceAfterAnswer();
		};

		function exitEditor() {
			if (inputQuestionId) {
				const text = editor.getText();
				if (text.trim()) drafts.set(inputQuestionId, text);
				else drafts.delete(inputQuestionId);
			}
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
		}

		enterQuestion(questions[0]);

		function handleInput(data: string) {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					const q = currentQuestion();
					if (q && q.options.length === 0 && !isMulti) submit(true);
					else {
						exitEditor();
						refresh();
					}
					return;
				}
				if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
					exitEditor();
					currentTab = matchesKey(data, Key.tab) ? (currentTab + 1) % totalTabs : (currentTab - 1 + totalTabs) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else optionIndex = 0;
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const q = currentQuestion();
			const opts = displayOptions();

			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					currentTab = (currentTab + 1) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else optionIndex = 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					currentTab = (currentTab - 1 + totalTabs) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else optionIndex = 0;
					refresh();
					return;
				}
			}

			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
				else if (matchesKey(data, Key.escape)) submit(true);
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			// Auditor toggle hotkey
			if (matchesKey(data, "a") && auditorToggleInit) {
				auditorEnabled = !auditorEnabled;
				refresh();
				return;
			}

			if (matchesKey(data, Key.enter) && q) {
				if (q.options.length === 0 || opts[optionIndex]?.isCustom) {
					inputMode = true;
					inputQuestionId = q.id;
					const draft = drafts.get(q.id);
					const existing = answers.get(q.id);
					editor.setText(draft ?? (existing?.wasCustom ? existing.answer : ""));
					refresh();
					return;
				}
				const opt = opts[optionIndex];
				if (opt) {
					saveAnswer(q.id, opt.label, false);
					advanceAfterAnswer();
				}
				return;
			}

			if (matchesKey(data, Key.escape)) submit(true);
		}

			function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const safeWidth = Math.max(20, width);
			let lines: string[] = [];
			const q = currentQuestion();
			const opts = displayOptions();
			const add = (s: string) => lines.push(truncateToWidth(s, safeWidth, "…", true));
			const addWrapped = (s: string) => lines.push(...wrapTextWithAnsi(s, safeWidth));
			/**
			 * Wraps a pipe-prefixed line and prepends "│   " to continuation lines
			 * so wrapped content stays within the ASCII box.
			 */
			const PIPE_PREFIX = "│   ";
			const PIPE_WIDTH = visibleWidth(PIPE_PREFIX);
			const addWrappedPipe = (styledLine: string) => {
				const wrapWidth = Math.max(1, safeWidth - PIPE_WIDTH);
				const wrapped = wrapTextWithAnsi(styledLine, wrapWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(i === 0 ? wrapped[i] : PIPE_PREFIX + wrapped[i]);
				}
			};

			/** Render context lines with per-line styling. No truncation. */
			const renderContextLines = (context: string): void => {
				const rawLines = context.split("\n");
				for (const rawLine of rawLines) {
					const trimmed = rawLine.trim();
					// Empty line — preserve as spacing
					if (!trimmed) {
						lines.push("");
						continue;
					}

					// 1. Announcement header — "● Goal draft/tweak ready for confirmation."
					if (/^● Goal (draft|tweak) ready for confirmation\.$/.test(trimmed)) {
						addWrapped(theme.fg("accent", rawLine));
						continue;
					}

					// 2. Section marker — "─── Name ───" → full-width box-drawing header
					const sectionMatch = trimmed.match(/^───\s+(.+?)\s+───$/);
					if (sectionMatch) {
						const sectionName = sectionMatch[1];
						const namePart = ` ${sectionName} `;
						const left = "┌─";
						const right = "─┐";
						const fill = Math.max(0, safeWidth - 2 - visibleWidth(left + namePart + right));
						add(theme.fg("accent", left + namePart + "─".repeat(fill) + right));
						continue;
					}

					// 3. Lines with │ prefix come from buildDraftConfirmationText / buildTweakConfirmationText.
					if (trimmed.startsWith("│")) {
						const afterPipe = trimmed.slice(1).trim();
						// 3a. Task checkbox under │ prefix — detect before key-value to avoid
						// "[x] t1: ..." being misinterpreted as a key-value pair.
						const pipeTaskMatch = afterPipe.match(/^(\[.\])(\s+)(.+)$/);
						if (pipeTaskMatch) {
							const bracket = pipeTaskMatch[1];
							const sep = pipeTaskMatch[2];
							const rest = pipeTaskMatch[3];
							// Preserve inner whitespace between │ and the task marker (e.g. "   " in "│   [x]...")
							const pipeContent = trimmed.slice(1);
							const innerWs = pipeContent.slice(0, pipeContent.length - pipeContent.trimStart().length);
							const linePrefix = "│" + innerWs;
							const color = bracket === "[x]" ? "success" : "warning";
							addWrappedPipe(linePrefix + theme.fg(color, bracket) + sep + theme.fg("muted", rest));
							continue;
						}
						// 3b. Key-value content (e.g. "│   Mode: Normal goal", "│   Auto-continue: yes")
						if (afterPipe.includes(": ")) {
							const colonIdx = afterPipe.indexOf(": ");
							const val = afterPipe.slice(colonIdx + 2).trim();
							const keyPart = rawLine.slice(0, rawLine.indexOf(afterPipe) + colonIdx + 2);
							if (val === "yes" || val === "no") {
								addWrappedPipe(theme.fg("muted", keyPart) + theme.fg(val === "yes" ? "success" : "warning", val));
								continue;
							}
							addWrappedPipe(theme.fg("muted", rawLine));
							continue;
						}
						// 3c. Generic content under │ prefix (topic, goal text, etc.)
						addWrappedPipe(theme.fg("muted", rawLine));
						continue;
					}

					// 4. Goal objective structure lines — detected before task checkboxes
					// because === Goal could overlap with ─── markers but we already checked those.
					const GOAL_SECTION_RE = /^(=== (Goal|Sisyphus Goal) ===|Objective:|Success criteria:|Boundaries:|Constraints:|Verification contract:|If blocked:)/;
					if (GOAL_SECTION_RE.test(trimmed)) {
						addWrapped(theme.fg("accent", rawLine));
						continue;
					}

					// 5. Actual box-drawing borders (┌ └ ├ └ ┐ ┤ ┘ ─) — NOT │ which is handled above
					if (/^[┌├└┐┤┘─]/.test(trimmed)) {
						addWrapped(theme.fg("dim", rawLine));
						continue;
					}

					// 6. Task checkbox item — "[ ] ...", "[x] ...", or "[~] ..." (with optional indent)
					const checkMatch = trimmed.match(/^(\[.\])(\s+)(.+)$/);
					if (checkMatch) {
						const bracket = checkMatch[1];
						const sep = checkMatch[2];
						const rest = checkMatch[3];
						const indent = rawLine.slice(0, rawLine.length - trimmed.length);
						const color = bracket === "[x]" ? "success" : "warning";
						addWrapped(indent + theme.fg(color, bracket) + sep + theme.fg("muted", rest));
						continue;
					}

					// 7. Default: any remaining content (fallback)
					addWrapped(theme.fg("muted", rawLine));
				}
			};

			add(theme.fg("accent", "─".repeat(safeWidth)));
			// Lines up to the question line (top border, tabs, question incl.
			// wraps) are the protected head — the slice below must never hide them.
			let protectedCount = lines.length;
			if (isMulti) {
				const tabs: string[] = ["← "];
				for (let i = 0; i < questions.length; i++) {
					const isActive = i === currentTab;
					const isAnswered = answers.has(questions[i].id);
					const label = ` ${isAnswered ? "■" : "□"} ${questions[i].id} `;
					tabs.push(isActive ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(isAnswered ? "success" : "muted", label));
					tabs.push(" ");
				}
				const submitText = " ✓ Submit ";
				tabs.push(currentTab === questions.length ? theme.bg("selectedBg", theme.fg("text", submitText)) : theme.fg(allAnswered() ? "success" : "dim", submitText));
				tabs.push(" →");
				add(` ${tabs.join("")}`);
				lines.push("");
				protectedCount = lines.length;
			}

			function renderOptions() {
				optionsStartIndex = lines.length;
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const recTag = !opt.isCustom && q?.recommended === i ? theme.fg("success", " ★") : "";
					addWrapped(prefix + theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}`) + recTag);
				}
			}

			if (inputMode && q) {
				addWrapped(theme.fg("text", ` ${q.question}`));
				protectedCount = lines.length;
				if (q.context) renderContextLines(q.context);
				lines.push("");
				if (q.options.length > 0) {
					renderOptions();
					lines.push("");
				}
				add(theme.fg("muted", " Your answer:"));
				for (const line of editor.render(safeWidth - 2)) add(` ${line}`);
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to cancel"));
			} else if (currentTab === questions.length) {
				add(theme.fg("accent", theme.bold(" Ready to submit")));
				protectedCount = lines.length;
				lines.push("");
				for (const question of questions) {
					const answer = answers.get(question.id);
					add(`${theme.fg("muted", ` ${question.id}: `)}${answer ? theme.fg("text", `${answer.wasCustom ? "(wrote) " : ""}${answer.answer}`) : theme.fg("warning", "(unanswered)")}`);
				}
				lines.push("");
				add(allAnswered() ? theme.fg("success", " Press Enter to submit") : theme.fg("warning", ` Unanswered: ${questions.filter((qq) => !answers.has(qq.id)).map((qq) => qq.id).join(", ")}`));
			} else if (q) {
				addWrapped(theme.fg("text", ` ${q.question}`));
				protectedCount = lines.length;
				if (q.context) renderContextLines(q.context);
				// Auditor toggle line between context and options
				if (auditorToggleInit) {
					const circle = auditorEnabled ? "●" : "○";
					const label = auditorEnabled ? "Auditor enabled" : "Auditor disabled";
					const color = auditorEnabled ? "success" : "warning";
					add(theme.fg(color, ` ${circle} ${label}`) + theme.fg("dim", "  (press 'a' to toggle)"));
					lines.push("");
				}
				const existing = answers.get(q.id);
				if (existing) add(theme.fg("dim", ` Current: ${existing.wasCustom ? "(wrote) " : ""}${existing.answer}`));
				lines.push("");
				if (opts.length > 0) renderOptions();
				else add(theme.fg("muted", " Press Enter to write your answer"));
			}

			lines.push("");
			if (!inputMode) {
				const auditorHint = auditorToggleInit ? " • a toggle auditor" : "";
				add(theme.fg("dim", isMulti ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel" + auditorHint : " ↑↓ navigate • Enter select • Esc cancel" + auditorHint));
			}
			add(theme.fg("accent", "─".repeat(safeWidth)));
			// Safety net: ensure no returned line exceeds the terminal width
			for (let i = 0; i < lines.length; i++) {
				if (lines[i] && visibleWidth(lines[i]) > safeWidth) {
					lines[i] = truncateToWidth(lines[i], safeWidth);
				}
			}
			// Churn guard: bound to the terminal height (see factory top) so the
			// opened frame never exceeds the screen. Never slice the question:
			// keep the protected head, then spend the rest of the budget on the
			// tail (options/footer/bottom border) — or, for plain select-mode
			// questions where the options start right after the head, keep the
			// top options so the recommended one stays visible. Proposal
			// confirmations additionally keep the tasks section in frame; the
			// objective-box middle is sacrificed there because the full objective
			// is always in the scrollable transcript presentation (renderCall).
			if (maxDialogLines !== undefined && lines.length > maxDialogLines) {
				const optionsImmediatelyAfterHead = !inputMode && currentTab !== questions.length && !!q && !q.context && opts.length > 0;
				const proposalSegments = !inputMode && currentTab !== questions.length && !!q && q.context
					? findProposalPresentationSegments(lines, optionsStartIndex)
					: null;
				lines = fitDialogLines(lines, maxDialogLines, protectedCount, optionsImmediatelyAfterHead, proposalSegments);
			}
			cachedLines = lines;
			return lines;
		}

		return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
	});
}

/**
 * Confirm a proposed draft through the shared questionnaire UI. Escape / cancel
 * maps to "continue" so the user is never trapped.
 */
export async function showProposalDialog(
	ctx: ExtensionContext,
	confirmationText: string,
	focus: GoalDraftingFocus,
	defaultAuditorEnabled?: boolean,
): Promise<{ decision: ProposalDecision; auditorEnabled: boolean }> {
	const headerTitle = focus === "sisyphus" ? "Confirm Sisyphus Goal Draft" : "Confirm Goal Draft";
	const result = await runGoalQuestionnaire(ctx, [{
		id: "confirm",
		question: headerTitle,
		context: confirmationText,
		options: ["Confirm — create this goal now", "Continue chatting — keep refining", "Cancel — discard this draft"],
		recommended: 0,
		allowCustom: false,
	}], defaultAuditorEnabled !== undefined ? { defaultEnabled: defaultAuditorEnabled } : undefined);
	const decision = proposalDecisionFromQuestionnaireResult({
		cancelled: result.cancelled,
		answer: result.answers[0]?.answer,
	});
	return { decision, auditorEnabled: result.auditorEnabled ?? true };
}
