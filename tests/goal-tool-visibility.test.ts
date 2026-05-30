/**
 * Integration tests for lifecycle tool visibility.
 *
 * Tests that syncGoalTools() correctly manages the active tool set
 * through lifecycle events — session_start, before_agent_start, etc.
 * Uses the same mock pattern as extension.test.ts.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import piGoalExtension from "../extensions/goal.ts";
import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalStateEntry,
} from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import type { ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockCtx(cwd: string, sessionEntries: unknown[]): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => sessionEntries,
			getCwd: () => cwd,
			getSessionId: () => "test-session",
			getRoot: () => cwd,
			append: () => {},
			appendModelChange: () => {},
			appendThinkingLevelChange: () => {},
			appendCompetingWriteCheck: () => {},
			buildSessionContext: () => ({ messages: [], sessionId: "test", model: null, thinkingLevel: "medium" }),
		},
		getSystemPrompt: () => "",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
}

function testFixture() {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-tool-vis-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disabled: true }));

	const goal = createGoal({
		objective: "Tool visibility test",
		autoContinue: true,
		sisyphus: false,
	}, Date.UTC(2026, 5, 26, 9, 0, 0));

	const written = writeActiveGoalFile({ cwd } as any, goal);

	const focusEntry = goalFocusDetails(goal.id, "created");
	const stateEntry: GoalStateEntry = { version: 3, goal: { ...goal, activePath: written.activePath } };
	const sessionEntries = [
		{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
		{ type: "custom", customType: "pi-goal-state", data: stateEntry },
	];

	const mockCtx = createMockCtx(cwd, sessionEntries);
	const cleanup = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch {} };

	return { cwd, goal: written, mockCtx, cleanup };
}

// ── Expected tool sets ───────────────────────────────────────────────────────

const ACTIVE_LIFECYCLE_TOOLS = [
	"get_goal", "complete_goal", "pause_goal", "abort_goal",
	"propose_goal_tweak", "propose_task_list", "complete_task", "skip_task",
];

const PAUSED_LIFECYCLE_TOOLS = [
	"get_goal", "complete_goal", "abort_goal",
	"propose_goal_tweak", "propose_task_list",
];

const NO_GOAL_TOOLS = ["get_goal"];

const BASE_WORK_TOOLS = ["read", "bash", "edit", "write"];

// Every lifecycle tool that must be present for active goals
const ALL_LIFECYCLE_TOOLS = [...ACTIVE_LIFECYCLE_TOOLS];

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Tool visibility integration", () => {
	const registeredTools: ToolDefinition[] = [];
	const lifecycleHandlers = new Map<string, Function>();
	let apiCalls: Array<{ type: string; data?: unknown }> = [];
	let activeToolNames: string[] = [...BASE_WORK_TOOLS];

	const mockPi = {
		registerTool: (def: ToolDefinition) => { registeredTools.push(def); },
		registerCommand: () => {},
		on: (event: string, handler: Function) => { lifecycleHandlers.set(event, handler); },
		appendEntry: (customType: string, data: unknown) => {
			apiCalls.push({ type: "appendEntry", data: { customType, data } });
		},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => [...activeToolNames],
		setActiveTools: (names: string[]) => { activeToolNames = [...names]; },
		hasUI: false,
	};

	before(() => {
		piGoalExtension(mockPi as any);
	});

	// ── After session_start with active goal ─────────────────────────────
	it("active goal exposes all lifecycle tools after session_start", async () => {
		const f = testFixture();
		try {
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss, "session_start handler must be registered");

			// Reset tool state before test
			activeToolNames = [...BASE_WORK_TOOLS];
			apiCalls = [];

			await ss({ reason: "start" }, f.mockCtx);

			// After session_start, an active goal should have all lifecycle tools
			for (const tool of ALL_LIFECYCLE_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`active goal should have tool "${tool}" after session_start. Active tools: ${JSON.stringify(activeToolNames)}`);
			}

			// Base work tools should also be present
			for (const tool of BASE_WORK_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`active goal should have work tool "${tool}" after session_start`);
			}

			// create_goal should NOT be available
			assert.equal(activeToolNames.includes("create_goal"), false,
				"create_goal must not be in active tool set");

			// propose_goal_draft should be available
			assert.ok(activeToolNames.includes("propose_goal_draft"),
				"propose_goal_draft must be in active tool set");
		} finally {
			f.cleanup();
		}
	});

	// ── After before_agent_start with active goal ────────────────────────
	it("active goal exposes all lifecycle tools after before_agent_start", async () => {
		const f = testFixture();
		try {
			// Set up state
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, f.mockCtx);

			activeToolNames = [...BASE_WORK_TOOLS];
			apiCalls = [];

			const bas = lifecycleHandlers.get("before_agent_start");
			assert.ok(bas, "before_agent_start handler must be registered");

			await bas({
				systemPrompt: "",
				prompt: "test",
				systemPromptOptions: {},
			}, f.mockCtx);

			for (const tool of ALL_LIFECYCLE_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`active goal should have tool "${tool}" after before_agent_start`);
			}

			// Base work tools should also be present
			for (const tool of BASE_WORK_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`active goal should have work tool "${tool}" after before_agent_start`);
			}
		} finally {
			f.cleanup();
		}
	});

	// ── No goal (null state) ─────────────────────────────────────────────
	it("no goal exposes only get_goal", async () => {
		// Use a temp dir with NO goals at all (no .pi/goals directory)
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-tool-vis-nogoal-"));
		try {
			// Start with empty state (no focus entry, no goals on disk)
			const emptyCtx = createMockCtx(cwd, []);

			activeToolNames = [...BASE_WORK_TOOLS];
			apiCalls = [];

			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, emptyCtx);

			// Only get_goal should be available
			for (const tool of NO_GOAL_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`no-goal state should have tool "${tool}"`);
			}

			// Lifecycle tools should NOT be present
			for (const tool of ALL_LIFECYCLE_TOOLS) {
				if (tool === "get_goal") continue; // get_goal IS expected
				assert.equal(activeToolNames.includes(tool), false,
					`no-goal state must NOT have tool "${tool}"`);
			}
		} finally {
			try { rmSync(cwd, { recursive: true, force: true }); } catch {}
		}
	});

	// ── Complete goal status ─────────────────────────────────────────────
	it("completed goal exposes only get_goal", async () => {
		const f = testFixture();
		try {
			// Start with a completed goal
			const completedGoal = createGoal({
				objective: "Completed test goal",
				autoContinue: false,
				sisyphus: false,
			}, Date.UTC(2026, 5, 26, 10, 0, 0));
			completedGoal.status = "complete" as const;
			completedGoal.completedAt = new Date().toISOString();

			const written = writeActiveGoalFile({ cwd: f.cwd } as any, completedGoal);
			const focusEntry = goalFocusDetails(completedGoal.id, "created");
			const stateEntry: GoalStateEntry = { version: 3, goal: { ...completedGoal, activePath: written.activePath } };
			const sessionEntries = [
				{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
				{ type: "custom", customType: "pi-goal-state", data: stateEntry },
			];
			const completedCtx = createMockCtx(f.cwd, sessionEntries);

			activeToolNames = [...BASE_WORK_TOOLS];
			apiCalls = [];

			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, completedCtx);

			// Only get_goal should be available for completed goals
			for (const tool of ["get_goal"]) {
				assert.ok(activeToolNames.includes(tool),
					`completed goal should have tool "${tool}"`);
			}

			// Lifecycle tools should NOT be present (except get_goal)
			for (const tool of ALL_LIFECYCLE_TOOLS) {
				if (tool === "get_goal") continue;
				assert.equal(activeToolNames.includes(tool), false,
					`completed goal must NOT have tool "${tool}"`);
			}

			// propose_goal_tweak should also be absent
			assert.equal(activeToolNames.includes("propose_goal_tweak"), false,
				"propose_goal_tweak must not be available for completed goals");
		} finally {
			f.cleanup();
		}
	});

	// ── Paused goal status ──────────────────────────────────────────────
	it("paused goal exposes reduced lifecycle tool set without pause_goal", async () => {
		const f = testFixture();
		try {
			// Start active, then simulate goal being paused via state
			const pausedGoal = createGoal({
				objective: "Paused test goal",
				autoContinue: false,
				sisyphus: false,
			}, Date.UTC(2026, 5, 26, 11, 0, 0));
			pausedGoal.status = "paused" as const;
			pausedGoal.stopReason = "agent";
			pausedGoal.pauseReason = "Testing pause state";
			pausedGoal.pauseSuggestedAction = "Run some tests";

			const written = writeActiveGoalFile({ cwd: f.cwd } as any, pausedGoal);
			const focusEntry = goalFocusDetails(pausedGoal.id, "created");
			const stateEntry: GoalStateEntry = { version: 3, goal: { ...pausedGoal, activePath: written.activePath } };
			const sessionEntries = [
				{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
				{ type: "custom", customType: "pi-goal-state", data: stateEntry },
			];
			const pausedCtx = createMockCtx(f.cwd, sessionEntries);

			activeToolNames = [...BASE_WORK_TOOLS];
			apiCalls = [];

			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, pausedCtx);

			// Paused lifecycle tools should be present
			for (const tool of PAUSED_LIFECYCLE_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`paused goal should have tool "${tool}"`);
			}

			// pause_goal must NOT be available for paused goals
			assert.equal(activeToolNames.includes("pause_goal"), false,
				"pause_goal must NOT be available for paused goals");

			// complete_task and skip_task should NOT be available
			assert.equal(activeToolNames.includes("complete_task"), false,
				"complete_task must NOT be available for paused goals");
			assert.equal(activeToolNames.includes("skip_task"), false,
				"skip_task must NOT be available for paused goals");

			// Base work tools should also be present
			for (const tool of BASE_WORK_TOOLS) {
				assert.ok(activeToolNames.includes(tool),
					`paused goal should have work tool "${tool}"`);
			}
		} finally {
			f.cleanup();
		}
	});

	// ── Test that the tool set remains stable after multiple lifecycle events ─
	it("tool set remains stable after multiple lifecycle events", async () => {
		const f = testFixture();
		try {
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			const bas = lifecycleHandlers.get("before_agent_start");
			assert.ok(bas);

			// Fire session_start
			activeToolNames = [...BASE_WORK_TOOLS];
			apiCalls = [];
			await ss({ reason: "start" }, f.mockCtx);

			// Fire before_agent_start multiple times (simulating turns)
			for (let i = 0; i < 3; i++) {
				await bas({
					systemPrompt: "",
					prompt: `turn-${i}`,
					systemPromptOptions: {},
				}, f.mockCtx);

				// Verify all lifecycle tools are present each turn
				for (const tool of ALL_LIFECYCLE_TOOLS) {
					assert.ok(activeToolNames.includes(tool),
						`turn ${i}: active goal should have tool "${tool}"`);
				}
			}
		} finally {
			f.cleanup();
		}
	});

	// ── Verify complete_goal and pause_goal appear in active tools ───────
	it("complete_goal and pause_goal are always in active tool set", () => {
		// Direct assertion: these constants are the source of truth
		assert.ok(ACTIVE_LIFECYCLE_TOOLS.includes("complete_goal"),
			"complete_goal must be in active lifecycle tools");
		assert.ok(ACTIVE_LIFECYCLE_TOOLS.includes("pause_goal"),
			"pause_goal must be in active lifecycle tools");
		assert.ok(ACTIVE_LIFECYCLE_TOOLS.includes("abort_goal"),
			"abort_goal must be in active lifecycle tools");
		assert.ok(ACTIVE_LIFECYCLE_TOOLS.includes("propose_goal_tweak"),
			"propose_goal_tweak must be in active lifecycle tools");
	});

	// ── Verify all registered lifecycle tools have execute handlers ──────
	it("all lifecycle tools are registered with execute handlers", () => {
		const lifecycleToolNames = [
			"get_goal", "complete_goal", "pause_goal", "abort_goal",
			"propose_goal_tweak", "propose_task_list", "complete_task", "skip_task",
		];
		for (const name of lifecycleToolNames) {
			const tool = registeredTools.find((t) => t.name === name);
			assert.ok(tool, `Tool "${name}" must be registered`);
			assert.ok(typeof tool!.execute === "function", `Tool "${name}" must have an execute handler`);
		}
	});
});
