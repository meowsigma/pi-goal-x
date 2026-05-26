import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	buildGoalAuditorPrompt,
	goalAuditorConfigPath,
	loadGoalAuditorConfig,
	loadGoalAuditorFileConfig,
	parseAuditorDecision,
	parseGoalAuditorConfig,
	runGoalCompletionAuditor,
	saveGoalAuditorFileConfig,
} from "../extensions/goal-auditor.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g1",
		objective: "Write a complete tutorial, not just a scaffold.",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-05-12T00:00:00.000Z",
		updatedAt: "2026-05-12T00:00:00.000Z",
		...overrides,
	};
}

test("parseAuditorDecision requires explicit approval and lets disapproval win", () => {
	assert.deepEqual(parseAuditorDecision("Looks good\n<approved/>"), { approved: true, disapproved: false });
	assert.deepEqual(parseAuditorDecision("Nope\n<disapproved/>"), { approved: false, disapproved: true });
	assert.deepEqual(parseAuditorDecision("confused <approved/> <disapproved/>"), { approved: false, disapproved: true });
	assert.deepEqual(parseAuditorDecision("no marker"), { approved: false, disapproved: false });
});

test("parseGoalAuditorConfig supports provider/model and thinking_level aliases", () => {
	assert.deepEqual(parseGoalAuditorConfig({ provider: "fireworks", model: "accounts/fireworks/routers/kimi", thinking_level: "high" }), {
		provider: "fireworks",
		model: "accounts/fireworks/routers/kimi",
		thinkingLevel: "high",
	});
	assert.deepEqual(parseGoalAuditorConfig({ provider: " ", model: 123, thinkingLevel: "ludicrous" }), {});
});

test("parseGoalAuditorConfig reads disabled flag", () => {
	assert.deepEqual(parseGoalAuditorConfig({ disabled: true }), { disabled: true });
	assert.deepEqual(parseGoalAuditorConfig({ disabled: "true" }), { disabled: true });
	assert.deepEqual(parseGoalAuditorConfig({ disabled: false }), {});
	assert.deepEqual(parseGoalAuditorConfig({}), {});
});

test("saveGoalAuditorFileConfig persists UI-editable auditor settings", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const saved = saveGoalAuditorFileConfig(cwd, {
			provider: "fireworks",
			model: "accounts/fireworks/routers/kimi",
			thinkingLevel: "high",
		});
		assert.deepEqual(saved, {
			provider: "fireworks",
			model: "accounts/fireworks/routers/kimi",
			thinkingLevel: "high",
		});
		assert.equal(goalAuditorConfigPath(cwd), path.join(cwd, ".pi", "goal-auditor.json"));
		assert.deepEqual(loadGoalAuditorFileConfig(cwd), saved);
		assert.match(fs.readFileSync(goalAuditorConfigPath(cwd), "utf8"), /"thinking_level": "high"/);

		// Save with disabled flag
		const saved2 = saveGoalAuditorFileConfig(cwd, {
			provider: "fireworks",
			model: "accounts/fireworks/routers/kimi",
			thinkingLevel: "high",
			disabled: true,
		});
		assert.equal(saved2.disabled, true);
		assert.match(fs.readFileSync(goalAuditorConfigPath(cwd), "utf8"), /"disabled": true/);
		assert.deepEqual(loadGoalAuditorFileConfig(cwd), saved2);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadGoalAuditorConfig merges env and file config", () => {
	assert.equal(loadGoalAuditorConfig("/tmp", { PI_GOAL_AUDITOR_PROVIDER: "fireworks", PI_GOAL_AUDITOR_MODEL: "kimi" }).provider, "fireworks");
	// disabled is file-only, not read from env
	assert.equal(loadGoalAuditorConfig("/tmp", { PI_GOAL_AUDITOR_DISABLED: "true" }).disabled, undefined);
});

