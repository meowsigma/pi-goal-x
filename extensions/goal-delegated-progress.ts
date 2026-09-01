export type DelegatedWakeKind = "awaiting" | "terminal";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function delegatedWakeKindFromMessage(message: unknown): DelegatedWakeKind | null {
	const raw = asRecord(message);
	const customType = raw?.customType;
	if (customType === "subagent_supervisor_request" || customType === "subagent_control_notice") return "awaiting";
	if (customType === "subagent-notify" || customType === "background-task-notification") return "terminal";
	return null;
}

export function isAsyncDelegationCall(toolName: string, input: unknown): boolean {
	const raw = asRecord(input);
	if (!raw) return false;
	if (toolName === "bg_run") {
		return raw.notifyOnCompletion !== false && raw.triggerOnCompletion !== false;
	}
	if (toolName !== "subagent" || raw.async === false) return false;
	const action = typeof raw.action === "string" ? raw.action.toLowerCase() : "";
	if (action) return action === "steer" || action === "resume";
	return ["agent", "workflow", "workflowScript", "workflowScriptPath"].some((key) => raw[key] !== undefined);
}
