// Headless validation for the goal widget terminal-height bound
// (spec 2026-08-10-widget-height-bound-scrollback-fix).
//
// Drives the REAL pi-tui main-screen renderer (TuiMainScreen — pi's default
// renderer) with pi's REAL frame layout (header, chat, status, widget,
// editor, footer as plain Containers, exactly as interactive-mode mounts them
// in regular mode) and the REAL GoalWidgetComponent, at the user's repro:
// terminal height == the goal UI's natural height.
//
// Reports per scenario:
//   - widget rendered lines (post-fix must be <= terminalRows - WIDGET_HEIGHT_RESERVE)
//   - frame length + viewportTop (lines above the viewport live in terminal
//     scrollback and are reachable by scrolling up)
//   - whether the chat and the editor/footer are on screen or reachable
//   - \x1b[2J / \x1b[3J emissions on a widget state update (a 3J wipes
//     terminal scrollback — the bug)
//
// Usage:
//   node widget-height-bound.mjs           # report mode
//   node widget-height-bound.mjs --expect  # assertion mode (exit 1 on failure)

import { Container } from "../../node_modules/@earendil-works/pi-tui/dist/tui.js";
import { TuiMainScreen } from "../../node_modules/@earendil-works/pi-tui/dist/index.js";
import { GoalWidgetComponent, WIDGET_HEIGHT_RESERVE } from "../../extensions/widgets/goal-widget.ts";

const COLS = 120;
const ROWS = 24; // == expanded dashboard natural height (the primary repro)

const expectMode = process.argv.includes("--expect");
const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s, dim: (s) => s };
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

function makeTerminal(rows) {
	const writes = [];
	return {
		terminal: {
			columns: COLS,
			rows,
			write(data) { writes.push(String(data)); },
			hideCursor() {}, showCursor() {}, start() {}, stop() {}, setTitle() {},
		},
		writes,
	};
}

function analyzeForWipes(stream) {
	let clear2J = 0;
	let clear3J = 0;
	let alt1049 = 0;
	let i = 0;
	while (i < stream.length) {
		if (stream.startsWith("\x1b[2J", i)) { clear2J++; i += 4; continue; }
		if (stream.startsWith("\x1b[3J", i)) { clear3J++; i += 4; continue; }
		if (stream.startsWith("\x1b[?1049", i)) { alt1049++; i += 7; continue; }
		i++;
	}
	return { clear2J, clear3J, alt1049 };
}

const baseGoal = {
	id: "g1",
	createdAt: "2026-08-10T00:00:00Z",
	updatedAt: "2026-08-10T00:00:00Z",
	objective: "=== Goal ===\nObjective: Fix the scrollback issue so the user can scroll up",
	status: "active",
	autoContinue: true,
	usage: { activeSeconds: 65, tokensUsed: 2500 },
	sisyphus: true,
	activePath: ".pi/goals/active_goal.md",
	taskList: {
		tasks: Array.from({ length: 12 }, (_, i) => ({
			id: `t${i}`,
			title: `Task number ${i} with a reasonably long title for wrapping`,
			status: i < 5 ? "complete" : "pending",
			createdAt: "2026-08-10T00:00:00Z",
			updatedAt: "2026-08-10T00:00:00Z",
			completedAt: i < 5 ? "2026-08-10T00:01:00Z" : undefined,
		})),
	},
	verificationContract: "Run npm test (0 failures) and re-read requirements",
};

function makeFrame(tui, { chatLines, widgetComponent, expanded }) {
	const header = new Container();
	header.render = () => ["pi • model • cwd"];
	const chat = new Container();
	chat.render = () => Array.from({ length: chatLines }, (_, i) => `chat line ${i} ${"x".repeat(30)}`);
	const status = new Container();
	status.render = () => ["⠋ Working..."];
	const widgetContainer = new Container();
	widgetContainer.addChild(widgetComponent);
	const editor = new Container();
	editor.render = () => ["❯ ", ""];
	const footer = new Container();
	footer.render = () => ["─ footer ─"];
	// pi regular-mode order: documentContainer(header, chat), pending, status,
	// widgetContainerAbove, editorContainer, widgetContainerBelow, footer.
	tui.addChild(header);
	tui.addChild(chat);
	tui.addChild(status);
	tui.addChild(widgetContainer);
	tui.addChild(editor);
	tui.addChild(footer);
	return { header, chat, status, editor, footer };
}

function makeWidget(tui, { expanded, currentRef }) {
	return new GoalWidgetComponent({
		tui,
		theme,
		getGoal: () => currentRef.current,
		getOpenGoalCount: () => 1,
		getSettings: () => ({}),
		getExpanded: () => expanded,
	});
}

let failures = 0;
let demoFailures = 0;
function check(cond, label, detail) {
	if (!cond) {
		failures++;
		console.log(`  ✗ FAIL: ${label}${detail ? ` (${detail})` : ""}`);
	} else {
		console.log(`  ✓ ${label}`);
	}
}
function demoCheck(cond, label, detail) {
	if (!cond) {
		demoFailures++;
		console.log(`  ✗ (expected pre-fix) ${label}${detail ? ` (${detail})` : ""}`);
	} else {
		console.log(`  ✓ ${label}`);
	}
}

