import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Best-effort diagnostics, never an authority channel or a full request log. */
export const GOAL_DIAGNOSTIC_LIMIT = 64;
const MAX_FILE_BYTES = 262_144;

export function diagnosticHash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value) ?? "").digest("hex");
}

/** Redact before truncation, including quoted JSON and multi-word auth values.
 * This handles common credential formats, not arbitrary unlabeled secrets.
 * Callers must still omit headers, inputs and full payloads by construction. */
export function redactDiagnosticText(value: string, limit = 500): string {
  return value.slice(0, 65_536)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, "[redacted private key]")
    .replace(/(["']?\b(?:password|passwd|token|access_token|refresh_token|api[_-]?key|authorization|secret|client_secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;}]+)/giu, "$1[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[\w.~+/-]+=*/giu, "[redacted authorization]")
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|glpat-[\w-]{12,})\b/gu, "[redacted credential]")
    .slice(0, limit);
}

function sanitized(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactDiagnosticText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null || typeof value === "boolean") return value;
  if (depth > 3) return "[omitted]";
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitized(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [key, sanitized(item, depth + 1)]));
  return undefined;
}

export function recordGoalDiagnostic(ctx: { cwd: string }, record: Record<string, unknown>): void {
  try {
    const file = path.join(ctx.cwd, ".pi", "goals", "diagnostics.json");
    let prior: unknown[] = [];
    try {
      if (statSync(file).size <= MAX_FILE_BYTES) {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(parsed)) prior = parsed.slice(-(GOAL_DIAGNOSTIC_LIMIT - 1));
      }
    } catch { /* absent or damaged diagnostics are disposable */ }
    const next = sanitized({ ...record, at: new Date().toISOString() });
    const records = [...prior, next];
    let content = JSON.stringify(records);
    while (Buffer.byteLength(content) > MAX_FILE_BYTES && records.length > 1) {
      records.shift(); content = JSON.stringify(records);
    }
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) return;
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, file);
  } catch { /* never alter lifecycle/authorization due to diagnostic failure */ }
}

function sourceSnapshot(directory: string): string {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? [`${entry.name}/${sourceSnapshot(file)}`] : entry.isFile() && entry.name.endsWith(".ts") ? [`${entry.name}:${diagnosticHash(readFileSync(file, "utf8"))}`] : [];
  }).join("\n");
}

// Source bytes observed at module initialization, NOT binary/wire attestation.
export const GOAL_SOURCE_HASH = (() => {
  try { return diagnosticHash(sourceSnapshot(path.dirname(fileURLToPath(import.meta.url)))); }
  catch { return "unavailable"; }
})();
