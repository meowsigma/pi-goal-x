#!/usr/bin/env node

/**
 * pi-goal subagent-based e2e test runner.
 *
 * Tests that:
 * 1. The e2e-test-runner agent file exists with bootstrapping instructions
 * 2. The extension test (extension.test.ts) passes — this validates the
 *    actual update_goal handler through a mock pi session
 * 3. The chain documentation covers all required scenarios
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

const DIR = import.meta.dirname!;
const PROJ_ROOT = path.resolve(DIR, "..", "..");

describe("Subagent E2E", { timeout: 120_000 }, () => {
	it("e2e-test-runner agent file exists with bootstrapping", () => {
		const agentPath = path.resolve(DIR, "e2e-test-runner.md");
		const content = readFileSync(agentPath, "utf8");

		assert.ok(content.includes("name: e2e-test-runner"));
		assert.ok(content.includes("description:"));
		assert.ok(
			content.includes("Bootstrap") || content.includes("bootstrap"),
			"agent must include bootstrapping instructions",
		);

		// Verification steps
		assert.ok(content.includes("get_goal"), "agent must use get_goal");
		assert.ok(content.includes("update_goal"), "agent must use update_goal");
		assert.ok(content.includes("PASS") || content.includes("FAIL"),
			"agent must output structured PASS/FAIL report");
	});

	it("e2e-test-runner agent file bootstraps a goal file", () => {
		const agentPath = path.resolve(DIR, "e2e-test-runner.md");
		const content = readFileSync(agentPath, "utf8");

		assert.ok(
			content.includes("active_goal") || content.includes(".pi/goals/"),
			"agent must write a goal file to .pi/goals/",
		);
	});

	it("pi-goal extension loads and registers update_goal tool", () => {
		const tools: ToolDefinition[] = [];
		const handlerMap = new Map<string, Function>();
		const mockPi = {
			registerTool: (d: ToolDefinition) => tools.push(d),
			registerCommand: () => {},
			on: (e: string, h: Function) => handlerMap.set(e, h),
			appendEntry: () => {},
			registerMessageRenderer: () => {},
			sendMessage: () => {},
			getActiveTools: () => new Map(),
			setActiveTools: () => {},
			hasUI: false,
		};

		piGoalExtension(mockPi as any);

		// update_goal tool must be registered
		const updateGoal = tools.find((t) => t.name === "update_goal");
		assert.ok(updateGoal, "update_goal tool must be registered");

		// Lifecycle hooks must be registered
		assert.ok(handlerMap.has("session_start"), "session_start hook");
		assert.ok(handlerMap.has("before_agent_start"), "before_agent_start hook");
		assert.ok(handlerMap.has("turn_end"), "turn_end hook");
	});

	it("update_goal handler: quick-sync via mock extension session", async () => {
		const tools: ToolDefinition[] = [];
		const handlerMap = new Map<string, Function>();
		const mockPi = {
			registerTool: (d: ToolDefinition) => tools.push(d),
			registerCommand: () => {},
			on: (e: string, h: Function) => handlerMap.set(e, h),
			appendEntry: () => {},
			registerMessageRenderer: () => {},
			sendMessage: () => {},
			getActiveTools: () => new Map(),
			setActiveTools: () => {},
			hasUI: false,
		};

		piGoalExtension(mockPi as any);

		// Set up temp workspace with goal file
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-subagent-e2e-"));
		try {
			mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
			writeFileSync(
				path.join(cwd, ".pi", "goal-auditor.json"),
				JSON.stringify({ disabled: true }),
			);

			const goal = createGoal({
				objective: "Subagent e2e: initial",
				autoContinue: true,
				sisyphus: false,
			});
			const written = writeActiveGoalFile({ cwd } as any, goal as GoalRecord);

			// Create session entries for loadState
			const focusEntry = goalFocusDetails(goal.id, "created");
			const stateEntry: GoalStateEntry = {
				version: 3,
				goal: { ...goal, activePath: written.activePath },
			};

			const mockCtx = {
				cwd,
				hasUI: false,
				sessionManager: {
					getBranch: () => [
						{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
						{ type: "custom", customType: "pi-goal-state", data: stateEntry },
					],
					getCwd: () => cwd,
					getSessionId: () => "test",
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

			// Fire session_start to initialize extension state
			const ss = handlerMap.get("session_start");
			assert.ok(ss, "session_start handler must exist");
			await ss({ reason: "start" }, mockCtx);

			// Call update_goal with updatedObjective only (quick-sync)
			const updateGoal = tools.find((t) => t.name === "update_goal")!;
			const result = await (updateGoal.execute as Function)(
				"call-1",
				{ updatedObjective: "Subagent e2e: quick-synced via handler" },
				new AbortController().signal,
				undefined,
				mockCtx,
			);

			// Verify quick-sync behavior
			assert.ok(result, "result must exist");
			assert.equal(
				result.content?.[0]?.text,
				"Goal objective updated.",
				"must respond with 'Goal objective updated.'",
			);
			assert.equal(
				result.terminate,
				undefined,
				"quick-sync must NOT set terminate: true",
			);

			// Verify objective changed on disk
			const pool = readActiveGoalPool({ cwd } as any);
			const diskGoal = pool.get(goal.id);
			assert.ok(diskGoal, "goal must still be in active pool");
			assert.equal(
				diskGoal.objective,
				"Subagent e2e: quick-synced via handler",
				"disk must have updated objective",
			);
			assert.equal(diskGoal.status, "active", "status must stay active");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("chain documentation covers all scenarios", () => {
		const chainPath = path.resolve(DIR, "e2e-test.chain.md");
		const content = readFileSync(chainPath, "utf8");

		assert.ok(content.includes("quick-sync"), "chain must cover quick-sync");
		assert.ok(content.includes("combined sync"), "chain must cover combined sync+complete");
		assert.ok(content.includes("deferred archival"), "chain must cover deferred archival");
	});
});