function runScenario({ label, chatLines, expanded, preFix, rows, demo }) {
	console.log(`\n── ${label}${demo ? " (demonstration only)" : ""} ──`);
	const { terminal, writes } = makeTerminal(rows);
	const tui = new TuiMainScreen(terminal, false, "/tmp/tui-widget-bound");
	const currentRef = { current: baseGoal };
	// preFix: hide `terminal` from the widget so it renders unbounded (the
	// pre-bound behavior); everything else delegates to the real TUI.
	const widgetTui = preFix
		? new Proxy(tui, {
			get: (t, p) => {
				if (p === "terminal") return undefined;
				const v = Reflect.get(t, p);
				return typeof v === "function" ? v.bind(t) : v;
			},
		})
		: tui;
	const component = makeWidget(widgetTui, { expanded, currentRef });
	makeFrame(tui, { chatLines, widgetComponent: component, expanded });
	tui.doRender();
	writes.length = 0;

	const frame = (tui.previousLines ?? []).map(stripAnsi);
	const widgetStart = 1 + chatLines + 1; // header + chat + status
	const widgetNatural = component.render(COLS).length; // widget's own render (unbounded comparison)
	const frameLen = frame.length;
	const viewportTop = Math.max(0, frameLen - rows);
	const cap = Math.max(1, rows - WIDGET_HEIGHT_RESERVE);
	// The widget occupies frame[widgetStart .. widgetStart + rendered); the
	// remaining rows after it are the editor + footer.
	const renderedWidget = Math.min(widgetNatural, Math.max(0, frameLen - widgetStart));
	const chatAboveViewport = chatLines > 0 ? frameLen > rows : false;
	const footerIdx = frameLen - 1;
	const footerVisible = footerIdx >= viewportTop;
	const editorVisible = frameLen - 2 >= viewportTop;

	const maybeCheck = demo ? demoCheck : check;
	// 1. widget bounded
	maybeCheck(renderedWidget <= cap, `widget rendered ${renderedWidget} lines <= cap ${cap}`, `frame=${frameLen}`);
	// 2. chat reachable by scrolling up (frame taller than terminal -> top
	//    lines live in terminal scrollback; or chat on screen)
	maybeCheck(chatAboveViewport || chatLines === 0, `chat reachable above viewport (chat=${chatLines}, viewportTop=${viewportTop}, frame=${frameLen})`);
	// 3. editor + footer visible / reachable (user can type and see chrome)
	maybeCheck(editorVisible && footerVisible, `editor+footer visible (editorAt=${frameLen - 2}, footerAt=${footerIdx}, viewportTop=${viewportTop})`);
	// 4. header + status of the widget survive (head slice)
	maybeCheck(frame[widgetStart]?.startsWith("╭─ pi-goal-x"), "widget header preserved");
	maybeCheck(frame[widgetStart + 1]?.includes("goal:"), "widget status line preserved");

	// 5. a widget state update must not wipe scrollback (no 2J/3J)
	const next = { ...baseGoal, updatedAt: "2026-08-10T00:02:00Z", usage: { activeSeconds: 66, tokensUsed: 2600 } };
	currentRef.current = next;
	component.invalidate();
	tui.doRender();
	const updateWrites = writes.join("");
	writes.length = 0;
	const upd = analyzeForWipes(updateWrites);
	maybeCheck(upd.clear2J === 0 && upd.clear3J === 0 && upd.alt1049 === 0,
		`widget update emits no 2J/3J/1049 (2J=${upd.clear2J}, 3J=${upd.clear3J})`,
		`bytes=${updateWrites.length}`);

	return { frameLen, viewportTop, renderedWidget, cap, natural: widgetNatural };
}

// Scenarios
runScenario({ label: "equal-height, chat present (24-row terminal, expanded dashboard)", chatLines: 10, expanded: true, preFix: false, rows: 24 });
runScenario({ label: "equal-height, chat present — PRE-FIX comparison (unbounded widget)", chatLines: 10, expanded: true, preFix: true, rows: 24, demo: true });
runScenario({ label: "equal-height, empty chat (24-row terminal, expanded dashboard)", chatLines: 0, expanded: true, preFix: false, rows: 24 });
runScenario({ label: "equal-height, compact dashboard (13-row terminal)", chatLines: 6, expanded: false, preFix: false, rows: 13 });
runScenario({ label: "normal terminal, expanded dashboard (30 rows — fits, must be unchanged)", chatLines: 4, expanded: true, preFix: false, rows: 30 });

if (expectMode) {
	if (failures > 0) {
		console.log(`\nFAIL: ${failures} assertion(s) failed`);
		process.exit(1);
	}
	console.log("\nOK: all assertions passed");
	process.exit(0);
} else {
	console.log(`\nreport mode — ${failures} failures`);
}
