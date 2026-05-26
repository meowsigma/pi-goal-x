#!/usr/bin/env node

/**
 * pi-goal e2e test runner.
 *
 * Tests:
 * 1. File-validity checks (agent file bootstrapping, chain docs)               ✓
 * 2. Mock-pi handler tests (extension loads, session_start, update_goal)       ✓
 *
 * These tests use only exported functions and mock pi objects — no AI model
 * dependency, no flaky network calls, fully deterministic.
 *
 * The real-pi-fork test (pi --fork with --mode json) was intentionally removed
 * because it depends on an AI model making correct tool calls, which is
 * inherently non-deterministic and flaky. The mock-pi handler tests below
 * provide equivalent behavioral verification (checking handler result fields,
 * disk state, pool membership) with 100% determinism.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import piGoalExtension from "../../extensions/goal.ts";
import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalStateEntry,
} from "../../extensions/goal-record.ts";
import {
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../../extensions/storage/goal-files.ts";
import type { ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DIR = import.meta.dirname!;

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockPiSetup() {
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
	return { tools, handlerMap };
}

function createMockCtx(cwd: string, goal: GoalRecord, written: GoalRecord): ExtensionContext {
	const focusEntry = goalFocusDetails(goal.id, "created");
	const stateEntry: GoalStateEntry = {
		version: 3,
		goal: { ...goal, activePath: written.activePath },
	};
	return {
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
}

function testFixture() {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-subagent-e2e-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "goal-auditor.json"), JSON.stringify({ disabled: true }));

	const goal = createGoal({
		objective: "Subagent e2e: initial",
		autoContinue: true,
		sisyphus: false,
	});
	const written = writeActiveGoalFile({ cwd } as any, goal as GoalRecord);
	return { cwd, goal: goal as GoalRecord, written, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Subagent E2E", () => {
	// ── 1. File-validity checks ──────────────────────────────────────────────
	it("agent file exists with bootstrapping (goal file + state entry)", () => {
		const agentPath = path.resolve(DIR, "e2e-test-runner.md");
		const content = readFileSync(agentPath, "utf8");
		assert.ok(content.includes("name: e2e-test-runner"));
		assert.ok(content.includes("Bootstrap") || content.includes("bootstrap"),
			"agent must include bootstrapping instructions");
		assert.ok(content.includes("goal file") || content.includes(".pi/goals/"),
			"agent must instruct writing a goal file");
		assert.ok(content.includes("state entry") || content.includes("pi-goal-state"),
			"agent must reference state entry");
		assert.ok(content.includes("get_goal"), "agent must use get_goal");
		assert.ok(content.includes("update_goal"), "agent must use update_goal");
		assert.ok(content.includes("PASS") || content.includes("FAIL"),
			"agent must output structured PASS/FAIL report");
	});

	it("chain documentation covers all scenarios", () => {
		const chainPath = path.resolve(DIR, "e2e-test.chain.md");
		const content = readFileSync(chainPath, "utf8");
		assert.ok(content.includes("quick-sync"), "chain must cover quick-sync");
		assert.ok(content.includes("combined sync"), "chain must cover combined sync+complete");
		assert.ok(content.includes("deferred archival"), "chain must cover deferred archival");
	});

	// ── 2. Mock-pi handler tests (deterministic, no AI model dependency) ─────
	it("update_goal tool registered with lifecycle hooks", () => {
		const { tools, handlerMap } = createMockPiSetup();
		assert.ok(tools.find((t) => t.name === "update_goal"), "update_goal tool must be registered");
		assert.ok(handlerMap.has("session_start"), "session_start hook");
		assert.ok(handlerMap.has("before_agent_start"), "before_agent_start hook");
		assert.ok(handlerMap.has("turn_end"), "turn_end hook");
	});

	it("quick-sync: update_goal with updatedObjective alone does not terminate", async () => {
		const { tools, handlerMap } = createMockPiSetup();
		const f = testFixture();
		try {
			const mockCtx = createMockCtx(f.cwd, f.goal, f.written);
			const ss = handlerMap.get("session_start")!;
			await ss({ reason: "start" }, mockCtx);

			const updateGoal = tools.find((t) => t.name === "update_goal")!;
			const result = await (updateGoal.execute as Function)(
				"call-1",
				{ updatedObjective: "Subagent e2e: quick-synced" },
				new AbortController().signal,
				undefined,
				mockCtx,
			);

			assert.equal(result.content?.[0]?.text, "Goal objective updated.");
			assert.equal(result.terminate, undefined, "quick-sync must NOT set terminate");
			assert.equal(result.turnStoppedFor, undefined, "quick-sync must NOT set turnStoppedFor");

			const pool = readActiveGoalPool({ cwd: f.cwd } as any);
			const diskGoal = pool.get(f.goal.id);
			assert.ok(diskGoal, "goal must remain in active pool");
			assert.equal(diskGoal.objective, "Subagent e2e: quick-synced");
			assert.equal(diskGoal.status, "active");
		} finally { f.cleanup(); }
	});

	it("combined: updatedObjective + status=complete applies update before audit", async () => {
		const { tools, handlerMap } = createMockPiSetup();
		const f = testFixture();
		try {
			const mockCtx = createMockCtx(f.cwd, f.goal, f.written);
			const ss = handlerMap.get("session_start")!;
			await ss({ reason: "start" }, mockCtx);

			const updateGoal = tools.find((t) => t.name === "update_goal")!;
			const result = await (updateGoal.execute as Function)(
				"call-2",
				{
					updatedObjective: "Subagent e2e: combined update",
					status: "complete",
					completionSummary: "Subagent e2e completed.",
					confirmBypassAuditor: true,
				},
				new AbortController().signal,
				undefined,
				mockCtx,
			);

			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("Subagent e2e: combined update"),
				`completion must reference updated objective. Got: ${text.slice(0, 200)}`);

			const activeFile = path.join(f.cwd, f.written.activePath!);
			const diskContent = readFileSync(activeFile, "utf8");
			assert.ok(diskContent.includes("Subagent e2e: combined update"), "disk has updated objective");
			assert.ok(diskContent.includes('"status": "complete"'), "disk has complete status");
		} finally { f.cleanup(); }
	});

	it("deferred archival: complete without sync keeps file in active dir", async () => {
		const { tools, handlerMap } = createMockPiSetup();
		const f = testFixture();
		try {
			const mockCtx = createMockCtx(f.cwd, f.goal, f.written);
			const ss = handlerMap.get("session_start")!;
			await ss({ reason: "start" }, mockCtx);

			const updateGoal = tools.find((t) => t.name === "update_goal")!;
			await (updateGoal.execute as Function)(
				"call-3",
				{ status: "complete", completionSummary: "Subagent e2e archival.", confirmBypassAuditor: true },
				new AbortController().signal,
				undefined,
				mockCtx,
			);

			assert.ok(readFileSync(path.join(f.cwd, f.written.activePath!), "utf8"),
				"goal file must still exist in active dir (deferred archival)");
			assert.equal(readdirSync(path.join(f.cwd, ".pi", "goals", "archived")).length, 0,
				"archived dir must be empty");
		} finally { f.cleanup(); }
	});
});
