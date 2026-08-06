import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeRelPath, nowIso, safeIdPart, type GoalRecord } from "./goal-record.ts";

export const GOAL_LEDGER_FILE = ".pi/goals/goal_events.jsonl";

export type GoalLedgerEvent =
  | { type: "goal_created"; goalId: string; objective: string; sisyphus: boolean; autoContinue: boolean; at: string }
  | { type: "goal_focused"; goalId: string; reason: string; at: string }
  | { type: "goal_unfocused"; reason: string; at: string }
  | { type: "goal_paused"; goalId: string; reason: string; suggestedAction?: string; status?: "paused"; source?: "user" | "agent"; at: string }
  | { type: "goal_resumed"; goalId: string; reason: string; at: string }
  | { type: "goal_tweaked"; goalId: string; changeSummary: string; at: string }
  | { type: "completion_requested"; goalId: string; summary?: string; at: string }
  | { type: "audit_started"; goalId: string; provider?: string; model?: string; thinkingLevel?: string; at: string }
  | { type: "audit_result"; goalId: string; verdict: "approved" | "disapproved" | "error"; report: string; at: string }
  | { type: "audit_skipped"; goalId: string; reason: "disabled" | "user_aborted"; provider?: string; model?: string; thinkingLevel?: string; at: string }
  | { type: "goal_completed"; goalId: string; archivePath?: string; at: string }
  | { type: "goal_archived"; goalId: string; archivePath: string; at: string }
  | { type: "goal_archive_failed"; goalId: string; message: string; at: string }
  | { type: "goal_aborted"; goalId: string; reason: string; archivePath?: string; at: string }
  | { type: "task_list_set"; goalId: string; taskCount: number; blockCompletion: boolean; at: string }
  | { type: "task_complete"; goalId: string; taskId: string; evidence?: string; at: string }
  | { type: "task_skipped"; goalId: string; taskId: string; reason: string; at: string }
  | { type: "task_reopened"; goalId: string; taskId: string; at: string }
  | { type: "task_started"; goalId: string; taskId: string; at: string }
  | { type: "goal_budget_limited"; goalId: string; budget: number; tokensUsed: number; at: string }
  | { type: "goal_budget_warning"; goalId: string; budget: number; tokensUsed: number; pct: number; at: string }
  | { type: "goal_stalled"; goalId: string; reason: string; at: string }
  | { type: "goal_blocked"; goalId: string; reason: string; source: "agent" | "system"; at: string };

export interface GoalLedgerContext {
  cwd: string;
}

export interface GoalLedgerReadResult {
  events: GoalLedgerEvent[];
  malformed: number;
}

export interface ReconstructedGoalState {
  goalId: string;
  latestStatus: "active" | "paused" | "complete" | "aborted" | "unknown";
  latestFocus: boolean;
  latestPauseReason?: string;
  latestPauseSuggestedAction?: string;
  latestAuditorResult?: { verdict: "approved" | "disapproved" | "error"; report: string; at: string };
  createdAt?: string;
  completedAt?: string;
  abortedAt?: string;
  tweakedAt?: string;
  resumedAt?: string;
}

export interface ReconstructedLedgerState {
  focusedGoalId: string | null;
  goals: Map<string, ReconstructedGoalState>;
  terminalGoals: Map<string, ReconstructedGoalState>;
}

function safeGoalId(value: string): string {
  return safeIdPart(value);
}

export function goalLedgerPath(ctx: GoalLedgerContext): string {
  return path.resolve(ctx.cwd, normalizeRelPath(GOAL_LEDGER_FILE));
}

export type GoalLedgerAppendResult = { ok: true } | { ok: false; error: unknown };

/**
 * Append one ledger event. Returns a discriminated result instead of swallowing
 * both append attempts internally: the authoritative state write is never
 * rolled back after a ledger failure, but callers (GoalService) route failures
 * through the onDiagnostic hook so they stay observable.
 *
 * NAF: after a successful append the in-memory ledger cache is extended with
 * the same event (sanitized), so the next readGoalLedger is zero-op and
 * always current for extension-mediated writes.
 */
export function appendGoalEvent(ctx: GoalLedgerContext, event: GoalLedgerEvent): GoalLedgerAppendResult {
  const result = appendLedgerLines(ctx, [event]);
  return result;
}

