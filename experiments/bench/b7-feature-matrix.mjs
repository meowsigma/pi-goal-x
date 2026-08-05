/**
 * B7 — Feature-wide wall-clock matrix (all extension features, agent-free).
 * Every row is a deterministic case over fixtures through the real extension
 * functions; the Part 0 module map is the coverage map. Tool-handler rows run
 * through the agent-free integration harness (pi packages stubbed; auditor
 * injected; no live agents, no network, no unauthorized processes).
 */

import {
	makeFixtureCwd,
	makeGoalFiles,
	makeLedger,
	Baseline,
	measure,
	beginFsCount,
	endFsCount,
	createHarness,
	startHarness,
	focusedFixture,
	cleanupFixture,
	makeGoalRecord,
} from "./bench-common.mjs";
import { createMockExtensionContext, createMockTUI, createMockTheme, invokeCustomFactory, renderComponent } from "../../tests/tui-test-utils.ts";
import { renderConfirmationTasks } from "../../extensions/goal-task-confirmation.ts";
import { showEscapeDialog } from "../../extensions/widgets/goal-escape-dialog.ts";
import { showTaskListOverlay } from "../../extensions/widgets/task-list-overlay.ts";
import { renderGoalWidgetLines, GoalWidgetComponent } from "../../extensions/widgets/goal-widget.ts";
import { buildGoalRunningNotification } from "../../extensions/widgets/goal-notifications.ts";
import { renderGoalEvent } from "../../extensions/goal-format.ts";
import { buildTaskSummary, validateTaskListProposal, buildCompletionReport } from "../../extensions/goal-policy.ts";
import { buildGoalListText, goalSelectorLabel } from "../../extensions/goal-pool.ts";
import { GoalAccounting, budgetLine, budgetRemaining } from "../../extensions/goal-accounting.ts";
import { buildCompactionSummary, buildGoalCompactSummary } from "../../extensions/goal-compaction.ts";
import { extractVerificationContract, promptSafeObjective } from "../../extensions/goal-contract.ts";
import { normalizeGoalRecord } from "../../extensions/goal-record.ts";
import { serializeGoalFile, parseGoalFile } from "../../extensions/storage/goal-files.ts";
import { latestEventsForGoal, reconstructGoalLedger } from "../../extensions/goal-ledger.ts";
import { staleContinuationPrompt, unfocusedOpenGoalsPrompt } from "../../extensions/prompts/goal-prompts.ts";
import { buildDraftConfirmationText } from "../../extensions/goal-draft.ts";
import { formatQuestionnaireAnswers } from "../../extensions/goal-questionnaire.ts";
import { goalDetails } from "../../extensions/goal-format.ts";
import { readGoalLedger } from "../../extensions/goal-ledger.ts";
import path from "node:path";

function add(base, row) {
	base.add(row);
}

function taskGoal(taskCount) {
	const goal = makeGoalRecord({ objective: "Matrix goal with a task list and a verification contract." });
	const tasks = [];
	for (let i = 0; i < taskCount; i++) {
		tasks.push({
			id: `t${i}`,
			title: `Task ${i} with a descriptive title`,
			status: i % 3 === 0 ? "complete" : "pending",
			...(i % 3 === 0 ? { evidence: "verified" } : { verificationContract: "verify and confirm" }),
		});
	}
	goal.taskList = { tasks, blockCompletion: true, proposedAt: new Date().toISOString() };
	goal.verificationContract = "Run tests and confirm.";
	return goal;
}

function flatTasks(count) {
	const tasks = [];
	for (let i = 0; i < count; i++) {
		tasks.push({ id: `t${i}`, title: `Task ${i} with a descriptive title for the flat input path` });
	}
	return tasks;
}

