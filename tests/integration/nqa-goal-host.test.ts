import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createGoal, goalFocusDetails } from "../../extensions/goal-record.ts";
import { activePathForGoal, invalidateGoalPoolCache, readActiveGoalFiles, writeActiveGoalFile } from "../../extensions/storage/goal-files.ts";

const NQA_SOURCE = process.env.PI_NQA_EXTENSION_PATH;

function resolveHostPiAiEntry(codingAgentEntry: string): string {
	const hostRequire = createRequire(codingAgentEntry);
	for (const searchPath of hostRequire.resolve.paths("@earendil-works/pi-ai") ?? []) {
		const packageRoot = path.join(searchPath, "@earendil-works", "pi-ai");
		const packageJsonPath = path.join(packageRoot, "package.json");
		if (!existsSync(packageJsonPath)) continue;
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { exports?: { "."?: { import?: string } }; main?: string };
		const entry = packageJson.exports?.["."]?.import ?? packageJson.main;
		if (typeof entry === "string") return path.resolve(packageRoot, entry);
	}
	throw new Error(`Could not resolve pi-ai relative to selected host ${codingAgentEntry}`);
}

test("host-loaded pi-goal-x and NQA preserve audit ownership in both loader orders", async (t) => {
	if (!NQA_SOURCE || !existsSync(NQA_SOURCE)) {
		t.skip("actual NQA source is unavailable; set PI_NQA_EXTENSION_PATH to the checked-out extension for host-loader coverage");
		return;
	}
	for (const order of ["goal-first", "nqa-first"] as const) {
		const cwd = mkdtempSync(path.join("/tmp", `pi-goal-nqa-host-${order}-`));
		try {
			mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
			writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ provider: "missing-provider", model: "missing-model" }));
			const goal = writeActiveGoalFile({ cwd }, {
				...createGoal({ objective: "Host-loaded NQA goal", autoContinue: true, sisyphus: false }, Date.now()),
				taskList: {
					tasks: [{ id: "independent", title: "Independent work", status: "pending" as const }],
					blockCompletion: false,
					proposedAt: new Date().toISOString(),
				},
			});
			const sessionEntries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
			const first = await loadHost(cwd, sessionEntries, order);
			const nqaCommand = first.extensions.flatMap((extension: any) => [...extension.commands.values()]).find((command: any) => command.name === "no-questions-asked");
			assert.ok(nqaCommand, `${order}: actual NQA command loaded through the host loader`);
			await first.emit({ type: "session_start", reason: "start" });
			await nqaCommand.handler("", first.ctx);

			const initialPrompt = await first.before("user request", "interactive");
			assert.match(initialPrompt, /NO-QUESTIONS-ASKED MODE: ON/);
			assert.match(initialPrompt, /\[NO-QUESTIONS ACTIVE-GOAL RECOVERY\]/, `${order}: specialized NQA reinforcement is present`);
			assert.match(initialPrompt, /materially different safe route/, `${order}: reinforcement directs a concrete pivot`);
			assert.match(initialPrompt, /productive tool work rather than repeating status text/, `${order}: reinforcement requires work rather than restatement`);
			assert.doesNotMatch(initialPrompt, /Do not perform substantive work/, `${order}: ordinary ACTIVE must not inherit a wait prohibition`);
			assert.match(initialPrompt, /PI GOAL ACTIVE/);
			const goalTool = first.goalExtension.tools.get("update_goal")?.definition;
			assert.ok(goalTool, `${order}: actual goal-x update_goal loaded through the host loader`);
			const firstResult = await (goalTool.execute as any)("host-audit-1", { status: "complete" }, undefined, undefined, first.ctx);
			assert.match(firstResult.content[0].text, /Goal audit unavailable/);

			// A generated extension-originated NQA wake is owned by the active goal;
			// it cannot reset admission or create a competing continuation after the
			// infrastructure failure.
			await first.emitInput("NQA generated followup", "extension");
			const generatedPrompt = await first.before("NQA generated followup", "extension");
			assert.match(generatedPrompt, /NO-QUESTIONS-ASKED MODE: ON/);
			assert.match(generatedPrompt, /PI GOAL ACTIVE/);
			await first.emit({ type: "agent_start" });
			await first.emit({ type: "tool_call", toolName: "update_goal", toolCallId: "host-audit-2", input: { status: "complete" } });
			const denied = await (goalTool.execute as any)("host-audit-2", { status: "complete" }, undefined, undefined, first.ctx);
			await first.emit({ type: "tool_execution_end", toolName: "update_goal", toolCallId: "host-audit-2", result: denied });
			assert.match(denied.content[0].text, /independently actionable work|cooling down|exhausted/);
			await first.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn" }] });
			await first.emit({ type: "agent_settled" });
			await new Promise((resolve) => setTimeout(resolve, 10));
			const followUps = first.sentMessages.filter((message: any) => message?.customType !== "pi-goal-audit-event");
			assert.equal(followUps.length, 1, `${order}: exactly one goal recovery checkpoint is dispatched`);
			assert.match(String((followUps[0] as any)?.content), /pi_goal_continuation/);
			const recoveryPrompt = await first.before(String((followUps[0] as any)?.content ?? "queued recovery"), "extension");
			assert.match(recoveryPrompt, /NO-QUESTIONS-ASKED MODE: ON/);
			assert.match(recoveryPrompt, /PI GOAL ACTIVE/);
			assert.match(recoveryPrompt, /AUDIT RECOVERY PIVOT/);

			// Genuine interactive input clears admission and writes the durable reset.
			await first.emitInput("user retry", "interactive");
			await first.before("user retry", "interactive");
			const retryResult = await (goalTool.execute as any)("host-audit-3", { status: "complete" }, undefined, undefined, first.ctx);
			assert.match(retryResult.content[0].text, /Goal audit unavailable/);

			const reloaded = await loadHost(cwd, sessionEntries, order);
			await reloaded.emit({ type: "session_start", reason: "start" });
			await reloaded.before("NQA reload wake", "extension");
			const reloadedTool = reloaded.goalExtension.tools.get("update_goal")?.definition;
			assert.ok(reloadedTool);
			const reloadResult = await (reloadedTool.execute as any)("host-audit-4", { status: "complete" }, undefined, undefined, reloaded.ctx);
			assert.match(reloadResult.content[0].text, /cooling down|exhausted/, `${order}: post-reset failure survives reload`);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});

