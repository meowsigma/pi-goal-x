import { asRecord } from "./goal-record.ts";

export const GOAL_USER_DECISION_ENTRY = "pi-goal-user-decision";

interface OwnedUserDecision {
	version: 1;
	kind: "message";
	source: "interactive" | "rpc";
	goalId: string;
	focusGoalId: string;
	focusEpoch: number;
	text: string;
}

function isOwnedUserDecision(value: unknown, goalId: string): value is OwnedUserDecision {
	const data = asRecord(value);
	return !!data
		&& data.version === 1
		&& data.kind === "message"
		&& (data.source === "interactive" || data.source === "rpc")
		&& data.goalId === goalId
		&& data.focusGoalId === goalId
		&& typeof data.focusEpoch === "number"
		&& Number.isSafeInteger(data.focusEpoch)
		&& data.focusEpoch >= 0
		&& typeof data.text === "string"
		&& !!data.text.trim();
}

/**
 * Read the small, host-owned decision markers appended by this extension's
 * input handler. Ordinary transcript provenance is not durable authority.
 *
 * Extensions run with the host's full Node/PiAPI privileges, so this is a
 * trusted-extension boundary, not cryptographic authentication. In
 * particular, synthetic user-message text and arbitrary dialog-shaped records
 * are not promoted to goal authority; a real paired ask_user provenance
 * record would need a host API before it could be accepted here.
 */
export function collectLatestUserDecisions(branch: readonly unknown[], goalId: string): string {
	let focusBoundary = -1;
	let focusedGoalAtBoundary: string | null = null;
	for (let index = 0; index < branch.length; index += 1) {
		const entry = asRecord(branch[index]);
		if (entry?.customType !== "pi-goal-focus" || entry.type !== "custom") continue;
		const data = asRecord(entry.data);
		if (data?.version !== 1 || (typeof data.focusedGoalId !== "string" && data.focusedGoalId !== null)) continue;
		focusBoundary = index;
		focusedGoalAtBoundary = data.focusedGoalId;
	}
	if (focusedGoalAtBoundary !== goalId) return "";

	const decisions: string[] = [];
	for (let index = focusBoundary + 1; index < branch.length; index += 1) {
		const entry = asRecord(branch[index]);
		if (entry?.type !== "custom" || entry.customType !== GOAL_USER_DECISION_ENTRY) continue;
		const data = asRecord(entry.data);
		// Only the exact message record emitted by the native input handler is
		// accepted. Dialog ids alone do not prove a paired host dialog result.
		if (!isOwnedUserDecision(data, goalId)) continue;
		decisions.push(`[user ${data.source}] ${data.text.trim().slice(0, 600)}`);
	}
	return decisions.slice(-6).join("\n");
}