/**
 * Append several ledger events as one line block with the existing
 * temp-write→read→append durability (P1-8): one mkdir, one temp write, one
 * append, one unlink instead of N× the same sequence. NAF: extends the
 * in-memory ledger cache in one step too.
 */
export function appendGoalEvents(ctx: GoalLedgerContext, events: GoalLedgerEvent[]): GoalLedgerAppendResult {
  if (events.length === 0) return { ok: true };
  return appendLedgerLines(ctx, events);
}

function appendLedgerLines(ctx: GoalLedgerContext, events: GoalLedgerEvent[]): GoalLedgerAppendResult {
  const filePath = goalLedgerPath(ctx);
  const dir = path.dirname(filePath);
  // NAF: per-dir memo — mkdir once per directory per process; steady-state
  // appends skip it entirely (0 ops for the dir).
  if (!ledgerDirsKnown.has(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      ledgerDirsKnown.add(dir);
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  const lines = events.map((event) => JSON.stringify(event) + "\n").join("");
  // NAF: direct O_APPEND write (one op) instead of the temp-write→read→append
  // dance — a single JSONL line (or one batched block) is appended atomically
  // by the OS; torn-line handling lives in the reader, not here.
  try {
    fs.appendFileSync(filePath, lines, "utf8");
  } catch (err) {
    return { ok: false, error: err };
  }
  extendLedgerCache(filePath, lines, events);
  return { ok: true };
}

/** Directories whose ledger file exists (per-dir mkdir memo). */
const ledgerDirsKnown = new Set<string>();

/**
 * Zero-op ledger cache (NAF 2026-08-06): keyed by absolute ledger path.
 * Steady-state reads serve the cache with no fs ops; appendGoalEvent(s)
 * extend it in memory (see extendLedgerCache). External (non-extension)
 * edits to the ledger go stale mid-session (documented in the naf spec).
 */
interface LedgerCacheEntry {
  size: number;
  mtimeMs: number;
  chars: number;
  events: GoalLedgerEvent[];
  malformed: number;
}

const ledgerCache = new Map<string, LedgerCacheEntry>();

/**
 * Session boundary (session_start / resume): drop the zero-op ledger cache so
 * a new session re-reads the ledger fresh from disk.
 */
export function invalidateGoalLedgerCache(): void {
	ledgerCache.clear();
}

/** Keep the zero-op ledger cache in sync with an in-process append (no fs ops). */
function extendLedgerCache(filePath: string, lines: string, events: GoalLedgerEvent[]): void {
  const cached = ledgerCache.get(filePath);
  if (!cached) return;
  const sanitized: GoalLedgerEvent[] = [];
  for (const event of events) sanitized.push(sanitizeEvent(event));
  ledgerCache.set(filePath, {
    size: cached.size + lines.length,
    mtimeMs: cached.mtimeMs,
    chars: cached.chars + lines.length,
    events: [...cached.events, ...sanitized],
    malformed: cached.malformed,
  });
}

export function readGoalLedger(ctx: GoalLedgerContext): GoalLedgerReadResult {
  const filePath = goalLedgerPath(ctx);
  const cached = ledgerCache.get(filePath);
  if (cached) {
    // NAF zero-op steady state: no stat, no read, no parse. The cache is kept
    // current by extendLedgerCache on every in-process append; external
    // (non-extension) edits to the ledger go stale mid-session (documented).
    return { events: cached.events, malformed: cached.malformed };
  }
  return readGoalLedgerCold(ctx, filePath);
}

/** Cold read: full file read + parse, populating the zero-op cache. */
function readGoalLedgerCold(ctx: GoalLedgerContext, filePath: string): GoalLedgerReadResult {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    // Missing or unreadable: cache the empty result so repeated reads are zero-op.
    ledgerCache.set(filePath, { size: 0, mtimeMs: 0, chars: 0, events: [], malformed: 0 });
    return { events: [], malformed: 0 };
  }
  const events: GoalLedgerEvent[] = [];
  let malformed = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isValidLedgerEvent(parsed)) {
        events.push(sanitizeEvent(parsed));
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  ledgerCache.set(filePath, { size: content.length, mtimeMs: 0, chars: content.length, events, malformed });
  return { events, malformed };
}

function isValidLedgerEvent(value: unknown): value is GoalLedgerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string") return false;
  if (typeof obj.at !== "string") return false;
  const type = obj.type as GoalLedgerEvent["type"];
  switch (type) {
    case "goal_created":
      return typeof obj.goalId === "string" && typeof obj.objective === "string" && typeof obj.sisyphus === "boolean" && typeof obj.autoContinue === "boolean";
    case "goal_focused":
      return typeof obj.goalId === "string" && typeof obj.reason === "string";
    case "goal_unfocused":
      return typeof obj.reason === "string";
    case "goal_paused":
      return typeof obj.goalId === "string" && typeof obj.reason === "string" && (obj.suggestedAction === undefined || typeof obj.suggestedAction === "string") && (obj.status === undefined || obj.status === "paused") && (obj.source === undefined || obj.source === "user" || obj.source === "agent");
    case "goal_resumed":
      return typeof obj.goalId === "string" && typeof obj.reason === "string";
    case "goal_tweaked":
      return typeof obj.goalId === "string" && typeof obj.changeSummary === "string";
    case "completion_requested":
      return typeof obj.goalId === "string" && (obj.summary === undefined || typeof obj.summary === "string");
    case "audit_started":
      return typeof obj.goalId === "string" && (obj.provider === undefined || typeof obj.provider === "string") && (obj.model === undefined || typeof obj.model === "string") && (obj.thinkingLevel === undefined || typeof obj.thinkingLevel === "string");
    case "audit_result":
      return typeof obj.goalId === "string" && (obj.verdict === "approved" || obj.verdict === "disapproved" || obj.verdict === "error") && typeof obj.report === "string";
    case "audit_skipped":
      return typeof obj.goalId === "string" && (obj.reason === "disabled" || obj.reason === "user_aborted") && (obj.provider === undefined || typeof obj.provider === "string") && (obj.model === undefined || typeof obj.model === "string") && (obj.thinkingLevel === undefined || typeof obj.thinkingLevel === "string");
    case "goal_completed":
      return typeof obj.goalId === "string" && (obj.archivePath === undefined || typeof obj.archivePath === "string");
    case "goal_archived":
      return typeof obj.goalId === "string" && typeof obj.archivePath === "string";
    case "goal_archive_failed":
      return typeof obj.goalId === "string" && typeof obj.message === "string";
    case "goal_aborted":
      return typeof obj.goalId === "string" && typeof obj.reason === "string" && (obj.archivePath === undefined || typeof obj.archivePath === "string");
    case "task_list_set":
      return typeof obj.goalId === "string" && typeof obj.taskCount === "number" && typeof obj.blockCompletion === "boolean";
    case "task_complete":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string" && (obj.evidence === undefined || typeof obj.evidence === "string");
    case "task_skipped":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string" && typeof obj.reason === "string";
    case "task_reopened":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string";
    case "task_started":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string";
    case "goal_budget_limited":
      return typeof obj.goalId === "string" && typeof obj.budget === "number" && typeof obj.tokensUsed === "number";
    case "goal_budget_warning":
      return typeof obj.goalId === "string" && typeof obj.budget === "number" && typeof obj.tokensUsed === "number" && typeof obj.pct === "number";
    case "goal_stalled":
      return typeof obj.goalId === "string" && typeof obj.reason === "string";
    case "goal_blocked":
      return typeof obj.goalId === "string" && typeof obj.reason === "string" && (obj.source === "agent" || obj.source === "system");
    default:
      return false;
  }
}

