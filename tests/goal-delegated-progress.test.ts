import assert from "node:assert/strict";
import test from "node:test";
import {
	delegatedWakeKindFromMessage,
	isAsyncDelegationCall,
} from "../extensions/goal-delegated-progress.ts";

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

test("terminal subagent notifications are outcomes, not active-work leases", () => {
	assert.equal(delegatedWakeKindFromMessage({
		customType: "subagent-notify",
		content: "Background task completed: **workflow**",
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
