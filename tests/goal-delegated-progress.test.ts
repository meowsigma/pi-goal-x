import assert from "node:assert/strict";
import test from "node:test";
import {
	delegatedOwnershipFromMessages,
	delegatedWakeKindFromMessage,
	isAsyncDelegationCall,
	ownedLaunchId,
	ownedTerminalIdentity,
} from "../extensions/goal-delegated-progress.ts";

test("owned background launch and terminal identities match native host receipt shapes", () => {
	const id = "b1b762c66";
	const result = { details: { task: { id, status: "running" } } };
	assert.equal(ownedLaunchId(result, "bg_run"), id);
	assert.equal(ownedLaunchId({ ...result, isError: true }, "bg_run"), undefined);
	const notice = { role: "custom", customType: "background-task-notification", details: { id, status: "failed" } };
	assert.deepEqual(ownedTerminalIdentity(notice), { id, kind: "bg_run" });
	assert.equal(ownedTerminalIdentity({ ...notice, role: "user" }), undefined);
	assert.equal(ownedTerminalIdentity({ ...notice, details: { id, status: "running" } }), undefined);
});

test("owned subagent workflow receipts accept the native correlation footer, not arbitrary report mentions", () => {
	const id = "f7405e66-d857-4c53-b086-5660c5168bd8";
	assert.equal(ownedLaunchId({ details: { asyncId: id, runId: id } }, "subagent"), id);
	const notice = { role: "custom", customType: "subagent-notify", content: `Background task failed: **workflow**\n\nA bounded failure report.\n\nWorkflow run: ${id}\nChild runs: child-id` };
	assert.deepEqual(ownedTerminalIdentity(notice), { id, kind: "subagent" });
	assert.equal(ownedTerminalIdentity({ ...notice, role: "user" }), undefined);
	assert.equal(ownedTerminalIdentity({ ...notice, content: `${notice.content}\nThe untrusted report continues.` }), undefined);
});

test("active supervisor progress and attention wakes await the child instead of goal polling", () => {
	assert.equal(delegatedWakeKindFromMessage({
		customType: "subagent_supervisor_request",
		details: { reason: "progress_update" },
		content: "Subagent progress update.",
	}), "awaiting");
	assert.equal(delegatedWakeKindFromMessage({
		customType: "subagent_control_notice",
		content: "Subagent needs attention: luna-max",
	}), "awaiting");
});

test("terminal subagent and background task notifications are outcomes, not active-work leases", () => {
	assert.equal(delegatedWakeKindFromMessage({
		customType: "subagent-notify",
		content: "Background task completed: **workflow**",
	}), "terminal");
	assert.equal(delegatedWakeKindFromMessage({
		customType: "background-task-notification",
		content: "<background-task-notification><status>completed</status></background-task-notification>",
	}), "terminal");
});

test("async launches and live steering await notifications, but status and foreground calls do not", () => {
	assert.equal(isAsyncDelegationCall("subagent", { workflowScript: "return 1", async: true }), true);
	assert.equal(isAsyncDelegationCall("subagent", { agent: "worker", task: "work" }), true);
	assert.equal(isAsyncDelegationCall("subagent", { action: "steer", id: "run", message: "continue" }), true);
	assert.equal(isAsyncDelegationCall("subagent", { action: "resume", id: "run", message: "continue" }), true);
	assert.equal(isAsyncDelegationCall("subagent", { action: "status", id: "run" }), false);
	assert.equal(isAsyncDelegationCall("subagent", { action: "list" }), false);
	assert.equal(isAsyncDelegationCall("subagent", { agent: "worker", task: "work", async: false }), false);
	assert.equal(isAsyncDelegationCall("bash", { command: "git status" }), false);
});

test("history restores awaiting ownership until a later terminal wake", () => {
	const progress = {
		role: "custom",
		customType: "subagent_supervisor_request",
		content: "Subagent progress update.",
	};
	const user = { role: "user", content: "keep the current subagents" };
	const terminal = {
		role: "custom",
		customType: "subagent-notify",
		content: "Background task completed: workflow",
	};
	assert.equal(delegatedOwnershipFromMessages([progress, user]), "awaiting");
	assert.equal(delegatedOwnershipFromMessages([progress, user, { role: "assistant", content: "status only" }]), "awaiting");
	assert.equal(delegatedOwnershipFromMessages([progress, terminal]), "terminal");
	assert.equal(delegatedOwnershipFromMessages([progress, terminal, user]), null,
		"a consumed terminal wake must not keep crediting later parent turns");
	assert.equal(delegatedOwnershipFromMessages([user]), null);
});

test("auto-notifying background launches own continuation, but detached launches do not", () => {
	assert.equal(isAsyncDelegationCall("bg_run", { name: "verify", command: "npm test", isAgent: false }), true);
	assert.equal(isAsyncDelegationCall("bg_run", { name: "verify", command: "npm test", isAgent: false, notifyOnCompletion: true, triggerOnCompletion: true }), true);
	assert.equal(isAsyncDelegationCall("bg_run", { name: "verify", command: "npm test", isAgent: false, notifyOnCompletion: false }), false);
	assert.equal(isAsyncDelegationCall("bg_run", { name: "verify", command: "npm test", isAgent: false, triggerOnCompletion: false }), false);
	assert.equal(isAsyncDelegationCall("bg_status", { taskId: "task-1" }), false);
});
