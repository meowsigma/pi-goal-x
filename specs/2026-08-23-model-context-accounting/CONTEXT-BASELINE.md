# Context baseline — main @ 2026-08-23 (post PR A/B/C)

Measured by `npm run context:measure`; artifact `experiments/context/baseline-main.json`.

Headline rows (chars):

| fixture | total | ext system | tool schemas | messages | hist checkpoints |
|---|---|---|---|---|---|
| active-regular-no-tasks | 8,920 | 1,441 | 7,262 | 202 | 0 |
| active-regular-10-tasks | 9,655 | 2,176 | 7,262 | 202 | 0 |
| active-regular-50-tasks | 9,945 | 2,466 | 7,262 | 202 | 0 |
| long-objective | ~12K | ~4.5K | 7,262 | ~208 | 0 |
| stale-checkpoint | 7,767 | 386 (GOAL STALE) | 7,262 | 76 | 0 |

Key facts this baseline pins:

1. Active goal tools cost ~7,262 serialized chars per request regardless of
   prompt content — previously unmeasured by B4.
2. Historical checkpoint payload is 0 on every fixture (issue #30 fix holds
   at the composed-request level).
3. Objective appears exactly once in every active-block request; verification
   contract exactly once when present.

Later optimization PRs (E/F) must show composed-request reductions against
this table while keeping these single-source invariants. Update
`baseline-main.json` only together with a rationale here.
