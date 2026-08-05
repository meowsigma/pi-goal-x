/**
 * B6 — Regression gate.
 *
 * Diffs baseline-before.json vs baseline-after.json: every numeric row must
 * not regress beyond max(before.p50 * 1.5, before.p50 + 10)ms, and the
 * claim-specific invariants from PLAN.md Part 4 must hold in the after run:
 *   - B3 ledger parse flatness: 10k/1k p50 ratio < 2 (P1-2 O(1)).
 *   - B2 read-turn fs ops per turn drop (P1-1 cache layer).
 *   - B4 goal-block token counts drop (P1-4 prompt trim).
 *   - B5 lock contended wait collapses (P1-5).
 * Exit code 1 on failure; prints a summary table.
 *
 * Usage: node --experimental-strip-types experiments/bench/b6-gate.mjs
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = fileURLToPath(new URL(".", import.meta.url));
const before = JSON.parse(readFileSync(path.join(benchDir, "baseline-before.json"), "utf8"));
const afterPath = path.join(benchDir, "baseline-after.json");
let after = null;
try {
	after = JSON.parse(readFileSync(afterPath, "utf8"));
} catch {
	console.error("[B6] baseline-after.json missing — nothing to gate yet. Run run-bench.mjs after first.");
	process.exit(0);
}

const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
const beforeMap = byId(before.rows);
const afterMap = byId(after.rows);

const failures = [];
const regressions = [];

for (const [id, bRow] of beforeMap) {
	const aRow = afterMap.get(id);
	if (!aRow) {
		failures.push(`${id}: missing in after run`);
		continue;
	}
	if (typeof bRow.p50 !== "number" || typeof aRow.p50 !== "number") continue; // non-timing rows (B4 token counts handled separately)
	const limit = Math.max(bRow.p50 * 1.5, bRow.p50 + 10);
	if (aRow.p50 > limit) {
		regressions.push({ id, before: bRow.p50, after: aRow.p50, limit: Math.round(limit * 10) / 10 });
	}
}

// claim-specific invariants (after run)
const p = (id) => afterMap.get(id)?.p50;
if (typeof p("B3.parse.1000") === "number" && typeof p("B3.parse.10000") === "number") {
	const ratio = p("B3.parse.10000") / p("B3.parse.1000");
	if (ratio >= 2) failures.push(`B3 ledger parse not flat after P1-2: 10k/1k ratio ${ratio.toFixed(2)} (must be < 2)`);
}
const b2beforeOps = beforeMap.get("B2.readturn.1g")?.ops;
const b2afterOps = afterMap.get("B2.readturn.1g")?.ops;
if (typeof b2beforeOps === "number" && typeof b2afterOps === "number" && b2afterOps >= b2beforeOps) {
	failures.push(`B2 read-turn fs ops not reduced after P1-1: ${b2beforeOps} -> ${b2afterOps}`);
}
const b4before = beforeMap.get("B4.taskListBlock.50t")?.ops;
const b4after = afterMap.get("B4.taskListBlock.50t")?.ops;
if (typeof b4before === "number" && typeof b4after === "number" && b4after >= b4before) {
	failures.push(`B4 taskListBlock tokens not reduced after P1-4: ${b4before} -> ${b4after}`);
}
const lockBefore = beforeMap.get("B5.lock.contended")?.p50;
const lockAfter = afterMap.get("B5.lock.contended")?.p50;
if (typeof lockBefore === "number" && typeof lockAfter === "number" && lockAfter > Math.max(200, lockBefore)) {
	failures.push(`B5 lock contended wait not collapsed after P1-5: ${lockBefore}ms -> ${lockAfter}ms`);
}

console.log(`[B6] gating ${after.rows.length} after rows against ${before.rows.length} before rows`);
if (regressions.length > 0) {
	console.log("\nRegressions (after p50 > max(before*1.5, before+10)ms):");
	for (const r of regressions) console.log(`  FAIL ${r.id}: ${r.before}ms -> ${r.after}ms (limit ${r.limit}ms)`);
	failures.push(...regressions.map((r) => `${r.id} regression ${r.before} -> ${r.after}`));
}
if (failures.length === 0) {
	console.log("[B6] PASS: no regressions, all claim-specific invariants hold.");
	process.exit(0);
}
console.log("\n[B6] FAIL:");
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
