export type DelegatedWakeKind = "awaiting" | "terminal";

function messageText(value: unknown): string {
	const record = asRecord(value);
	if (typeof record?.content === "string") return record.content;
	return Array.isArray(record?.content) ? record.content.map((item) => asRecord(item)?.type === "text" ? String(asRecord(item)?.text ?? "") : "").join("\n") : "";
}

const validOwnedId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,128}$/u.test(value);

/** Called only for a paired, successful native tool result of an async launch. */
export function ownedLaunchId(result: unknown, kind: "bg_run" | "subagent"): string | undefined {
	const raw = asRecord(result);
	if (raw?.isError === true) return undefined;
	const details = asRecord(raw?.details);
	const id = kind === "bg_run" ? asRecord(details?.task)?.id ?? details?.taskId ?? raw?.taskId : details?.runId ?? details?.asyncId;
	if (validOwnedId(id)) return id;
	if (kind !== "bg_run") return undefined;
	const text = messageText(result);
	try {
		const json = asRecord(JSON.parse(text));
		if (validOwnedId(json?.taskId)) return json.taskId;
	} catch { /* some hosts use the labelled receipt rather than JSON */ }
	return text.match(/^Task ID:\s*([\w-]{1,128})\s*$/imu)?.[1];
}

/** Do not infer provenance from a raw user role or quoted notification text.
 * Custom messages come from trusted loaded extensions, not a security sandbox.
 * Legacy notices lacking an unambiguous native identity fail closed. */
export function ownedTerminalIdentity(message: unknown): { id: string; kind: "bg_run" | "subagent" } | undefined {
	const raw = asRecord(message);
	if (raw?.role !== "custom") return undefined;
	const kind = raw.customType === "background-task-notification" ? "bg_run" : raw.customType === "subagent-notify" ? "subagent" : undefined;
	if (!kind) return undefined;
	const details = asRecord(raw.details);
	const id = kind === "bg_run" ? details?.id ?? details?.taskId : details?.runId;
	if (validOwnedId(id) && /^(?:completed|failed|killed|stopped)$/u.test(String(details?.status ?? ""))) return { id, kind };
	const text = messageText(message).trim();
	if (kind === "bg_run") {
		const match = text.match(/^<background-task-notification>\s*<task-id>([\w-]{1,128})<\/task-id>[\s\S]*?<status>(?:completed|failed|killed)<\/status>[\s\S]*<\/background-task-notification>$/u);
		return match ? { id: match[1]!, kind } : undefined;
	}
	if (!/^(?:Background task|Detached foreground task) (?:completed|failed|stopped): /u.test(text)) return undefined;
	// The native notifier appends this footer AFTER the untrusted child report.
	const lines = text.split("\n");
	const footer = lines.at(-1) ?? "";
	const session = footer.match(/^Session(?: file)?: .*\/([a-f0-9-]{36})\/run-\d+\/session\.jsonl$/u);
	if (session) return { id: session[1]!, kind };
	// Workflow notifications finish with the host's correlation block instead.
	for (let index = lines.length - 1; index >= 0; index--) {
		if (!/^Workflow run: [a-f0-9-]{36}$/u.test(lines[index]!)) continue;
		if (lines.slice(index + 1).every((line) => /^(?:Child runs: |Reconciled detached child: |\s*$)/u.test(line))) {
			return { id: lines[index]!.slice("Workflow run: ".length), kind };
		}
		break;
	}
	return undefined;
}

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

export function delegatedOwnershipFromMessages(messages: readonly unknown[]): DelegatedWakeKind | null {
	if (messages.length === 0) return null;
	const latest = delegatedWakeKindFromMessage(messages[messages.length - 1]);
	if (latest) return latest;
	let lastWake: DelegatedWakeKind | null = null;
	for (const message of messages) {
		const wake = delegatedWakeKindFromMessage(message);
		if (wake) lastWake = wake;
	}
	return lastWake === "awaiting" ? "awaiting" : null;
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
