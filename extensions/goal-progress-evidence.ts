import { createHash } from "node:crypto";
import { isMeaningfulProgressToolCall } from "./goal-format.ts";

const OBSERVATIONAL_TOOL_NAMES = new Set(["bash", "read", "grep", "find", "ls", "bg_logs"]);
const MAX_OBSERVATIONS = 64;

function stableJson(value: unknown): string {
	try {
		const serialized = JSON.stringify(value, (_key, item: unknown) => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return item;
			return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
		});
		return serialized ?? String(value);
	} catch {
		return String(value);
	}
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function semanticInput(toolName: string, input: unknown): unknown {
	if (!input || typeof input !== "object") return input;
	const raw = input as Record<string, unknown>;
	if (toolName === "bash") {
		// Timeout is an execution control, not a materially different diagnostic.
		return { command: raw.command };
	}
	if (toolName === "bg_logs") {
		// Tail and byte limits alter presentation, not which completed task is observed.
		return { taskId: raw.taskId };
	}
	return input;
}

/**
 * Credits mutations immediately, but credits observational tools only when
 * their completed result differs from the previous result for the same call.
 * This prevents repeated status/read commands from resetting the no-progress
 * counter while still recognizing newly observed state as useful evidence.
 */
export class GoalProgressEvidenceTracker {
	private readonly pendingObservations = new Map<string, { invocation: string; toolName: string }>();
	private readonly lastResultByInvocation = new Map<string, string>();

	beginAgentRun(): void {
		this.pendingObservations.clear();
	}

	observeCall(toolCallId: unknown, toolName: string, input: unknown): boolean {
		if (!isMeaningfulProgressToolCall(toolName, input)) return false;
		if (!OBSERVATIONAL_TOOL_NAMES.has(toolName)) {
			this.lastResultByInvocation.clear();
			return true;
		}
		// Runtime events always carry an id. Preserve conservative compatibility
		// with synthetic/older event producers that omit it.
		if (typeof toolCallId !== "string" || toolCallId.length === 0) return true;
		this.pendingObservations.set(toolCallId, {
			invocation: fingerprint({ toolName, input: semanticInput(toolName, input) }),
			toolName,
		});
		return false;
	}

	observeResult(toolCallId: unknown, result: unknown, isError: unknown): boolean {
		if (typeof toolCallId !== "string") return false;
		const pending = this.pendingObservations.get(toolCallId);
		if (!pending) return false;
		this.pendingObservations.delete(toolCallId);
		if (isError === true) return false;

		const resultEvidence = pending.toolName === "bg_logs" && result && typeof result === "object"
			? (result as Record<string, unknown>).content
			: result;
		const resultFingerprint = fingerprint(resultEvidence);
		const previous = this.lastResultByInvocation.get(pending.invocation);
		// Refresh insertion order so the bounded map retains recently used calls.
		this.lastResultByInvocation.delete(pending.invocation);
		this.lastResultByInvocation.set(pending.invocation, resultFingerprint);
		while (this.lastResultByInvocation.size > MAX_OBSERVATIONS) {
			const oldest = this.lastResultByInvocation.keys().next().value;
			if (typeof oldest !== "string") break;
			this.lastResultByInvocation.delete(oldest);
		}
		return previous !== resultFingerprint;
	}
}
