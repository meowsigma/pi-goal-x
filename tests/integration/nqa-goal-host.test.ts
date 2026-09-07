import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createGoal, goalFocusDetails } from "../../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../../extensions/storage/goal-files.ts";

const NQA_SOURCE_CANDIDATES = [
	process.env.PI_NQA_EXTENSION_PATH,
	path.resolve(process.cwd(), "../pi-no-questions-asked/extensions/no-questions-asked.ts"),
	path.resolve(process.cwd(), "../../../pi-no-questions-asked/extensions/no-questions-asked.ts"),
	path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../pi-no-questions-asked/extensions/no-questions-asked.ts"),
].filter((candidate): candidate is string => Boolean(candidate));
const NQA_SOURCE = NQA_SOURCE_CANDIDATES.find((candidate) => existsSync(candidate));

test("host-loaded pi-goal-x and NQA preserve audit ownership and user reset boundaries", async (t) => {
	if (!NQA_SOURCE) {
		t.skip("actual NQA source is unavailable; set PI_NQA_EXTENSION_PATH to the checked-out extension for host-loader coverage");
		return;
	}
	const cwd = mkdtempSync(path.join("/tmp", "pi-goal-nqa-host-"));
	try {
		mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
		writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ provider: "missing-provider", model: "missing-model" }));
		const goal = writeActiveGoalFile({ cwd }, createGoal({ objective: "Host-loaded NQA goal", autoContinue: true, sisyphus: false }, Date.now()));
		const sessionEntries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
		const first = await loadHost(cwd, sessionEntries);
		const nqaCommand = first.extensions.flatMap((extension: any) => [...extension.commands.values()]).find((command: any) => command.name === "no-questions-asked");
		assert.ok(nqaCommand, "actual NQA command loaded through the host loader");
		await first.emit({ type: "session_start", reason: "start" });
		await nqaCommand.handler("", first.ctx);

		const initialPrompt = await first.before("user request", "interactive");
		assert.match(initialPrompt, /NO-QUESTIONS-ASKED MODE: ON/);
		const goalTool = first.goalExtension.tools.get("update_goal")?.definition;
		assert.ok(goalTool, "actual goal-x update_goal loaded through the host loader");
		const firstResult = await (goalTool.execute as any)("host-audit-1", { status: "complete" }, undefined, undefined, first.ctx);
		assert.match(firstResult.content[0].text, /Goal audit unavailable/);

		// A generated extension-originated NQA wake is owned by the active goal;
		// it cannot reset admission or create a competing continuation after the
		// infrastructure failure.
		await first.emitInput("NQA generated followup", "extension");
		const generatedPrompt = await first.before("NQA generated followup", "extension");
		assert.match(generatedPrompt, /NO-QUESTIONS-ASKED MODE: ON/);
		const denied = await (goalTool.execute as any)("host-audit-2", { status: "complete" }, undefined, undefined, first.ctx);
		assert.match(denied.content[0].text, /cooling down|exhausted/);
		await first.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn" }] });
		await first.emit({ type: "agent_settled" });
		const followUps = first.sentMessages.filter((message: any) => message?.customType !== "pi-goal-audit-event");
		assert.deepEqual(followUps, [], `NQA goal-managed recovery does not compete with audit recovery: ${JSON.stringify(followUps)}`);

		// Genuine interactive input clears admission and writes the durable reset.
		await first.emitInput("user retry", "interactive");
		await first.before("user retry", "interactive");
		const retryResult = await (goalTool.execute as any)("host-audit-3", { status: "complete" }, undefined, undefined, first.ctx);
		assert.match(retryResult.content[0].text, /Goal audit unavailable/);

		const reloaded = await loadHost(cwd, sessionEntries);
		await reloaded.emit({ type: "session_start", reason: "start" });
		await reloaded.before("NQA reload wake", "extension");
		const reloadedTool = reloaded.goalExtension.tools.get("update_goal")?.definition;
		assert.ok(reloadedTool);
		const reloadResult = await (reloadedTool.execute as any)("host-audit-4", { status: "complete" }, undefined, undefined, reloaded.ctx);
		assert.match(reloadResult.content[0].text, /cooling down|exhausted/, "the post-reset failure survives reload");
	} finally {
		rmSync(cwd, { recursive: true, force: true });

	}
});

async function loadHost(cwd: string, sessionEntries: unknown[]) {
	const loader = await import(path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"));
	const runtime = loader.createExtensionRuntime() as any;
	const sentMessages: unknown[] = [];
	let activeTools = ["ask_user", "read", "bash", "edit", "write"];
	runtime.sendMessage = (message: unknown) => { sentMessages.push(message); };
	runtime.sendUserMessage = () => {};
	runtime.appendEntry = () => {};
	runtime.getActiveTools = () => activeTools;
	runtime.getAllTools = () => activeTools;
	runtime.setActiveTools = (tools: string[]) => { activeTools = [...tools]; };
	runtime.refreshTools = () => {};
	runtime.getThinkingLevel = () => "medium";
	runtime.getContextUsage = () => undefined;
	const loaded = await loader.loadExtensions([
		path.resolve("extensions/goal.ts"),
		NQA_SOURCE,
	], cwd, undefined, runtime);
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
		emitInput: async (text: string, source: "interactive" | "extension") => {
			for (const handler of handlers("input")) await handler({ type: "input", text, source }, ctx);
		},
		before: async (prompt: string, source: "interactive" | "extension") => {
			if (source === "interactive") await (async () => {
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