test("buildGoalAuditorPrompt demands semantic approval markers", () => {
	const prompt = buildGoalAuditorPrompt({
		goal: goal(),
		completionSummary: "Generated a VitePress scaffold and build passes.",
		detailedSummary: "Goal: tutorial",
	});
	assert.ok(prompt.includes("independent completion auditor"));
	assert.ok(prompt.includes("scaffold-only") || prompt.includes("alpha scaffold") || prompt.includes("generated template"));
	assert.ok(prompt.includes("<approved/>"));
	assert.ok(prompt.includes("<disapproved/>"));
	assert.ok(prompt.includes("Generated a VitePress scaffold"));
	assert.ok(!prompt.includes("<test_evidence>"), "should not contain <test_evidence> without testResults");
	assert.ok(prompt.includes("3. Explain missing or weak evidence"));
	assert.ok(prompt.includes("4. End with exactly <approved/>"));
});
test("buildGoalAuditorPrompt renders test evidence block when testResults provided", () => {
	const prompt = buildGoalAuditorPrompt({
		goal: goal(),
		completionSummary: "All tests pass.",
		detailedSummary: "Goal: test",
		testResults: {
			exitCode: 0,
			suiteName: "npm test",
			output: "1..123\n# tests 123\n# pass 123\n# fail 0",
			timestamp: "2026-05-26T12:42:00.000Z",
		},
	});
	assert.ok(prompt.includes("<test_evidence>"));
	assert.ok(prompt.includes("Suite: npm test"));
	assert.ok(prompt.includes("Exit code: 0"));
	assert.ok(prompt.includes("2026-05-26T12:42:00.000Z"));
	assert.ok(prompt.includes("Output:"));
	assert.ok(prompt.includes("1..123"));
	assert.ok(prompt.includes("# tests 123"));
	assert.ok(prompt.includes("# pass 123"));
	assert.ok(prompt.includes("# fail 0"));
	assert.ok(prompt.includes("</test_evidence>"));
	assert.ok(prompt.includes("3. Before running a test suite with bash, check the <test_evidence> block"));
	assert.ok(prompt.includes("5. End with exactly <approved/>"));
});
test("buildGoalAuditorPrompt handles minimal testResults (only exitCode)", () => {
	const prompt = buildGoalAuditorPrompt({
		goal: goal(),
		completionSummary: "Tests passed.",
		detailedSummary: "Goal: test",
		testResults: {
			exitCode: 0,
		},
	});
	assert.ok(prompt.includes("<test_evidence>"));
	assert.ok(prompt.includes("Suite: (not specified)"));
	assert.ok(prompt.includes("Exit code: 0"));
	assert.ok(prompt.includes("Timestamp: (not specified)"));
	assert.ok(prompt.includes("(none provided)"));
	assert.ok(prompt.includes("</test_evidence>"));
});
test("buildGoalAuditorPrompt omits test evidence block when testResults is null", () => {
	const prompt = buildGoalAuditorPrompt({
		goal: goal(),
		completionSummary: "Done.",
		detailedSummary: "Goal: test",
		testResults: null,
	});
	assert.ok(!prompt.includes("<test_evidence>"), "should not contain <test_evidence> when testResults is null");
	assert.ok(prompt.includes("3. Explain missing or weak evidence"));
	assert.ok(prompt.includes("4. End with exactly <approved/>"));
});
test("buildGoalAuditorPrompt checklist instructs auditor to check test evidence before re-running tests", () => {
	const prompt = buildGoalAuditorPrompt({
		goal: goal(),
		completionSummary: "Everything passes.",
		detailedSummary: "Goal: test",
		testResults: {
			exitCode: 0,
			suiteName: "npm test",
		},
	});
	assert.ok(prompt.includes("Before running a test suite with bash"));
	assert.ok(prompt.includes("check the <test_evidence> block"));
	assert.ok(prompt.includes("accept them as evidence rather than re-running"));
});
test("buildGoalAuditorPrompt testResults with multi-line output indented correctly", () => {
	const prompt = buildGoalAuditorPrompt({
		goal: goal(),
		completionSummary: "Suite passes.",
		detailedSummary: "Goal: test",
		testResults: {
			exitCode: 0,
			output: "line 1\nline 2\nline 3",
		},
	});
	// Output lines must be indented inside the <test_evidence> block
	assert.match(prompt, /Output:/);
	assert.match(prompt, /    line 1/);
	assert.match(prompt, /    line 2/);
	assert.match(prompt, /    line 3/);
	// Ensure each output line is prefixed with 4 spaces inside <test_evidence>
	assert.doesNotMatch(prompt, /Output:\nline 1/);
});

test("buildGoalAuditorPrompt testResults with non-passing exit code is still rendered", () => {
	const prompt = buildGoalAuditorPrompt({
		goal: goal(),
		completionSummary: "Tests failed.",
		detailedSummary: "Goal: test",
		testResults: {
			exitCode: 1,
			output: "1 failing",
		},
	});
	assert.match(prompt, /<test_evidence>/);
	assert.match(prompt, /Exit code: 1/);
	assert.match(prompt, /    1 failing/);
	// Step 3 instruction about checking evidence still present
	assert.match(prompt, /Before running a test suite with bash/);
});

