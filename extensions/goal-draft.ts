export type GoalDraftingFocus = "goal" | "sisyphus";

export interface GoalConfirmationIntentLike {
	focus: GoalDraftingFocus;
	originalTopic: string;
	startedAt?: number;
}

export interface DraftProposalInput {
	intent: GoalConfirmationIntentLike | null;
	hasUnfinishedGoal: boolean;
	objective: string;
	sisyphus?: boolean;
	draftId?: string;
}

export type DraftProposalValidation =
	| { ok: true; objective: string; expectedSisyphus: boolean }
	| { ok: false; message: string; clearDrafting?: boolean };

export type ToolGateDecision =
	| { block: false }
	| { block: true; reason: string };

export function promptSafeObjective(objective: string): string {
	return objective.replace(/<\/?untrusted_objective>/gi, (tag) => tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
}

const VERIFICATION_CONTRACT_RE = /^Verification contract:\s*(.+)$/im;

const CONVENTIONAL_SECTION_NAMES = [
	"success criteria",
	"boundaries",
	"constraints",
	"if blocked",
	"if blocked / unclear / failing",
	"don'ts",
	"sisyphus reminder",
	"objective",
	"目标",
	"ordered steps",
	"order rules",
	"steps",
];

/**
 * Extract a `Verification contract:` section from a goal objective and return
 * the cleaned objective (without the contract section) and the contract text.
 *
 * The contract section is a single line matching:
 *   Verification contract: <text>
 *
 * It can appear anywhere in the objective, but by convention it goes after
 * the other sections (like Success criteria, Boundaries, Constraints).
 *
 * If no contract section is found, `verificationContract` is undefined.
 */
export function extractVerificationContract(objective: string): { objective: string; verificationContract?: string } {
	const lines = objective.replace(/\r/g, "").split("\n");
	let contract: string | undefined;
	const filtered: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		const m = VERIFICATION_CONTRACT_RE.exec(trimmed);
		if (m) {
			contract = m[1].trim();
			// Skip this line — don't add it to the cleaned objective
		} else {
			filtered.push(line);
		}
	}

	return {
		objective: filtered.join("\n"),
		verificationContract: contract || undefined,
	};
}

export function buildDraftConfirmationText(args: {
	focus: GoalDraftingFocus;
	originalTopic: string;
	objective: string;
	autoContinue: boolean;
}): string {
	const lines: string[] = [];
	const modeLabel = args.focus === "sisyphus" ? "Sisyphus (prompt/criteria style)" : "Normal goal";
	lines.push("● Goal draft ready for confirmation.");
	lines.push("");
	lines.push("─── Draft Details ───");
	lines.push(`│   Mode: ${modeLabel}`);
	lines.push(`│   Auto-continue: ${args.autoContinue ? "yes" : "no"}`);
	lines.push("");
	lines.push("─── Original Topic ───");
	lines.push("");
	for (const topicLine of args.originalTopic.trim().split("\n")) {
		if (topicLine.trim()) lines.push(`│   ${topicLine}`);
	}
	lines.push("");
	lines.push("─── Proposed Goal ───");
	lines.push("");
	for (const objLine of args.objective.split("\n")) {
		const trimmed = objLine.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("│")) {
			lines.push(objLine);
		} else {
			lines.push(`│   ${objLine}`);
		}
	}
	return lines.join("\n");
}

export function buildTweakConfirmationText(args: {
	currentObjective: string;
	newObjective: string;
	changeSummary: string;
	sisyphus: boolean;
}): string {
	const lines: string[] = [];
	const modeLabel = args.sisyphus ? "Sisyphus (prompt/criteria style)" : "Normal goal";
	lines.push("● Goal tweak ready for confirmation.");
	lines.push("");
	lines.push("─── Draft Details ───");
	lines.push(`│   Mode: ${modeLabel}`);
	lines.push("");
	lines.push("─── Change ───");
	lines.push("");
	for (const changeLine of args.changeSummary.split("\n")) {
		if (changeLine.trim()) lines.push(`│   ${changeLine}`);
	}
	lines.push("");
	lines.push("─── Current Objective ───");
	lines.push("");
	for (const curLine of args.currentObjective.split("\n")) {
		const trimmed = curLine.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("│")) {
			lines.push(curLine);
		} else {
			lines.push(`│   ${curLine}`);
		}
	}
	lines.push("");
	lines.push("─── Proposed New Objective ───");
	lines.push("");
	for (const newLine of args.newObjective.split("\n")) {
		const trimmed = newLine.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("│")) {
			lines.push(newLine);
		} else {
			lines.push(`│   ${newLine}`);
		}
	}
	return lines.join("\n");
}

export function evaluateDraftingToolGate(args: {
	toolName: string;
	draftingFocus?: GoalDraftingFocus | null;
	tweakDraftingGoalId?: string | null;
	activeGoalId?: string | null;
	proposeToolName?: string;
	tweakApplyToolName?: string;
	getGoalToolName?: string;
}): ToolGateDecision {
	// Goal confirmation is prompt-guided, not runtime-enforced. The agent should
	// avoid substantive work before confirmation, but minimal reconnaissance is allowed.
	void args;
	return { block: false };
}