function sanitizeEvent(event: GoalLedgerEvent): GoalLedgerEvent {
  switch (event.type) {
    case "goal_created":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_focused":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_paused":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_resumed":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_tweaked":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "completion_requested":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "audit_started":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "audit_result":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "audit_skipped":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_completed":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_archived":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_archive_failed":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_aborted":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "task_list_set":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "task_complete":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "task_skipped":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "task_reopened":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "task_started":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_budget_limited":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_budget_warning":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_stalled":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_blocked":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_unfocused":
      return event;
  }
}

export function reconstructGoalLedger(events: GoalLedgerEvent[]): ReconstructedLedgerState {
  const goals = new Map<string, ReconstructedGoalState>();
  const terminalGoals = new Map<string, ReconstructedGoalState>();
  let focusedGoalId: string | null = null;
  // NAF: generation-based focus tracking — a focus event bumps a counter and
  // records the generation on the focused goal (O(1)) instead of clearing
  // every goal's flag (O(goals) per focus event, quadratic on focus-dense
  // ledgers). latestFocus is materialized once at the end.
  let focusGeneration = 0;
  const focusGenByGoal = new Map<string, number>();

  for (const event of events) {
    switch (event.type) {
      case "goal_created": {
        const state: ReconstructedGoalState = {
          goalId: event.goalId,
          latestStatus: "active",
          latestFocus: false,
          createdAt: event.at,
        };
        goals.set(event.goalId, state);
        break;
      }
      case "goal_focused": {
        focusedGoalId = event.goalId;
        focusGeneration++;
        const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
        if (state) focusGenByGoal.set(event.goalId, focusGeneration);
        break;
      }
      case "goal_unfocused": {
        focusedGoalId = null;
        focusGeneration++;
        break;
      }
      case "goal_paused": {
        const state = goals.get(event.goalId);
        if (state) {
          state.latestStatus = event.status ?? "paused";
          state.latestPauseReason = event.reason;
          state.latestPauseSuggestedAction = event.suggestedAction;
        }
        break;
      }
      case "goal_resumed": {
        const state = goals.get(event.goalId);
        if (state) {
          state.latestStatus = "active";
          state.resumedAt = event.at;
          delete state.latestPauseReason;
          delete state.latestPauseSuggestedAction;
        }
        break;
      }
      case "goal_tweaked": {
        const state = goals.get(event.goalId);
        if (state) state.tweakedAt = event.at;
        break;
      }
      case "completion_requested": {
        // No status change until audit_result or goal_completed
        break;
      }
      case "audit_started": {
        // No state change
        break;
      }
      case "audit_skipped": {
        // audit was skipped; goal continues as-is
        break;
      }
      case "audit_result": {
        const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
        if (state) {
          state.latestAuditorResult = { verdict: event.verdict, report: event.report, at: event.at };
        }
        break;
      }
      case "goal_completed": {
        let state = goals.get(event.goalId);
        if (!state) {
          state = { goalId: event.goalId, latestStatus: "complete", latestFocus: false };        }
        state.latestStatus = "complete";
        state.completedAt = event.at;
        terminalGoals.set(event.goalId, state);
        goals.delete(event.goalId);
        break;
      }
      case "goal_aborted": {
        let state = goals.get(event.goalId);
        if (!state) {
          state = { goalId: event.goalId, latestStatus: "aborted", latestFocus: false };        }
        state.latestStatus = "aborted";
        state.abortedAt = event.at;
        terminalGoals.set(event.goalId, state);
        goals.delete(event.goalId);
        break;
      }
    }
  }

  // Materialize the generation-based focus flags (O(goals) once, not per event).
  for (const g of goals.values()) g.latestFocus = focusGenByGoal.get(g.goalId) === focusGeneration;
  for (const g of terminalGoals.values()) g.latestFocus = focusGenByGoal.get(g.goalId) === focusGeneration;

  // If the focused goal was moved to terminal (e.g., aborted/completed), clear focus.
  if (focusedGoalId && !goals.has(focusedGoalId)) {
    focusedGoalId = null;
  }

  return { focusedGoalId, goals, terminalGoals };
}

export function latestAuditorResultForGoal(events: GoalLedgerEvent[], goalId: string): { verdict: "approved" | "disapproved" | "error"; report: string; at: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "audit_result" && event.goalId === goalId) {
      return { verdict: event.verdict, report: event.report, at: event.at };
    }
  }
  return undefined;
}

export function latestEventsForGoal(events: GoalLedgerEvent[], goalId: string, limit = 10): GoalLedgerEvent[] {
  const result: GoalLedgerEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if ("goalId" in event && event.goalId === goalId) {
      result.unshift(event);
      if (result.length >= limit) break;
    }
  }
  return result;
}

export function latestGoalLifecycleEvent(events: GoalLedgerEvent[], goalId: string): GoalLedgerEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if ("goalId" in event && event.goalId === goalId) {
      return event;
    }
  }
  return undefined;
}