test("runGoalCompletionAuditor returns aborted error when signal is already aborted (pre-flight)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const ctrl = new AbortController();
		ctrl.abort(); // Already aborted before call

		let abortCalledOnSession = false;
		const mockSession = {
			abort: () => { abortCalledOnSession = true; },
			subscribe: () => () => {},
			prompt: () => { throw new Error("prompt should not be called"); },
		};

		const result = await runGoalCompletionAuditor({
			ctx: { cwd, model: undefined } as any,
			goal: goal(),
			detailedSummary: "test",
			signal: ctrl.signal,
			createSession: async () => ({ session: mockSession }) as any,
		});

		assert.equal(result.error, "Auditor aborted.");
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.equal(result.output, "");
		// The signal listener for the already-aborted signal should have been
		// cleaned up in the inner finally before session.abort() could fire.
		assert.equal(abortCalledOnSession, false, "session.abort() should not be called for pre-flight abort");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("runGoalCompletionAuditor aborts running prompt when signal fires (abort during prompt)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const ctrl = new AbortController();
		let abortCalledOnSession = false;
		let promptReject: (e: Error) => void;

		const mockSession = {
			abort: () => {
				abortCalledOnSession = true;
				promptReject?.(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
			},
			subscribe: () => () => {},
			prompt: () => new Promise<void>((_, reject) => { promptReject = reject; }),
		};

		const resultPromise = runGoalCompletionAuditor({
			ctx: { cwd, model: undefined } as any,
			goal: goal(),
			detailedSummary: "test",
			signal: ctrl.signal,
			createSession: async () => ({ session: mockSession }) as any,
		});

		// Yield to let the async setup run (createSession resolves, prompt is entered)
		await new Promise((r) => setTimeout(r, 0));

		// At this point prompt() should be "running" — trigger the abort
		ctrl.abort();

		const result = await resultPromise;

		assert.equal(result.error, "Auditor aborted.");
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.ok(abortCalledOnSession, "session.abort() must have been called via the signal listener");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * Validate that when session.abort() DOES NOT throw (the real agent behavior),
 * the post-prompt signal check catches the abort and returns the expected
 * "Auditor aborted." error instead of treating it as a normal (empty) result.
 */
test("runGoalCompletionAuditor detects abort when session.prompt returns normally (no throw)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const ctrl = new AbortController();
		let abortCalledOnSession = false;
		let promptResolve: () => void;

		const mockSession = {
			abort: () => {
				abortCalledOnSession = true;
				// Real session.abort() calls agent.abort() then await waitForIdle().
				// The agent loop returns normally (no throw) with whatever output
				// was captured before the abort. Simulate that by resolving prompt.
				promptResolve?.();
			},
			subscribe: () => () => {},
			prompt: () => new Promise<void>((resolve) => { promptResolve = resolve; }),
		};

		const resultPromise = runGoalCompletionAuditor({
			ctx: { cwd, model: undefined } as any,
			goal: goal(),
			detailedSummary: "test",
			signal: ctrl.signal,
			createSession: async () => ({ session: mockSession }) as any,
		});

		// Yield to let createSession resolve
		await new Promise((r) => setTimeout(r, 0));

		// Abort while prompt is still running — this triggers abortSession listener
		// which calls session.abort(), which resolves the prompt.
		ctrl.abort();

		const result = await resultPromise;

		assert.equal(result.error, "Auditor aborted.");
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.ok(abortCalledOnSession, "session.abort() must have been called via the signal listener");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * Verify that the abort signal listener is properly cleaned up after a normal
 * (non-aborted) audit run resolves, preventing memory leaks.
 */
test("runGoalCompletionAuditor cleans up abort listener on normal completion", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const ctrl = new AbortController();
		let abortCalledOnSession = false;

		const mockSession = {
			abort: () => { abortCalledOnSession = true; },
			subscribe: () => () => {},
			prompt: async () => {
				// Simulate a normal prompt that completes without abort
			},
		};

		const result = await runGoalCompletionAuditor({
			ctx: { cwd, model: undefined } as any,
			goal: goal(),
			detailedSummary: "test",
			signal: ctrl.signal,
			createSession: async () => ({ session: mockSession }) as any,
		});

		// Normal completion — no abort occurred, no approval/disapproval markers
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, false); // Empty output has no disapproval marker
		assert.equal(result.error, undefined); // No error
		assert.equal(abortCalledOnSession, false, "session.abort() should not have been called");

		// Also verify the signal listener was cleaned up: triggering the signal after
		// completion should NOT call session.abort()
		ctrl.abort();
		assert.equal(abortCalledOnSession, false, "session.abort() should not fire after cleanup");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