export function validateGoalDraftProposal(input: DraftProposalInput): DraftProposalValidation {
	if (input.intent === null) {
		return {
			ok: false,
			message: "propose_goal_draft REJECTED: no /goals or /sisyphus intent discussion is in progress. Tell the user to invoke /goals <topic> or /sisyphus <topic> first, or use /goals-set / /sisyphus-set for immediate creation.",
		};
	}

	const expectedSisyphus = input.intent.focus === "sisyphus";
	const actualSisyphus = input.sisyphus === true;
	if (actualSisyphus !== expectedSisyphus) {
		return {
			ok: false,
			message: `propose_goal_draft REJECTED (focus gate): confirmation focus is "${input.intent.focus}" (user invoked ${input.intent.focus === "sisyphus" ? "/sisyphus" : "/goals"}) but you passed sisyphus=${actualSisyphus}. Set sisyphus=${expectedSisyphus} to match the user's choice, then retry. Do NOT change the user's mode autonomously.`,
		};
	}

	const objective = input.objective.trim();
	if (!objective) {
		return { ok: false, message: "propose_goal_draft REJECTED: objective is empty." };
	}

	return { ok: true, objective, expectedSisyphus };
}

export function goalDraftingPrompt(topic: string, focus: GoalDraftingFocus): string {
	const safeTopic = promptSafeObjective(topic.trim() || "(no topic provided — ask the user what they want to accomplish)");
	const header = focus === "sisyphus"
		? "[GOAL CONFIRMATION focus=sisyphus]\nThe user invoked Sisyphus intent discussion (/sisyphus). Help turn their request into a confirmed goal contract. Do NOT start substantive work yet."
		: "[GOAL CONFIRMATION focus=goal]\nThe user invoked goal intent discussion (/goals). Help turn their request into a confirmed goal contract. Do NOT start substantive work yet.";

	const commonProtocol = [
		"Confirmation protocol:",
		"- Treat this as a lightweight conversation with the user, not a separate long-running runtime phase.",
		"- If the topic is vague, ask one focused question with a recommended default. Use goal_question or goal_questionnaire when a structured answer would help, but plain conversation is acceptable.",
		"- Targeted read-only research is allowed when it helps define a better goal contract; do not start implementation before confirmation.",
		"- If the topic is already concrete, you may proceed directly to propose_goal_draft.",
		"- The goal contract should make the objective, success criteria, boundaries, constraints, and blocker rule explicit.",
		"- Keep grilling assumptions until the objective, success criteria, boundaries, constraints, and blocker rule are clear enough to confirm.",
		"- If the objective naturally decomposes into trackable milestones, you MUST include the task list in the `tasks` parameter of `propose_goal_draft` so the user can accept both goal and tasks in a single confirmation dialog. Do NOT propose the goal without tasks and then call `propose_task_list` separately.",
		"- For simple single-step goals, no task list is required. The `tasks` parameter can be omitted.",
		"- After goal creation, `propose_task_list` is still available for user-requested task additions or structural changes.",
		"- propose_goal_draft opens the user's Confirm / Continue Chatting dialog. Confirm creates and focuses the goal; Continue Chatting means keep refining through normal proposal cycles.",
		"- create_goal is not a shortcut. Direct create_goal calls are rejected so the user keeps explicit say in goal creation.",
	];

	const goalFocusItems = [
		"For /goals, propose a normal goal in this shape when ready:",
		"=== Goal ===",
		"Objective: <one-sentence outcome>",
		"Success criteria: <observable evidence the goal is done>",
		"Boundaries: <in scope / out of scope>",
		"Constraints: <hard rules>",
		"Verification contract: <optional — what verification evidence is required before marking complete, e.g. 'Run npm test (0 failures), grep for remaining references, re-read requirements and confirm every item is addressed'>",
		"If blocked: <default = stop and ask the user>",
		"Call propose_goal_draft with sisyphus=false and autoContinue=true unless the user asked otherwise.",
	];

	const sisyphusFocusItems = [
		"For /sisyphus, remember that Sisyphus is a prompt/criteria style, not a separate step-counter mechanism.",
		"Propose a Sisyphus goal in this shape when ready:",
		"=== Sisyphus Goal ===",
		"Objective: <one-sentence outcome>",
		"Success criteria: <observable evidence the whole ordered goal is done>",
		"Boundaries: <in scope / out of scope>",
		"Constraints: <hard rules, files not to touch, etc.>",
		"Verification contract: <optional — what verification evidence is required before marking complete>",
		"Ordered steps: <preserve the user's requested steps and ordering; do not add preflight or reconnaissance steps they did not ask for>",
		"If blocked / unclear / failing: <default = stop and ask the user>",
		"Sisyphus reminder: Work patiently and sequentially. No rushing, no unrequested preflight steps, no improvising around blockers.",
		"Call propose_goal_draft with sisyphus=true and autoContinue=true unless the user asked otherwise.",
	];

	return [
		header,
		"",
		"Topic the user provided:",
		"<goal_topic>",
		safeTopic,
		"</goal_topic>",
		"",
		...commonProtocol,
		"",
		...(focus === "sisyphus" ? sisyphusFocusItems : goalFocusItems),
	].join("\n");
}
