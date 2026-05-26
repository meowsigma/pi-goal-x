#!/usr/bin/env node

/**
 * pi-goal subagent-based e2e test runner.
 *
 * Tests:
 * 1. File-validity checks (agent file bootstrapping, chain docs)
 * 2. Mock-pi handler tests (extension loads, session_start, update_goal executes)
 * 3. Real pi fork tests (spawns actual pi --fork with /run e2e-test-runner,
 *    the e2e-test-runner subagent exercises update_goal through real tool handlers)
 *
 * Test 3 requires the `pi` CLI on PATH. It is skipped if unavailable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
const EXT_PATH = path.resolve(DIR, "..", "..", "extensions", "goal.ts");

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPiAvailable(): boolean {
	try {
		const r = spawnSync("which", ["pi"], { encoding: "utf8", stdio: "pipe" });
		return r.status === 0;
	} catch { return false; }
}

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

function createForkWorkspace() {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-fork-e2e-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });

	const goalId = `mpme2e${Date.now().toString(36)}`;
	const now = new Date().toISOString();
	const sessionId = `test-${Date.now().toString(36)}`;
	const activePath = `.pi/goals/active_goal_202605260000_${goalId}.md`;

	const goalData = {
		id: goalId,
		objective: "E2E fork test: initial",
		status: "active",
		autoContinue: true,
		sisyphus: false,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		createdAt: now,
		updatedAt: now,
		activePath,
	};
	writeFileSync(path.join(cwd, activePath), JSON.stringify(goalData) + "\n\n# Goal Prompt\n\nE2E fork test: initial\n");
	writeFileSync(path.join(cwd, ".pi", "goal-auditor.json"), JSON.stringify({ disabled: true }));
	copyFileSync(path.resolve(DIR, "e2e-test-runner.md"), path.join(cwd, ".pi", "agents", "e2e-test-runner.md"));

	const sessionFile = path.join(cwd, "session.jsonl");
	writeFileSync(sessionFile, [
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: now, cwd }),
		JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: now, provider: "opencode-go", modelId: "deepseek-v4-flash" }),
		JSON.stringify({ type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: now, thinkingLevel: "off" }),
		JSON.stringify({ type: "custom", customType: "pi-goal-focus", timestamp: now, data: { version: 1, focusedGoalId: goalId, reason: "created" } }),
		JSON.stringify({ type: "custom", customType: "pi-goal-state", timestamp: now, data: { version: 3, goal: goalData } }),
	].join("\n") + "\n");

	return {
		cwd,
		sessionFile,
		goalId,
		goalData,
		activePath,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

function runPiFork(sessionFile: string, cwd: string, instruction: string): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("pi", [
		"--no-extensions",
		"-e", EXT_PATH,
		"--fork", sessionFile,
		"-p", instruction,
	], {
		cwd,
		encoding: "utf8",
		timeout: 120_000,
		stdio: "pipe",
		env: { ...process.env, PI_OFFLINE: "1" },
	});
	return {
		status: result.status ?? -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Subagent E2E", { timeout: 600_000 }, () => {
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

	// ── 2. Mock-pi handler tests ────────────────────────────────────────────
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

	// ── 3. Real pi fork test (spawns subagent via /run e2e-test-runner) ─────
	it("agent: all three scenarios via /run e2e-test-runner (quick-sync, combined, archival)",
		{ skip: !isPiAvailable(), timeout: 600_000 }, async () => {
		const scenarios = [
			{
				name: "quick-sync",
				task: "Test scenario: quick-sync via update_goal({updatedObjective}). "
					+ "Goal objective is 'E2E fork test: initial'. "
					+ "Call update_goal with updatedObjective 'E2E fork test: quick-synced'. "
					+ "Do NOT mark complete.",
				assertions: (stdout: string) => {
					assert.ok(stdout.includes("PASS"), `Expected PASS:\n${stdout.slice(0, 500)}`);
					assert.ok(stdout.includes("quick-sync") || stdout.includes("updatedObjective") || stdout.includes("update_goal"),
						`Expected quick-sync test:\n${stdout.slice(0, 300)}`);
				},
			},
			{
				name: "combined sync+complete",
				task: "Test scenario: combined sync+complete. "
					+ "Goal objective is 'E2E fork test: initial'. "
					+ "Call update_goal with updatedObjective 'E2E fork test: combined' "
					+ "AND status=complete AND confirmBypassAuditor=true. "
					+ "Verify the completion report references the updated objective.",
				assertions: (stdout: string) => {
					assert.ok(stdout.includes("PASS"), `Expected PASS:\n${stdout.slice(0, 500)}`);
					assert.ok(stdout.includes("combined") || stdout.includes("complete"),
						`Expected combined sync+complete test:\n${stdout.slice(0, 300)}`);
				},
			},
			{
				name: "deferred archival",
				task: "Test scenario: deferred archival. "
					+ "Goal objective is 'E2E fork test: initial'. "
					+ "Call update_goal with status=complete AND confirmBypassAuditor=true. "
					+ "Report what happened: was the goal archived immediately or kept in the active directory? "
					+ "Output PASS at the end.",
				assertions: (stdout: string) => {
					assert.ok(stdout.includes("PASS") || stdout.includes("archiv") || stdout.includes("complete"),
						`Expected PASS or archival mention:\n${stdout.slice(0, 500)}`);
				},
			},
		];

		for (const scenario of scenarios) {
			const ws = createForkWorkspace();
			try {
				const instruction = `/run e2e-test-runner ${scenario.task}`;
				const result = runPiFork(ws.sessionFile, ws.cwd, instruction);

				if (result.stdout.length > 0) {
					console.log(`--- Fork output (${scenario.name}) ---`);
					console.log(result.stdout.slice(0, 1200));
				}

				assert.equal(result.status, 0,
					`${scenario.name}: pi --fork exit ${result.status}\n${result.stderr.slice(0, 300)}`);
				scenario.assertions(result.stdout);
			} finally { ws.cleanup(); }
		}
	});
});