export async function run(baseline) {
	// ── A. tool handlers (agent-free harness) ───────────────────────────
	async function toolCase(id, label, modules, fixture, makeHandler, params, prepare) {
		const times = [];
		let ops = 0;
		for (let i = 0; i < 5; i++) {
			const f = focusedFixture();
			try {
				const h = createHarness({ cwd: f.cwd, sessionEntries: f.sessionEntries, runCompletionAuditor: async () =>
					({ approved: true, disapproved: false, output: "ok\n<approved/>", model: "fixture" }) });
				await startHarness(h);
				if (prepare) await prepare(h);
				const tool = h.tools.get(makeHandler());
				if (!tool) throw new Error(`missing tool ${makeHandler()}`);
				beginFsCount();
				const t0 = performance.now();
				await tool.execute("x", params(), new AbortController().signal, undefined, h.ctx);
				times.push(performance.now() - t0);
				ops = Math.max(ops, endFsCount());
			} finally {
				f.cleanup();
			}
		}
		times.sort((a, b) => a - b);
		baseline.add({
			id, label, modules, fixture, n: 5,
			p50: Math.round(times[2] * 10) / 10, p95: Math.round(times[4] * 10) / 10, max: Math.round(times[4] * 10) / 10,
			ops, notes: `fs ops/case ~${ops}; mean ${Math.round(times.reduce((a, b) => a + b, 0) / 5 * 10) / 10}ms`,
		});
	}

	await toolCase("B7.tool.create_goal", "create_goal handler", "goal-core-tools + goal-state + goal-service + goal-notifications", "1 focused fixture", () => "create_goal", () => ({ objective: "Create a benchmark goal with a concrete objective to pursue." }));
	await toolCase("B7.tool.get_goal", "get_goal handler", "goal-core-tools + goal-state + goal-format + goal-pool", "1 focused fixture", () => "get_goal", () => ({}));
	await toolCase("B7.tool.update_goal.paused", "update_goal(paused) handler", "goal-core-tools + goal-state + goal-service", "1 focused fixture", () => "update_goal", () => ({ status: "paused", reason: "benchmark pause" }));
	await toolCase("B7.tool.update_goal.blocked", "update_goal(blocked) handler", "goal-core-tools + goal-service + goal-ledger", "1 focused fixture", () => "update_goal", () => ({ status: "blocked", reason: "benchmark blocker" }));
	await toolCase("B7.tool.set_goal_tasks.50", "set_goal_tasks (50 tasks) handler", "goal-task-tools + goal-task-confirmation + goal-policy + goal-service", "1 focused fixture", () => "set_goal_tasks", () => ({ tasks: flatTasks(50), block_completion: true }));
	await toolCase("B7.tool.update_goal_task", "update_goal_task(complete) handler", "goal-task-tools + goal-service + storage/goal-lock + goal-ledger", "1 goal, 20 tasks", () => "update_goal_task", () => ({ task_id: "t1", status: "complete", evidence: "benchmark evidence" }), async (h) => {
		const setTasks = h.tools.get("set_goal_tasks");
		await setTasks.execute("st-1", { tasks: flatTasks(20), block_completion: false }, new AbortController().signal, undefined, h.ctx);
	});

	// before_agent_start lifecycle event (the per-turn event path)
	{
		const times = [];
		for (let i = 0; i < 5; i++) {
			const cwd = makeFixtureCwd("b7-evt-");
			try {
				makeGoalFiles(cwd, 1);
				makeLedger(cwd, 1000);
				const h = createHarness({ cwd });
				await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
				const t0 = performance.now();
				await h.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "go", systemPromptOptions: {} }, h.ctx);
				times.push(performance.now() - t0);
			} finally {
				cleanupFixture(cwd);
			}
		}
		times.sort((a, b) => a - b);
		baseline.add({
			id: "B7.evt.before_agent_start", label: "before_agent_start event (1 goal, 1k ledger)",
			modules: "goal-events + goal-state + goal-service + goal-ledger + prompts/goal-prompts", fixture: "1 goal, 1000 events", n: 5,
			p50: Math.round(times[2] * 10) / 10, p95: Math.round(times[4] * 10) / 10, max: Math.round(times[4] * 10) / 10,
			notes: `mean ${Math.round(times.reduce((a, b) => a + b, 0) / 5 * 10) / 10}ms; P1-1/2 cut the reads here`,
		});
	}

	// ── B. dialog / widget renders (mock TUI, no live terminal) ─────────
	const g20 = taskGoal(20);
	const t = createMockTUI();
	const theme = createMockTheme();

	let r = measure(() => renderConfirmationTasks(g20.taskList.tasks, 0), { n: 50 });
	baseline.add({ id: "B7.render.confirmationTasks", label: "renderConfirmationTasks (20 tasks)", modules: "goal-task-confirmation", fixture: "20-task tree", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	r = measure(() => buildDraftConfirmationText({ focus: "goal", originalTopic: "Make the task system better", objective: g20.objective, autoContinue: true }), { n: 50 });
	baseline.add({ id: "B7.render.draftConfirmation", label: "buildDraftConfirmationText", modules: "goal-draft", fixture: "1 goal, 20 tasks", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	r = measure(() => formatQuestionnaireAnswers({ questions: [{ id: "mode", question: "Which mode?", options: [] }, { id: "budget", question: "Budget?", options: [] }, { id: "tasks", question: "Tasks?", options: [] }], answers: [{ id: "mode", question: "Which mode?", answer: "regular" }, { id: "budget", question: "Budget?", answer: "100k" }, { id: "tasks", question: "Tasks?", answer: "yes" }] }), { n: 200 });
	baseline.add({ id: "B7.render.questionnaireAnswers", label: "formatQuestionnaireAnswers (3 Q&A)", modules: "goal-questionnaire", fixture: "3 answers", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	r = measure(() => renderGoalWidgetLines(g20, theme, 100, { openGoalCount: 1 }), { n: 100 });
	baseline.add({ id: "B7.render.widgetLines", label: "renderGoalWidgetLines (20 tasks)", modules: "widgets/goal-widget", fixture: "1 goal, 20 tasks", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	r = measure(() => {
		const component = new GoalWidgetComponent({ tui: t.tui, theme, getGoal: () => g20, getOpenGoalCount: () => 1, getSettings: () => ({}), getAuditorProgress: () => null, getDebugMode: () => false });
		return component.render(100);
	}, { n: 100 });
	baseline.add({ id: "B7.render.widgetComponent", label: "GoalWidgetComponent.render (mock TUI)", modules: "widgets/goal-widget", fixture: "1 goal, 20 tasks", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	// task-list overlay component render
	{
		const mockCtx = createMockExtensionContext();
		const goals = new Map([[g20.id, g20]]);
		showTaskListOverlay(mockCtx, goals, g20.id); // no await: the mock custom() promise stays pending (tests do the same)
		const { component } = invokeCustomFactory(mockCtx._customCalls, 0);
		r = measure(() => renderComponent(component, 100), { n: 100 });
		baseline.add({ id: "B7.render.taskOverlay", label: "task-list overlay render (20 tasks)", modules: "widgets/task-list-overlay", fixture: "1 goal, 20 tasks", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });
	}

	// escape dialog component render
	{
		const mockCtx = createMockExtensionContext();
		showEscapeDialog(mockCtx, g20.objective); // no await: see overlay note
		const { component } = invokeCustomFactory(mockCtx._customCalls, 0);
		r = measure(() => renderComponent(component, 100), { n: 100 });
		baseline.add({ id: "B7.render.escapeDialog", label: "escape dialog render", modules: "widgets/goal-escape-dialog", fixture: "objective text", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });
	}

	// ── C. policy / format / accounting / pool / ledger helpers ─────────
	r = measure(() => buildTaskSummary(g20.taskList), { n: 200 });
	baseline.add({ id: "B7.policy.taskSummary", label: "buildTaskSummary (20 tasks)", modules: "goal-policy", fixture: "20-task tree", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	r = measure(() => validateTaskListProposal({ tasks: flatTasks(50), blockCompletion: false }, { depth: 3 }), { n: 100 });
	baseline.add({ id: "B7.policy.validateTasks", label: "validateTaskListProposal (50 flat tasks)", modules: "goal-policy + goal-task-tools", fixture: "50 flat tasks", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	r = measure(() => buildCompletionReport({ detailedSummary: "Goal: full objective\nStatus: complete", taskSummary: "5/10 tasks complete", failedSteps: [], stopReason: "complete" }), { n: 200 });
	baseline.add({ id: "B7.policy.completionReport", label: "buildCompletionReport", modules: "goal-policy", fixture: "1 goal, 20 tasks", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	const pool = new Map();
	for (let i = 0; i < 10; i++) pool.set(`g${i}`, makeGoalRecord({ objective: `Open goal ${i}` }));
	r = measure(() => buildGoalListText(pool, "g0"), { n: 200 });
	baseline.add({ id: "B7.pool.goalList", label: "buildGoalListText (10 goals)", modules: "goal-pool + goal-core + goal-format", fixture: "10 open goals", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	r = measure(() => goalSelectorLabel(pool.get("g1"), "g0"), { n: 2000 });
	baseline.add({ id: "B7.pool.selectorLabel", label: "goalSelectorLabel", modules: "goal-pool + goal-core", fixture: "1 goal", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	const accounting = new GoalAccounting();
	r = measure(() => {
		accounting.begin("g0");
		const a = accounting.charge({ completedTurnTokens: 100 });
		accounting.clear();
		return a;
	}, { n: 200 });
	baseline.add({ id: "B7.accounting.charge", label: "GoalAccounting begin+charge+end", modules: "goal-accounting", fixture: "1 active goal", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	const budgetGoal = { ...g20, tokenBudget: 100000 };
	r = measure(() => `${budgetLine(budgetGoal)} ${budgetRemaining(budgetGoal)}`, { n: 2000 });
	baseline.add({ id: "B7.accounting.budget", label: "budgetLine + budgetRemaining", modules: "goal-accounting", fixture: "goal with 100k budget", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	r = measure(() => buildGoalRunningNotification({ objective: g20.objective, autoContinue: true, sisyphus: false }), { n: 2000 });
	baseline.add({ id: "B7.notifications.running", label: "buildGoalRunningNotification", modules: "widgets/goal-notifications", fixture: "1 config", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	const compactCwd = makeFixtureCwd("b7-compact-");
	try {
		const compactGoal = makeGoalFiles(compactCwd, 1)[0];
		makeLedger(compactCwd, 500);
		const ledgerEvents = readGoalLedger({ cwd: compactCwd }).events;
		r = measure(() => buildCompactionSummary({ goalsById: new Map([[compactGoal.id, compactGoal]]), focusedGoalId: compactGoal.id, ledgerEvents }), { n: 50 });
		baseline.add({ id: "B7.compaction.summary", label: "buildCompactionSummary (500 events)", modules: "goal-compaction + goal-ledger", fixture: "1 goal, 500 events", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });
		r = measure(() => buildGoalCompactSummary(compactGoal, ledgerEvents), { n: 50 });
		baseline.add({ id: "B7.compaction.goalSummary", label: "buildGoalCompactSummary (500 events)", modules: "goal-compaction", fixture: "1 goal, 500 events", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });
		r = measure(() => reconstructGoalLedger(ledgerEvents), { n: 50 });
		baseline.add({ id: "B7.ledger.reconstruct", label: "reconstructGoalLedger (500 events)", modules: "goal-ledger", fixture: "500 events", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });
		r = measure(() => latestEventsForGoal(ledgerEvents, "x", 10), { n: 500 });
		baseline.add({ id: "B7.ledger.latestEvents", label: "latestEventsForGoal (500 events)", modules: "goal-ledger", fixture: "500 events", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });
	} finally {
		cleanupFixture(compactCwd);
	}

	r = measure(() => extractVerificationContract("Implement X. Verification contract: run tests and confirm."), { n: 2000 });
	baseline.add({ id: "B7.contract.extract", label: "extractVerificationContract", modules: "goal-contract + goal-draft", fixture: "objective text", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms; P1-11 dedups the goal-draft copy` });

	r = measure(() => promptSafeObjective("Objective with <angle> brackets & ampersands and plenty of text to escape safely."), { n: 2000 });
	baseline.add({ id: "B7.contract.promptSafe", label: "promptSafeObjective", modules: "goal-contract", fixture: "objective text", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	r = measure(() => normalizeGoalRecord({ id: "x", objective: "y", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "active", autoContinue: true, sisyphus: false, usage: { tokensUsed: 0, activeSeconds: 0 } }), { n: 2000 });
	baseline.add({ id: "B7.record.normalize", label: "normalizeGoalRecord", modules: "goal-record", fixture: "raw record", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	const fileCwd = makeFixtureCwd("b7-file-");
	try {
		const written = makeGoalFiles(fileCwd, 1)[0];
		const rel = written.activePath;
		const abs = path.join(fileCwd, rel);
		r = measure(() => serializeGoalFile(written), { n: 1000 });
		baseline.add({ id: "B7.files.serialize", label: "serializeGoalFile", modules: "storage/goal-files + goal-core + goal-record", fixture: "1 goal", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });
		r = measure(() => parseGoalFile(abs), { n: 200 });
		baseline.add({ id: "B7.files.parse", label: "parseGoalFile", modules: "storage/goal-files + goal-record", fixture: "1 goal file", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms; P1-1 caches per-turn parse` });
	} finally {
		cleanupFixture(fileCwd);
	}

	r = measure(() => renderGoalEvent({ details: { goalId: "g1", status: "active", objective: "Matrix objective", kind: "checkpoint", currentGoalId: "g1", currentStatus: "active" } }, { expanded: true }, theme), { n: 2000 });
	baseline.add({ id: "B7.format.renderEvent", label: "renderGoalEvent heading", modules: "goal-format", fixture: "task_complete event", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	r = measure(() => goalDetails(g20), { n: 2000 });
	baseline.add({ id: "B7.format.goalDetails", label: "goalDetails", modules: "goal-format + goal-accounting", fixture: "1 goal, 20 tasks", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	r = measure(() => staleContinuationPrompt("stale-id", g20), { n: 2000 });
	baseline.add({ id: "B7.runtime.stalePrompt", label: "staleContinuationPrompt", modules: "prompts/goal-prompts + goal-core", fixture: "1 goal", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	r = measure(() => unfocusedOpenGoalsPrompt(3), { n: 2000 });
	baseline.add({ id: "B7.runtime.unfocusedPrompt", label: "unfocusedOpenGoalsPrompt", modules: "prompts/goal-prompts", fixture: "3 open goals", n: r.n, p50: r.p50, p95: r.p95, max: r.max, notes: `mean ${r.mean}ms` });

	return baseline;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const baseline = new Baseline();
	await run(baseline);
	process.stdout.write(baseline.markdown());
}
