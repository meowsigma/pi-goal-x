#!/usr/bin/env node

/**
 * pi-goal deterministic e2e test runner.
 *
 * Tests:
 * 1. File-validity checks (agent file bootstrapping, chain docs)
 * 2. Mock-pi handler tests (extension loads, session_start, complete_goal handler)
 * 3. Real pi fork test using --mode json: reads tool_execution_start/end events
 *    from JSONL output for deterministic assertions on tool name, parameters,
 *    and result fields. Uses --append-system-prompt + --tools to ensure the AI
 *    model always calls the required tools (no non-determinism).
 *
 * Test 3 requires the `pi` CLI on PATH. It is skipped if unavailable.
 * Tests 1-2 are always available and deterministic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
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

// ── JSON event types ─────────────────────────────────────────────────────────

interface ToolExecStart {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

interface ToolExecEnd {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: {
		content?: Array<{ type: string; text?: string }>;
		details?: { version: number; goal: { objective?: string; status?: string; archivedPath?: string } };
		terminate?: boolean;
		turnStoppedFor?: string | null;
	};
}

/** Parse JSONL output for matching tool_execution_start/end event pairs. */
function findToolEvents(stdout: string): Array<{ start: ToolExecStart; end: ToolExecEnd }> {
	const events: Array<{ start: ToolExecStart; end: ToolExecEnd }> = [];
	const starts = new Map<string, ToolExecStart>();
	for (const line of stdout.split("\n").filter((l) => l.trim())) {
		try {
			const obj = JSON.parse(line);
			if (obj.type === "tool_execution_start") starts.set(obj.toolCallId, obj as ToolExecStart);
			else if (obj.type === "tool_execution_end") {
				const start = starts.get(obj.toolCallId);
				if (start) events.push({ start, end: obj as ToolExecEnd });
			}
		} catch { /* skip non-JSON lines */ }
	}
	return events;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPiAvailable(): boolean {
	try { return spawnSync("which", ["pi"], { encoding: "utf8", stdio: "pipe" }).status === 0; }
	catch { return false; }
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
	const stateEntry: GoalStateEntry = { version: 3, goal: { ...goal, activePath: written.activePath } };
	return {
		cwd, hasUI: false,
		sessionManager: {
			getBranch: () => [
				{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
				{ type: "custom", customType: "pi-goal-state", data: stateEntry },
			],
			getCwd: () => cwd, getSessionId: () => "test", getRoot: () => cwd, append: () => {},
			appendModelChange: () => {}, appendThinkingLevelChange: () => {}, appendCompetingWriteCheck: () => {},
			buildSessionContext: () => ({ messages: [], sessionId: "test", model: null, thinkingLevel: "medium" }),
		},
		getSystemPrompt: () => "", isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
	} as unknown as ExtensionContext;
}

function testFixture() {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-subagent-e2e-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disabled: true }));
	const goal = createGoal({ objective: "Subagent e2e: initial", autoContinue: true, sisyphus: false });
	const written = writeActiveGoalFile({ cwd } as any, goal as GoalRecord);
	return { cwd, goal: goal as GoalRecord, written, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

/** Create a workspace, session JSONL, and force-tool prompt for a deterministic fork test. */
function forkFixture(instruction: string): {
	cleanup: () => void;
	run: () => { stdout: string; stderr: string };
	cwd: string;
	goalId: string;
	activePath: string;
} {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-fork-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goalId = `mpme2e${Date.now().toString(36)}`;
	const now = new Date().toISOString();
	const sessionId = `test-${now.slice(-8)}`;
	const activePath = `.pi/goals/active_goal_${goalId}.md`;
	const goalData = {
		id: goalId, objective: "E2E fork test: initial", status: "active" as const,
		autoContinue: true, sisyphus: false, usage: { tokensUsed: 0, activeSeconds: 0 },
		createdAt: now, updatedAt: now, activePath,
	};
	writeFileSync(path.join(cwd, activePath), JSON.stringify(goalData) + "\n\n# Goal Prompt\n\nE2E fork test: initial\n");
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disabled: true }));
	const sessionFile = path.join(cwd, "session.jsonl");
	writeFileSync(sessionFile, [
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: now, cwd }),
		JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: now, provider: "opencode-go", modelId: "deepseek-v4-flash" }),
		JSON.stringify({ type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: now, thinkingLevel: "off" }),
		JSON.stringify({ type: "custom", customType: "pi-goal-focus", timestamp: now, data: { version: 1, focusedGoalId: goalId, reason: "created" } }),
		JSON.stringify({ type: "custom", customType: "pi-goal-state", timestamp: now, data: { version: 3, goal: goalData } }),
	].join("\n") + "\n");

	// System prompt that forces the model to always use tool calls
	const sysPromptFile = path.join(cwd, "force-tool.md");
	writeFileSync(sysPromptFile, "You must use the complete_goal tool to complete the request. Only respond using tool calls. Never output only text without making a tool call.");

	const run = () => {
		const result = spawnSync("pi", [
			"--mode", "json",
			"--no-extensions", "-e", EXT_PATH,
			"--tools", "get_goal,complete_goal",
			"--append-system-prompt", sysPromptFile,
			"--fork", sessionFile,
			"-p", instruction,
		], {
			cwd, encoding: "utf8", timeout: 120_000, stdio: "pipe",
			env: { ...process.env, PI_OFFLINE: "1", NODE_OPTIONS: "" },
		});
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};

	return {
		run,
		cwd,
		goalId,
		activePath,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
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
		assert.ok(content.includes("complete_goal"), "agent must use complete_goal");
		assert.ok(content.includes("PASS") || content.includes("FAIL"),
			"agent must output structured PASS/FAIL report");
	});

	it("chain documentation covers deferred archival scenario", () => {
		const chainPath = path.resolve(DIR, "e2e-test.chain.md");
		const content = readFileSync(chainPath, "utf8");
		assert.ok(content.includes("deferred archival"), "chain must cover deferred archival");
		assert.ok(!content.includes("quick-sync"), "chain must not cover quick-sync (removed)");
		assert.ok(!content.includes("combined sync"), "chain must not cover combined sync (removed)");
	});

	// ── 2. Mock-pi handler tests (deterministic, no AI model dependency) ─────
	it("complete_goal tool registered with lifecycle hooks", () => {
		const { tools, handlerMap } = createMockPiSetup();
		assert.ok(tools.find((t) => t.name === "complete_goal"), "complete_goal tool must be registered");
		assert.ok(handlerMap.has("session_start"), "session_start hook");
		assert.ok(handlerMap.has("before_agent_start"), "before_agent_start hook");
		assert.ok(handlerMap.has("turn_end"), "turn_end hook");
	});

	it("complete_goal rejects calls without status=complete", async () => {
		const { tools, handlerMap } = createMockPiSetup();
		const f = testFixture();
		try {
			const mockCtx = createMockCtx(f.cwd, f.goal, f.written);
			const ss = handlerMap.get("session_start")!;
			await ss({ reason: "start" }, mockCtx);
			const updateGoal = tools.find((t) => t.name === "complete_goal")!;
			await assert.rejects(
				() => (updateGoal.execute as Function)(
					"call-1",
					{},
					new AbortController().signal, undefined, mockCtx,
				),
				/status=complete/,
				"must reject with error mentioning status=complete"
			);
		} finally { f.cleanup(); }
	});

	it("complete_goal with status=complete still works (completion flow unchanged)", async () => {
		const { tools, handlerMap } = createMockPiSetup();
		const f = testFixture();
		try {
			const mockCtx = createMockCtx(f.cwd, f.goal, f.written);
			const ss = handlerMap.get("session_start")!;
			await ss({ reason: "start" }, mockCtx);
			const updateGoal = tools.find((t) => t.name === "complete_goal")!;
			const result = await (updateGoal.execute as Function)(
				"call-2",
				{ status: "complete", completionSummary: "Subagent e2e completed.", confirmBypassAuditor: true },
				new AbortController().signal, undefined, mockCtx,
			);
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("Goal complete"), "completion text must say Goal complete");
			const diskContent = readFileSync(path.join(f.cwd, f.written.activePath!), "utf8");
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
			const updateGoal = tools.find((t) => t.name === "complete_goal")!;
			await (updateGoal.execute as Function)(
				"call-3",
				{ status: "complete", completionSummary: "Subagent e2e archival.", confirmBypassAuditor: true },
				new AbortController().signal, undefined, mockCtx,
			);
			assert.ok(readFileSync(path.join(f.cwd, f.written.activePath!), "utf8"),
				"goal file must still exist in active dir (deferred archival)");
			assert.equal(readdirSync(path.join(f.cwd, ".pi", "goals", "archived")).length, 0,
				"archived dir must be empty");
		} finally { f.cleanup(); }
	});

	// ── 3. Real pi fork test (--mode json, fully deterministic) ─────────────
	// Uses --append-system-prompt + --tools to force the AI model to always
	// call the required tools. Parses tool_execution_start/end events from
	// JSONL output for structured field assertions — no free-text AI parsing.

	function assertToolEvents(stdout: string, toolName: string, callback: (events: Array<{ start: ToolExecStart; end: ToolExecEnd }>) => void) {
		const events = findToolEvents(stdout).filter((e) => e.start.toolName === toolName);
		assert.ok(events.length > 0, `fork output must contain at least one ${toolName} call`);
		callback(events);
	}

	it("fork: completion is the only valid complete_goal call now",
		{ skip: !isPiAvailable(), timeout: 120_000 }, async () => {
		const f = forkFixture(
			"Call get_goal first, then call complete_goal with status complete and confirmBypassAuditor true."
		);
		try {
			const result = f.run();
			assertToolEvents(result.stdout, "complete_goal", (events) => {
				const ev = events[0];
				assert.equal(ev.start.args.status, "complete",
					"args must contain status complete");
				assert.equal(ev.start.args.updatedObjective, undefined,
					"no updatedObjective should be passed (parameter removed)");
				const res = ev.end.result;
				assert.equal(res.details?.goal?.status, "complete",
					"result must show complete status");
			});
		} finally { f.cleanup(); }
	});

	// (removed — updatedObjective no longer exists in complete_goal schema)

	it("fork: deferred archival — complete without sync, result and filesystem",
		{ skip: !isPiAvailable(), timeout: 120_000 }, async () => {
		const f = forkFixture(
			"Call get_goal first, then call complete_goal with status complete and confirmBypassAuditor true."
		);
		try {
			const result = f.run();
			assertToolEvents(result.stdout, "complete_goal", (events) => {
				const ev = events[0];
				assert.equal(ev.start.args.status, "complete",
					"args must contain status complete");
				assert.equal(ev.start.args.updatedObjective, undefined,
					"no updatedObjective should be passed for plain completion");
				const res = ev.end.result;
				assert.equal(res.details?.goal?.status, "complete",
					"result must show complete status");
			});

			// Filesystem verification: the goal file must exist on disk after the fork.
			// The fork session may have archived it via turn_end, so check both
			// active and archived directories.
			const activeFile = path.join(f.cwd, f.activePath);
			const archivedDir = path.join(f.cwd, ".pi", "goals", "archived");
			let fileFound = false;
			try { fileFound = readFileSync(activeFile, "utf8").length > 0; } catch {}
			if (!fileFound) {
				const archives = readdirSync(archivedDir).filter((n) => n.includes(f.goalId));
				fileFound = archives.length > 0;
			}
			assert.ok(fileFound,
				`goal file must exist on disk after fork (active or archived).\n` +
				`Active: ${activeFile}\nArchived: ${readdirSync(archivedDir).length} files`);
		} finally { f.cleanup(); }
	});

	it("fork: propose_goal_tweak rejects without /goal-tweak drafting flow",
		{ skip: !isPiAvailable(), timeout: 120_000 }, async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-tweak-fork-"));
		try {
			mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
			const goalId = `mptweak${Date.now().toString(36)}`;
			const now = new Date().toISOString();
			const sessionId = `test-${now.slice(-8)}`;
			const activePath = `.pi/goals/active_goal_${goalId}.md`;
			const goalData = {
				id: goalId, objective: "E2E fork tweak test: initial", status: "active" as const,
				autoContinue: true, sisyphus: false, usage: { tokensUsed: 0, activeSeconds: 0 },
				createdAt: now, updatedAt: now, activePath,
			};
			writeFileSync(path.join(cwd, activePath), JSON.stringify(goalData) + "\n\n# Goal Prompt\n\nE2E fork tweak test\n");
			writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ disabled: true }));
			const sessionFile = path.join(cwd, "session.jsonl");
			writeFileSync(sessionFile, [
				JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: now, cwd }),
				JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: now, provider: "opencode-go", modelId: "deepseek-v4-flash" }),
				JSON.stringify({ type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: now, thinkingLevel: "off" }),
				JSON.stringify({ type: "custom", customType: "pi-goal-focus", timestamp: now, data: { version: 1, focusedGoalId: goalId, reason: "created" } }),
				JSON.stringify({ type: "custom", customType: "pi-goal-state", timestamp: now, data: { version: 3, goal: goalData } }),
			].join("\n") + "\n");

			const sysPromptFile = path.join(cwd, "force-tweak.md");
			writeFileSync(sysPromptFile, "You must call propose_goal_tweak with newObjective and changeSummary. Only respond using tool calls. Never output only text without making a tool call.");

			const result = spawnSync("pi", [
				"--mode", "json",
				"--no-extensions", "-e", EXT_PATH,
				"--tools", "get_goal,propose_goal_tweak",
				"--append-system-prompt", sysPromptFile,
				"--fork", sessionFile,
				"-p", "Call propose_goal_tweak with newObjective='Updated' and changeSummary='test'.",
			], {
				cwd, encoding: "utf8", timeout: 120_000, stdio: "pipe",
				env: { ...process.env, PI_OFFLINE: "1", NODE_OPTIONS: "" },
			});
			const stdout = result.stdout ?? "";
			const stderr = result.stderr ?? "";

			const events = findToolEvents(stdout).filter((e) => e.start.toolName === "propose_goal_tweak");
			assert.ok(events.length > 0,
				`fork output must contain at least one propose_goal_tweak call.\n` +
				`stdout: ${stdout.substring(0, 1000)}\nstderr: ${stderr.substring(0, 500)}`);

			const ev = events[0];
			const res = ev.end.result;
			const contentText = res.content?.map((c: { text?: string }) => c.text ?? "").join(" ") ?? "";
			assert.ok(
				contentText.includes("REJECTED") || contentText.includes("no /goal-tweak drafting flow"),
				`propose_goal_tweak must be rejected without /goal-tweak flow. Got: ${contentText}`
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
