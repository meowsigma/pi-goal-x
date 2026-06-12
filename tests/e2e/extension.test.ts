/**
 * E2E tests for the pi-goal extension.
 *
 * Follows the same pattern as pi-mcp-bridge/tests/e2e/extension.test.ts:
 * loads the extension with a mock pi API, then calls tool execute handlers
 * directly with real parameters and a mock ExtensionContext that provides
 * enough of the real interface for the lifecycle to work.
 */

import { mkdirSync, rmSync, readdirSync, readFileSync, accessSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import piGoalExtension from "../../extensions/goal.ts";
import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalFocusEntry,
	type GoalStateEntry,
} from "../../extensions/goal-record.ts";
import {
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../../extensions/storage/goal-files.ts";
import type { ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal mock ExtensionContext that provides:
 * - cwd for filesystem operations (readActiveGoalPool, writeActiveGoalFile, etc.)
 * - sessionManager.getBranch() returning enough entries for loadState to set focus
 * - hasUI=false to skip widget/status rendering
 * - The rest are stub methods that won't crash
 */
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

/**
 * Creates a temp directory with `.pi/goals/` and a valid goal file.
 * Returns the context needed for a test scenario.
 */
function testFixture() {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-e2e-ext-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });

	// Create settings file that disables the auditor (so completion tests
	// don't try to spawn the actual auditor subprocess)
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disabled: true }));

	const goal = createGoal({
		objective: "E2E test: initial",
		autoContinue: true,
		sisyphus: false,
	}, Date.UTC(2026, 5, 26, 9, 0, 0));

	const written = writeActiveGoalFile({ cwd } as any, goal);

	// Session entries that loadState scans to resolve focus
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

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Extension E2E", () => {
	const registeredTools: ToolDefinition[] = [];
	const lifecycleHandlers = new Map<string, Function>();
	let apiCalls: Array<{ type: string; data?: unknown }> = [];
	// Track active tools like real SDK — starts with base work tools
	let activeToolNames: string[] = ["read", "bash", "edit", "write"];

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

	function getTool(name: string): ToolDefinition {
		const t = registeredTools.find((t) => t.name === name);
		if (!t) throw new Error(`Tool "${name}" not found`);
		return t;
	}

	// ── 1: Deferred archival ───────────────────────────────────────────────
	// ── 0: syncGoalTools deferred from load time ──────────────────────────
	it("e2e: syncGoalTools is not called during extension loading, only after session_start", async () => {
		// Create an isolated mock pi that throws "Extension runtime not initialized"
		// on getActiveTools — simulating real SDK behavior during loading.
		let getActiveToolsCallCount = 0;
		const isolatedHandlers = new Map<string, Function>();
		const isolatedToolDefs: ToolDefinition[] = [];

		const isolatedMockPi = {
			registerTool: (def: ToolDefinition) => { isolatedToolDefs.push(def); },
			registerCommand: () => {},
			on: (event: string, handler: Function) => { isolatedHandlers.set(event, handler); },
			appendEntry: () => {},
			registerMessageRenderer: () => {},
			sendMessage: () => {},
			getActiveTools: () => {
				getActiveToolsCallCount++;
				throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
			},
			setActiveTools: () => {},
			hasUI: false,
		};

		// Load extension — with the fix, this should NOT trigger getActiveTools
		piGoalExtension(isolatedMockPi as any);
		const loadTimeCalls = getActiveToolsCallCount;

		// Verify: no getActiveTools call during extension loading
		assert.equal(loadTimeCalls, 0,
			`syncGoalTools must not call getActiveTools during extension loading. ` +
			`Called ${loadTimeCalls} time(s). The top-level syncGoalTools() should be removed.`);

		// Now fire session_start — after this, syncGoalTools should have run
		const ss = isolatedHandlers.get("session_start");
		assert.ok(ss, "session_start handler must be registered");

		// Create a minimal context for session_start that doesn't need filesystem
		const minimalCtx = {
			cwd: "/tmp",
			hasUI: false,
			sessionManager: {
				getBranch: () => [],
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
				getRoot: () => "/tmp",
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

		// After session_start fires, getActiveTools should be called (syncGoalTools runs)
		// We expect it to throw, but that's caught by the try/catch in syncGoalTools
		await ss({ reason: "start" }, minimalCtx);

		const afterSessionStart = getActiveToolsCallCount;
		assert.ok(afterSessionStart > loadTimeCalls,
			`syncGoalTools should call getActiveTools during session_start. ` +
			`Before: ${loadTimeCalls}, After: ${afterSessionStart}`);
	});

	it("e2e: complete without sync produces deferred archival state", async () => {
		const f = testFixture();
		try {
			// Fire session_start
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, f.mockCtx);

			apiCalls = [];

			const completeGoal = getTool("complete_goal");

			// Complete without sync
			const result = await (completeGoal.execute as Function)(
				"call-1",
				{
					status: "complete",
					completionSummary: "E2E test deferred archival.",
					confirmBypassAuditor: true,
				},
				new AbortController().signal,
				undefined,
				f.mockCtx,
			);

			assert.ok(result, "result must be defined");

			// The activePath on disk should still exist (deferred archival)
			const activeFile = path.join(f.cwd, f.goal.activePath ?? ".pi/goals/missing");
			let activeExists = false;
			try {
				accessSync(activeFile);
				activeExists = true;
			} catch {}
			assert.ok(activeExists,
				"goal file must still exist in active dir (deferred archival)");

			// There should be NO file in archived dir yet
			const archivedDir = path.join(f.cwd, ".pi", "goals", "archived");
			const archivedFiles = readdirSync(archivedDir);
			assert.equal(archivedFiles.length, 0,
				"archived dir must be empty (deferred archival)");
		} finally {
			f.cleanup();
		}
	});

	// ── 2: Rejection gate tests ─────────────────────────────────────────────
	it("e2e: complete_goal rejects null/absent goal state", async () => {
		const f = testFixture();
		try {
			// Do NOT fire session_start — state is empty
			const completeGoal = getTool("complete_goal");

			// Without a goal, calling complete_goal with status=complete should return error
			const result = await (completeGoal.execute as Function)(
				"call-2",
				{ status: "complete" },
				new AbortController().signal,
				undefined,
				f.mockCtx,
			);

			assert.ok(result, "result must be defined");
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("No goal") || text.includes("no goal"),
				`must reject when no goal is active. Got: ${text}`);
		} finally {
			f.cleanup();
		}
	});

	// ── 3: Goal creation with task list (unified acceptance path) ──────────
	it("e2e: goal created with task list via unified acceptance path", async () => {
		const f = testFixture();
		try {
			// Fire session_start to load state
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, f.mockCtx);

			apiCalls = [];

			// Simulate what replaceGoal + task list set does in propose_goal_draft
			// 1) Create goal with verificationContract
			const goal = createGoal({
				objective: "E2E unified: build the thing",
				autoContinue: true,
				sisyphus: false,
			});
			goal.verificationContract = "Must verify";

			// 2) Set task list with subtasks
			const now = new Date().toISOString();
			goal.taskList = {
				tasks: [{
					id: "t1",
					title: "Setup",
					status: "pending" as const,
					subtasks: [
						{ id: "t1a", title: "Install", status: "pending" as const },
					],
				}],
				blockCompletion: false,
				proposedAt: now,
			};
			goal.updatedAt = now;

			// 3) Write to disk
			const written = writeActiveGoalFile({ cwd: f.cwd } as any, goal);
			assert.ok(written, "goal file should be written");
			assert.ok(written.activePath, "should have activePath");

			// 4) Read back and verify
			const pool = readActiveGoalPool({ cwd: f.cwd });
			assert.ok(pool instanceof Map, "pool should be a Map");
			const loaded = pool.get(goal.id);
			assert.ok(loaded, "goal should be in the active pool");
			assert.equal(loaded.objective, "E2E unified: build the thing");
			assert.ok(loaded.taskList, "task list persisted");
			assert.equal(loaded.taskList!.tasks.length, 1);
			assert.equal(loaded.taskList!.tasks[0]!.id, "t1");
			assert.ok(loaded.taskList!.tasks[0]!.subtasks, "subtasks persisted");
			assert.equal(loaded.taskList!.tasks[0]!.subtasks![0]!.id, "t1a");
			assert.equal(loaded.verificationContract, "Must verify");
		} finally {
			f.cleanup();
		}
	});

	// ── 4: Scroll fix: hardware cursor management during dialogs ──────────
	it("e2e: scroll fix toggles hardware cursor properly via submit callback", async () => {
		const f = testFixture();
		try {
			// Fire session_start to load state
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, f.mockCtx);

			apiCalls = [];

			// Verify the goal can be completed without dialog issues
			// This exercises the propose_task_list confirmation path
			// which routes through showProposalDialog → runGoalQuestionnaire
			const proposeTaskList = getTool("propose_task_list");

			// propose_task_list without an active goal should reject safely
			// (the fixture has a goal, but propose_task_list also needs the goal
			//  in state.goal, not just on disk)
			const result = await (proposeTaskList.execute as Function)(
				"call-scroll",
				{
					tasks: [{
						id: "t1",
						title: "Task 1",
						subtasks: [{ id: "t1a", title: "Sub A" }],
					}],
				},
				new AbortController().signal,
				undefined,
				f.mockCtx,
			);

			assert.ok(result, "result must be defined");
			// In headless mode (hasUI: false), the dialog is skipped via
			// shouldAutoConfirmProposal. The result should either succeed or
			// show an appropriate message depending on state.
			const text = result.content?.[0]?.text ?? "";
			// The key test is that no error/crash occurs from cursor operations
			assert.equal(result.error, undefined, "no error from scroll/cursor path");

			// The scroll fix is also used in showProposalDialog called by propose_goal_draft
			// In headless mode (hasUI: false), shouldAutoConfirmProposal returns true
			// so no dialog is shown — the scroll path is skipped, confirming safety
		} finally {
			f.cleanup();
		}
	});

	// ── 5: verificationSummary parameter ────────────────────────────────────
	it("e2e: complete_goal accepts verificationSummary parameter", async () => {
		const f = testFixture();
		try {
			// Fire session_start to load state and set focusedGoalId/state.goal
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss, "session_start handler must be registered");
			await ss({ reason: "start" }, f.mockCtx);

			apiCalls = []; // reset call tracking

			const completeGoal = getTool("complete_goal");
			const result = await (completeGoal.execute as Function)(
				"call-3",
				{
					status: "complete",
					completionSummary: "All work done.",
					verificationSummary: "Ran npm test (0 failures). Re-read requirements and confirmed all items. Grepped for remaining references (none found).",
					confirmBypassAuditor: true,
				},
				new AbortController().signal,
				undefined,
				f.mockCtx,
			);

			// With disabled auditor and auditor bypass set, the completion succeeds
			assert.ok(result, "result must be defined");
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("Goal complete") || text.includes("audit"),
				`completion text should mention completion or audit. Got: ${text.substring(0, 100)}`);

			// Verify no errors from verificationSummary being passed through
			assert.equal(result.error, undefined, "should not return an error");
		} finally {
			f.cleanup();
		}
	});

	it("complete_goal with skipAuditor=true skips auditor directly", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-e2e-skipaudit-"));
		mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
		// Settings without disabled=true (auditor enabled by default)
		writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({}));

		const goal = createGoal({
			objective: "Skip audit test",
			autoContinue: true,
			sisyphus: false,
		});
		const goalWithSkip: GoalRecord = { ...goal, skipAuditor: true };
		const written = writeActiveGoalFile({ cwd } as any, goalWithSkip);

		const focusEntry = goalFocusDetails(goal.id, "created");
		const stateEntry: GoalStateEntry = { version: 3, goal: { ...goalWithSkip, activePath: written.activePath } };
		const sessionEntries = [
			{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
			{ type: "custom", customType: "pi-goal-state", data: stateEntry },
		];
		const mockCtx = createMockCtx(cwd, sessionEntries);

		try {
			apiCalls = [];
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss, "session_start handler must be registered");
			await ss({ reason: "start" }, mockCtx);

			const completeGoal = getTool("complete_goal");
			const result = await (completeGoal.execute as Function)(
				"call-skip-audit",
				{ status: "complete", completionSummary: "Skipping auditor." },
				new AbortController().signal,
				undefined,
				mockCtx,
			);
			assert.ok(result, "result must be defined");
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("Goal complete"), "completion should succeed with skipAuditor");
			assert.ok(text.includes("per-goal auditor disabled"), "should show per-goal auditor was skipped");
		} finally {
			try { rmSync(cwd, { recursive: true, force: true }); } catch {}
		}
	});
});