test("direct update_goal completion sends later user decisions to the real auditor", async () => {
	const cwd = mkdtempSync(path.join("/tmp", "pi-goal-direct-audit-decisions-"));
	try {
		mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
		const goal = writeActiveGoalFile({ cwd }, {
			...createGoal({ objective: "Complete the direct audit goal", autoContinue: true, sisyphus: false }, Date.now()),
			verificationContract: "The final artifact must be independently verified.",
		});
		const sessionEntries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
		writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ provider: "direct-audit-faux", model: "direct-audit-model" }));
		const host = await loadHost(cwd, sessionEntries, "goal-first", false);
		const hostRoot = process.env.PI_HOST_PACKAGE_ROOT ?? path.resolve("node_modules");
		const codingAgentEntry = path.join(hostRoot, "@earendil-works/pi-coding-agent/dist/index.js");
		const codingAgent = await import(pathToFileURL(codingAgentEntry).href);
		const piAi = await import(pathToFileURL(resolveHostPiAiEntry(codingAgentEntry)).href);
		const faux = piAi.fauxProvider({ provider: "direct-audit-faux", api: "direct-audit-api", models: [{ id: "direct-audit-model", reasoning: false }] });
		const modelRuntime = await codingAgent.ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
		modelRuntime.registerNativeProvider(faux.provider);
		const model = faux.getModel();
		let auditPrompt = "";
		faux.setResponses([(context: { messages?: Array<{ role?: string; content?: unknown }> }) => {
			const userMessage = [...(context.messages ?? [])].reverse().find((message) => message.role === "user");
			auditPrompt = typeof userMessage?.content === "string" ? userMessage.content : JSON.stringify(userMessage?.content ?? "");
			return piAi.fauxAssistantMessage("The artifact is verified.\n<approved/>", { stopReason: "stop" });
		}]);
		(host.ctx as any).model = model;
		(host.ctx as any).modelRegistry = { runtime: modelRuntime, getAvailable: () => [model], find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined };
		await host.emit({ type: "session_start", reason: "start" });
		await host.before("Later user restriction: do not publish until the artifact is independently reviewed.", "interactive");
		const goalTool = host.goalExtension.tools.get("update_goal")?.definition;
		assert.ok(goalTool);
		const result = await (goalTool.execute as any)("direct-audit", { status: "complete" }, undefined, undefined, host.ctx);
		assert.match(String(result.content[0]?.text ?? ""), /complete/i);
		assert.match(auditPrompt, /<user_decisions>/, "direct completion uses the dedicated decision section");
		assert.match(auditPrompt, /\[user interactive\] Later user restriction/, "direct completion preserves decision provenance");
		assert.match(auditPrompt, /do not publish until the artifact is independently reviewed/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("real entrypoint settles two empty cycles into SDK review, task verification, audit, and archive", async () => {
	const cwd = mkdtempSync(path.join("/tmp", "pi-goal-real-review-"));
	try {
		mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
		const artifact = path.join(cwd, "evidence.txt");
		writeFileSync(artifact, "real fake-provider evidence\\n");
		const goal = writeActiveGoalFile({ cwd }, {
			...createGoal({ objective: "Complete the reviewed integration goal", autoContinue: true, sisyphus: false }, Date.now()),
			taskList: {
				blockCompletion: true,
				proposedAt: new Date().toISOString(),
				tasks: [{ id: "parent", title: "Parent verification", status: "pending", verificationContract: "Evidence must come from the check.", subtasks: [{ id: "child", title: "Read the evidence", status: "pending", verificationContract: "Read evidence.txt." }] }],
			},
		});
		const sessionEntries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
		writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ provider: "review-entrypoint-faux", model: "review-entrypoint-model" }));
		const host = await loadHost(cwd, sessionEntries, "goal-first", false);
		const hostRoot = process.env.PI_HOST_PACKAGE_ROOT ?? path.resolve("node_modules");
		const codingAgentEntry = path.join(hostRoot, "@earendil-works/pi-coding-agent/dist/index.js");
		const codingAgent = await import(pathToFileURL(codingAgentEntry).href);
		const piAi = await import(pathToFileURL(resolveHostPiAiEntry(codingAgentEntry)).href);
		const faux = piAi.fauxProvider({ provider: "review-entrypoint-faux", api: "review-entrypoint-api", models: [{ id: "review-entrypoint-model", reasoning: false }] });
		const modelRuntime = await codingAgent.ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
		modelRuntime.registerNativeProvider(faux.provider);
		const model = faux.getModel();
		let reviewerSubmissionCalls = 0;
		let completionAuditPrompt = "";
		faux.setResponses([
			piAi.fauxAssistantMessage(piAi.fauxToolCall("read", { path: artifact }), { stopReason: "toolUse" }),
			(context: { tools?: Array<{ name: string }> }) => {
				reviewerSubmissionCalls += 1;
				assert.ok(context.tools?.some((tool) => tool.name === "read"), "reviewer used the isolated read tool profile");
				return piAi.fauxAssistantMessage(piAi.fauxToolCall("submit_goal_progress_review", {
					disposition: "audit",
					summary: "The evidence was read and both contracts are satisfied.",
					nextAction: "Run the independent completion audit.",
					evidence: ["evidence.txt was read through the isolated reviewer."],
					completedTasks: [
						{ taskId: "child", evidence: "evidence.txt contains the required check result." },
						{ taskId: "parent", evidence: "The verified child satisfies the parent contract." },
					],
				}), { stopReason: "toolUse" });
			},
			(context: { messages?: Array<{ role?: string; content?: unknown }> }) => {
				const userMessage = [...(context.messages ?? [])].reverse().find((message) => message.role === "user");
				completionAuditPrompt = typeof userMessage?.content === "string" ? userMessage.content : JSON.stringify(userMessage?.content ?? "");
				return piAi.fauxAssistantMessage("Independent audit complete.\n<approved/>", { stopReason: "stop" });
			},
			...Array.from({ length: 7 }, () => piAi.fauxAssistantMessage("Independent audit complete.\n<approved/>", { stopReason: "stop" })),
		]);
		(host.ctx as any).model = model;
		(host.ctx as any).modelRegistry = { runtime: modelRuntime, getAvailable: () => [model], find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined };
		await host.emit({ type: "session_start", reason: "start" });
		const emptyCycle = async () => {
			await host.before("continue", "extension");
			await host.emit({ type: "agent_start" });
			await host.emit({ type: "turn_start" });
			await host.emit({ type: "turn_end" });
			await host.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn" }] });
			await host.emit({ type: "agent_settled" });
		};
		await emptyCycle();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(readdirSync(path.join(cwd, ".pi", "goals", "archived")).length, 0);
		const checkpointsAfterFirst = host.sentMessages.filter((message: any) => String(message.content ?? "").includes("pi_goal_continuation")).length;
		await host.emitInput("Earlier user restriction: do not publish until the external review is complete.", "interactive");
		await host.emitInput("Superseding RPC restriction: do not publish until security signoff.", "rpc");
		// Consume the real input provenance before resuming automatic cycles; the
		// next two settled empty runs then reach the review threshold.
		await host.before("resume automatic work", "extension");
		await emptyCycle();
		await emptyCycle();
		assert.equal(reviewerSubmissionCalls, 1, "the automatically invoked reviewer submitted through the real provider");
		assert.match(completionAuditPrompt, /<user_decisions>/, "final auditor receives a dedicated decision section");
		assert.match(completionAuditPrompt, /\[user interactive\] Earlier user restriction/, "earlier decision keeps source provenance");
		assert.match(completionAuditPrompt, /\[user rpc\] Superseding RPC restriction/, "superseding decision keeps source provenance");
		assert.equal(readdirSync(path.join(cwd, ".pi", "goals", "archived")).length, 1, "approved audit archives during settled review");
		assert.equal(existsSync(activePathForGoal({ cwd }, goal)), false, "no active goal remains");
		assert.equal(host.sentMessages.filter((message: any) => String(message.content ?? "").includes("pi_goal_continuation")).length, checkpointsAfterFirst, "archival did not require a later executor turn");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("host-loaded scheduled waits preserve status input and resume once in both NQA orders", async (t) => {
	if (!NQA_SOURCE || !existsSync(NQA_SOURCE)) {
		t.skip("actual NQA source is unavailable; set PI_NQA_EXTENSION_PATH to the checked-out extension for host-loader coverage");
		return;
	}
	for (const order of ["goal-first", "nqa-first"] as const) {
		const cwd = mkdtempSync(path.join("/tmp", `pi-goal-nqa-wait-${order}-`));
		try {
			mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
			const wakeAt = new Date(Date.now() + 100).toISOString();
			const goal = writeActiveGoalFile({ cwd }, {
				...createGoal({ objective: "Host-loaded scheduled wait", autoContinue: true, sisyphus: false }, Date.now()),
				continuation: {
					scope: "wait-scope",
					instruction: "Recheck the external dependency and continue the pending task.",
					executionRetries: 0,
					reviewFailures: 0,
					wake: { id: `wait-${order}`, at: wakeAt, kind: "external_wait", reason: "external dependency not ready", evidence: ["the dependency reported pending"] },
				},
			});
			const sessionEntries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
			const host = await loadHost(cwd, sessionEntries, order);
			const nqaCommand = host.extensions.flatMap((extension: any) => [...extension.commands.values()]).find((command: any) => command.name === "no-questions-asked");
			assert.ok(nqaCommand, `${order}: actual NQA command is available`);
			await nqaCommand.handler("", host.ctx);
			await host.emit({ type: "session_start", reason: "start" });
			const before = host.sentMessages.length;
			for (const query of ["Do not change the goal", "Did the goal change?", "Please do not resume the goal", "What does /goal-resume do?"]) {
				await host.before(query, "interactive");
				invalidateGoalPoolCache();
				assert.equal(readActiveGoalFiles({ cwd }).find((item) => item.id === goal.id)?.continuation?.wake?.id, `wait-${order}`, `${order}: ${query} preserves the lease`);
			}
			const statusPrompt = await host.before("What is the current status?", "interactive");
			assert.match(statusPrompt, /PI GOAL SCHEDULED WAIT/);
			assert.match(statusPrompt, /do not do substantive work/i);
			if (order === "goal-first") assert.match(statusPrompt, /NO-QUESTIONS GOAL-WAIT DEFERRED/);
			else assert.match(statusPrompt, /If it supplies a scheduled-wait state, defer to that future wake/);
			invalidateGoalPoolCache();
			const retained = readActiveGoalFiles({ cwd }).find((item) => item.id === goal.id);
			assert.ok(retained, `${order}: active goal remains present after status`);
			assert.equal(retained.continuation?.wake?.id, `wait-${order}`, `${order}: status preserves wake id`);
			assert.equal(retained.continuation?.wake?.at, wakeAt, `${order}: status preserves deadline`);
			assert.equal(host.sentMessages.length, before, `${order}: status does not dispatch an early checkpoint`);
			await new Promise((resolve) => setTimeout(resolve, 180));
			invalidateGoalPoolCache();
			const after = readActiveGoalFiles({ cwd }).find((item) => item.id === goal.id);
			assert.ok(after, `${order}: active goal remains present after due wake`);
			assert.equal(after.continuation?.wake, undefined, `${order}: due wake retires its lease`);
			assert.equal(after.continuation?.instruction, "Recheck the external dependency and continue the pending task.");
			const wakes = host.sentMessages.filter((message: any) => String(message.content ?? "").includes("pi_goal_continuation"));
			assert.equal(wakes.length, 1, `${order}: due wake dispatches exactly one continuation`);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});

test("explicit resume supersedes a preserved scheduled wait safely", async () => {
	const cwd = mkdtempSync(path.join("/tmp", "pi-goal-explicit-wait-override-"));
	try {
		mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
		const goal = writeActiveGoalFile({ cwd }, {
			...createGoal({ objective: "Explicit wait override", autoContinue: true, sisyphus: false }, Date.now()),
			continuation: {
				scope: "wait-scope",
				instruction: "Recheck the dependency.",
				executionRetries: 0,
				reviewFailures: 0,
				wake: { id: "override-wake", at: new Date(Date.now() + 60_000).toISOString(), kind: "external_wait", reason: "dependency", evidence: ["observed pending"] },
			},
		});
		const sessionEntries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
		const host = await loadHost(cwd, sessionEntries, "goal-first", false);
		await host.emit({ type: "session_start", reason: "start" });
		await host.before("What is the status?", "interactive");
		invalidateGoalPoolCache();
		assert.equal(readActiveGoalFiles({ cwd }).find((item) => item.id === goal.id)?.continuation?.wake?.id, "override-wake");
		await host.before("Please resume the goal", "interactive");
		invalidateGoalPoolCache();
		assert.equal(readActiveGoalFiles({ cwd }).find((item) => item.id === goal.id)?.continuation?.wake, undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("native held ACTIVE goals survive status/reload and NQA defers in both loader orders", async (t) => {
	if (!NQA_SOURCE || !existsSync(NQA_SOURCE)) { t.skip("set PI_NQA_EXTENSION_PATH for native both-order hold coverage"); return; }
	for (const order of ["goal-first", "nqa-first"] as const) {
		const cwd = mkdtempSync(path.join("/tmp", `pi-goal-native-hold-${order}-`));
		try {
			mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
			const goal = writeActiveGoalFile({ cwd }, {
				...createGoal({ objective: "Verify the held external criterion", autoContinue: true, sisyphus: false }, Date.now()),
				continuation: { scope: "held-scope", instruction: "Await a discriminating observation", executionRetries: 0, reviewFailures: 0,
					hold: { reason: "No justified next action", evidence: ["The required external evidence is unavailable"], at: new Date().toISOString() } },
			});
			const entries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
			for (let reload = 0; reload < 2; reload += 1) {
				const host = await loadHost(cwd, entries, order);
				if (reload === 0) {
					const command = host.extensions.flatMap((e: any) => [...e.commands.values()]).find((c: any) => c.name === "no-questions-asked");
					await command.handler("", host.ctx);
				}
				await host.emit({ type: "session_start", reason: "start" });
				const prompt = await host.before("What is the status?", "interactive");
				assert.match(prompt, /PI GOAL CONTINUATION HOLD/);
				assert.match(prompt, /preserve ACTIVE\/incomplete|NO-QUESTIONS GOAL-HOLD DEFERRED/);
				assert.doesNotMatch(prompt, /ACTIVE without a scheduled wait,/);
				invalidateGoalPoolCache();
				assert.equal(readActiveGoalFiles({ cwd }).find((g) => g.id === goal.id)?.status, "active");
				assert.ok(readActiveGoalFiles({ cwd }).find((g) => g.id === goal.id)?.continuation?.hold);
				assert.equal(host.sentMessages.filter((m: any) => String(m.content).includes("pi_goal_continuation")).length, 0);
				assert.match(readFileSync(path.join(cwd, ".pi", "no-questions-diagnostics.json"), "utf8"), /"sourceHash":"[a-f0-9]{64}"/);
				assert.match(readFileSync(path.join(cwd, ".pi", "goals", "diagnostics.json"), "utf8"), /"sourceHash":"[a-f0-9]{64}"/);
				await host.emit({ type: "session_shutdown" });
			}
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	}
});

async function loadHost(cwd: string, sessionEntries: unknown[], order: "goal-first" | "nqa-first" = "goal-first", includeNqa = true) {
	const hostRoot = process.env.PI_HOST_PACKAGE_ROOT ?? path.resolve("node_modules");
	const loader = await import(path.join(hostRoot, "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"));
	const runtime = loader.createExtensionRuntime() as any;
	const sentMessages: unknown[] = [];
	let activeTools = ["ask_user", "read", "bash", "edit", "write"];
	runtime.sendMessage = (message: unknown) => { sentMessages.push(message); };
	runtime.sendUserMessage = () => {};
	runtime.appendEntry = (customType: string, data: unknown) => {
		sessionEntries.push({ type: "custom", customType, data });
	};
	runtime.getActiveTools = () => activeTools;
	runtime.getAllTools = () => activeTools;
	runtime.setActiveTools = (tools: string[]) => { activeTools = [...tools]; };
	runtime.refreshTools = () => {};
	runtime.getThinkingLevel = () => "medium";
	runtime.getContextUsage = () => undefined;
	const extensionPaths = includeNqa
		? order === "goal-first"
			? [path.resolve("extensions/goal.ts"), NQA_SOURCE]
			: [NQA_SOURCE, path.resolve("extensions/goal.ts")]
		: [path.resolve("extensions/goal.ts")];
	const loaded = await loader.loadExtensions(extensionPaths, cwd, undefined, runtime);
	assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
	const goalExtension = loaded.extensions.find((extension: any) => extension.path.endsWith("extensions/goal.ts"));
	assert.ok(goalExtension, "goal-x candidate loaded through host package loader");
	const ctx = {
		cwd,
		hasUI: false,
		model: undefined,
		thinkingLevel: "medium",
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getBranch: () => sessionEntries,
			getCwd: () => cwd,
			getSessionId: () => "nqa-host-test",
			getRoot: () => cwd,
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWidget: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
		},
	} as unknown as ExtensionContext;
	const handlers = (name: string) => loaded.extensions.flatMap((extension: any) => extension.handlers.get(name) ?? []);
	return {
		extensions: loaded.extensions,
		goalExtension,
		ctx,
		sentMessages,
		emit: async (event: any) => {
			for (const handler of handlers(event.type)) await handler(event, ctx);
		},
		emitInput: async (text: string, source: "interactive" | "rpc" | "extension") => {
			for (const handler of handlers("input")) await handler({ type: "input", text, source }, ctx);
		},
		before: async (prompt: string, source: "interactive" | "rpc" | "extension") => {
			if (source === "interactive" || source === "rpc") await (async () => {
				for (const handler of handlers("input")) await handler({ type: "input", text: prompt, source }, ctx);
			})();
			let systemPrompt = "base";
			for (const handler of handlers("before_agent_start")) {
				const result = await handler({ type: "before_agent_start", prompt, systemPrompt, systemPromptOptions: {} }, ctx);
				if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
			}
			return systemPrompt;
		},
	};
}
