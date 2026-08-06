# Tech: Fix open issues #15–#22

## Affected files

| Issue | File | Change |
|---|---|---|
| #19 | `extensions/goal-commands.ts` | `positiveInteger` settings branch: row-driven lower bound via `row.key === "stallTimeoutMinutes" ? 0 : 1`; message adjusted per row |
| #20 | `extensions/goal-auditor.ts` | `parseAuditorDecision`: parse the last non-empty line, exact-match the marker |
| #21 | `extensions/goal-auditor.ts` | `buildGoalAuditorPrompt`: escape `&`, `<`, `>` in interpolated payloads (objective, executor claim, goal details, verification contract, warm context) |
| #22 | `extensions/goal-core-tools.ts` | `runGoalBlockedFlow` + `runGoalAgentPauseFlow`: return the `apply` failure message and `terminate: false` when `!result.ok` |

## #19 detail

`settingsValue()` already defaults `stallTimeoutMinutes` to `"0"` and
`subtaskDepth` to `"1"`, and the save already uses `[key]`. Only the
validation branch is hard-coded:

```ts
if (!/^[0-9]+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) < 1) {
```

Becomes (min per row, message includes the row-specific lower bound):

```ts
const min = row.key === "stallTimeoutMinutes" ? 0 : 1;
if (!/^[0-9]+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) < min) {
```

## #20 detail

```ts
export function parseAuditorDecision(output: string): { approved: boolean; disapproved: boolean } {
	const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
	const marker = lines[lines.length - 1];
	return { approved: marker === "<approved/>", disapproved: marker === "<disapproved/>" };
}
```

Existing test `parseAuditorDecision("confused <approved/> <disapproved/>")`
expected `{ approved: false, disapproved: true }`; with final-line parsing it
becomes `{ approved: false, disapproved: false }` (no marker on the final
line). Update that assertion and add: mid-report prose mention does not
approve; marker must be the last non-empty line.

## #21 detail

```ts
function escapePromptPayload(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

Apply to every model/operator-controlled payload inserted between delimiters
in `buildGoalAuditorPrompt`: `args.goal.objective`,
`args.completionSummary`, `args.detailedSummary`,
`args.goal.verificationContract`, `args.warmContext`. Escaped entities are
still human-readable to the auditor; the literal `<`/`>` cannot form a closing
delimiter.

## #22 detail

Follow the existing `runGoalCompletionFlow` failure pattern (see
`commitGoalCompletion` in `extensions/goal-completion.ts`): on `!result.ok`
return `{ content: [text: "Goal <X> update failed: <message>. The goal was not
<blocked|paused>."], details: goalDetails(...), terminate: false }` and skip
the side effects (clearContinuationState, markTurnStopped, updateUI). Tests
monkey-patch `core.goalService.apply` to return `{ ok: false, message: ... }`
and assert the result text surfaces the message and `terminate` is not true.

## Tests

- `tests/goal-auditor.test.ts` — extend `parseAuditorDecision` coverage; add
  delimiter-escape coverage for `buildGoalAuditorPrompt` (objective containing
  `</objective>` and completion summary containing `<approved/>` prose must not
  close blocks / leak markers).
- `tests/goal-core-tools.test.ts` — add blocked/pause failure-branch tests via
  `goalService.apply` monkey-patch.
- `tests/goal-command-palette.test.ts` or a settings-focused test — #19 lower
  bound coverage (validation helper is inline in the UI loop; test via the
  menu's `ui.input` custom harness if practical, else document manual check).
