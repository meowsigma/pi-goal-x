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

	// Create auditor config that disables the auditor (so completion tests
	// don't try to spawn the actual auditor subprocess)
	writeFileSync(path.join(cwd, ".pi", "goal-auditor.json"), JSON.stringify({ disabled: true }));

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

	const mockPi = {
		registerTool: (def: ToolDefinition) => { registeredTools.push(def); },
		registerCommand: () => {},
		on: (event: string, handler: Function) => { lifecycleHandlers.set(event, handler); },
		appendEntry: (customType: string, data: unknown) => {
			apiCalls.push({ type: "appendEntry", data: { customType, data } });
		},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => new Map(),
		setActiveTools: () => {},
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

	// ── 1: Disabled auditor bypass ─────────────────────────────────────────
	it("e2e: disabled auditor bypass rejects completion, goal stays active", async () => {
		const f = testFixture();
		try {
			// Fire session_start
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, f.mockCtx);

			apiCalls = [];

			const updateGoal = getTool("update_goal");

			// Attempt to complete with disabled auditor — should reject
			const result = await (updateGoal.execute as Function)(
				"call-1",
				{
					status: "complete",
					completionSummary: "E2E test: disabled auditor bypass.",
					confirmBypassAuditor: true,
				},
				new AbortController().signal,
				undefined,
				f.mockCtx,
			);

			assert.ok(result, "result must be defined");
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("rejected") || text.includes("disabled"),
				`must reject when auditor is disabled. Got: ${text.substring(0, 100)}`);

			// The goal should still be active (NOT marked complete)
			const activeFile = path.join(f.cwd, f.goal.activePath ?? ".pi/goals/missing");
			let activeExists = false;
			try {
				accessSync(activeFile);
				activeExists = true;
			} catch {}
			assert.ok(activeExists,
				"goal file must still exist in active dir (not archived)");

			// There should be NO file in archived dir
			const archivedDir = path.join(f.cwd, ".pi", "goals", "archived");
			const archivedFiles = readdirSync(archivedDir);
			assert.equal(archivedFiles.length, 0,
				"archived dir must be empty (goal not archived)");
		} finally {
			f.cleanup();
		}
	});

	// ── 2: Rejection gate tests ─────────────────────────────────────────────
	it("e2e: update_goal rejects null/absent goal state", async () => {
		const f = testFixture();
		try {
			// Do NOT fire session_start — state is empty
			const updateGoal = getTool("update_goal");

			// Without a goal, calling update_goal with status=complete should return error
			const result = await (updateGoal.execute as Function)(
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

	// ── 3: testResults parameter ────────────────────────────────────────────
	it("e2e: update_goal accepts testResults parameter without error (rejected due to disabled auditor)", async () => {
		const f = testFixture();
		try {
			// Fire session_start to load state and set focusedGoalId/state.goal
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss, "session_start handler must be registered");
			await ss({ reason: "start" }, f.mockCtx);

			apiCalls = []; // reset call tracking

			const updateGoal = getTool("update_goal");
			const result = await (updateGoal.execute as Function)(
				"call-3",
				{
					status: "complete",
					completionSummary: "All work done.",
					confirmBypassAuditor: true,
					testResults: {
						exitCode: 0,
						suiteName: "npm test",
						output: "1..123\n# tests 123\n# pass 123\n# fail 0",
						timestamp: "2026-05-26T12:42:00.000Z",
					},
				},
				new AbortController().signal,
				undefined,
				f.mockCtx,
			);

			// With disabled auditor, the completion is rejected regardless of testResults
			assert.ok(result, "result must be defined");
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("rejected") || text.includes("disabled"),
				`must reject when auditor is disabled. Got: ${text.substring(0, 100)}`);

			// Verify no crash from testResults being passed through
			assert.equal(result.error, undefined, "should not return an error");
		} finally {
			f.cleanup();
		}
	});
});
