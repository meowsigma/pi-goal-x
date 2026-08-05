/**
 * Unified global goal settings.
 *
 * Reads `.pi/pi-goal-x-settings.json` with env var overrides:
 *   PI_GOAL_DISABLE_TASKS     — "true" to disable, any other value = use file config
 *   PI_GOAL_DISABLE_CONTRACTS — "true" to disable, any other value = use file config
 *   PI_GOAL_SETTINGS_FILE     — alternative settings file path (relative to cwd or absolute)
 *
 * The file may contain:
 *   disableTasks, disableContracts, subtaskDepth,
 *   provider, model, thinkingLevel, disabled
 *
 * additionalProperties: false — unknown keys are rejected.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface GoalSettings {
	disableTasks?: boolean;
	disableContracts?: boolean;
	subtaskDepth?: number;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	disabled?: boolean;
	autoSelectSingleGoal?: boolean;
	/** E3: load the project's own skills/extensions into auditor sessions (off by default = isolation). */
	auditorProjectResources?: boolean;
}

export const PI_GOAL_SETTINGS_FILE_ENV = "PI_GOAL_SETTINGS_FILE";

/**
 * mtime+size-keyed cache for the settings file (P1-1): loadGoalSettings is on
 * the per-turn hot path (before_agent_start, queueContinuation, tool gates,
 * widget render) and previously sync-read the file every call. The cache
 * turns steady-state loads into one statSync per call. saveGoalSettingsFileConfig
 * invalidates the entry it wrote.
 */
interface SettingsFileCacheEntry {
	mtimeMs: number;
	size: number;
	config: GoalSettings;
}

const settingsFileCache = new Map<string, SettingsFileCacheEntry>();

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const ALLOWED_SETTINGS_KEYS = new Set([
	"disableTasks",
	"disableContracts",
	"subtaskDepth",
	"provider",
	"model",
	"thinkingLevel",
	"thinking_level",
	"disabled",
	"autoSelectSingleGoal",
	"auditorProjectResources",
]);

/**
 * Resolve the path to the unified settings file.
 * Uses `PI_GOAL_SETTINGS_FILE` env var if set (relative to cwd or absolute).
 * Otherwise defaults to `.pi/pi-goal-x-settings.json`.
 */
export function goalSettingsPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = asNonEmptyString(env[PI_GOAL_SETTINGS_FILE_ENV]);
	if (override) {
		return path.isAbsolute(override) ? override : path.join(cwd, override);
	}
	return path.join(cwd, ".pi", "pi-goal-x-settings.json");
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBool(value: unknown): boolean | undefined {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	return undefined;
}

function asPositiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	if (typeof value === "string") {
		const n = parseInt(value, 10);
		if (!isNaN(n) && n >= 1) return n;
	}
	return undefined;
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	const text = asNonEmptyString(value);
	return text && THINKING_LEVELS.has(text) ? text as ThinkingLevel : undefined;
}

/**
 * Parse raw (deserialized JSON) into a GoalSettings object.
 * Rejects unknown keys (additionalProperties: false semantics).
 */
export function parseGoalSettings(raw: unknown): GoalSettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const unknownKeys = Object.keys(record).filter((k) => !ALLOWED_SETTINGS_KEYS.has(k));
	if (unknownKeys.length > 0) {
		throw new Error(`Unknown pi-goal-x-settings.json key(s): ${unknownKeys.join(", ")}`);
	}
	const settings: GoalSettings = {};
	const disableTasks = asBool(record.disableTasks);
	const disableContracts = asBool(record.disableContracts);
	const subtaskDepth = asPositiveInt(record.subtaskDepth);
	const provider = asNonEmptyString(record.provider);
	const model = asNonEmptyString(record.model);
	const thinkingLevel = asThinkingLevel(record.thinkingLevel ?? record.thinking_level);
	if (disableTasks !== undefined) settings.disableTasks = disableTasks;
	if (disableContracts !== undefined) settings.disableContracts = disableContracts;
	if (subtaskDepth !== undefined) settings.subtaskDepth = subtaskDepth;
	if (provider !== undefined) settings.provider = provider;
	if (model !== undefined) settings.model = model;
	if (thinkingLevel !== undefined) settings.thinkingLevel = thinkingLevel;
	if (record.disabled === true || record.disabled === "true") settings.disabled = true;
	if (record.autoSelectSingleGoal === true || record.autoSelectSingleGoal === "true") settings.autoSelectSingleGoal = true;
	if (record.auditorProjectResources === true || record.auditorProjectResources === "true") settings.auditorProjectResources = true;
	return settings;
}

/**
 * Load settings from the file on disk. Returns {} if file missing or invalid.
 * Cached by (resolved path, mtime, size) so steady-state reads are one stat.
 */
export function loadGoalSettingsFileConfig(cwd: string, env?: NodeJS.ProcessEnv): GoalSettings {
	const configPath = goalSettingsPath(cwd, env);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(configPath);
	} catch {
		settingsFileCache.delete(configPath);
		return {};
	}
	const cached = settingsFileCache.get(configPath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.config;
	}
	try {
		const config = parseGoalSettings(JSON.parse(fs.readFileSync(configPath, "utf8")));
		settingsFileCache.set(configPath, { mtimeMs: stat.mtimeMs, size: stat.size, config });
		return config;
	} catch {
		// malformed JSON, etc. — use defaults
		return {};
	}
}

/**
 * Load settings with env var overrides.
 * Env vars take precedence over file config.
 * Default: all flags false/undefined (features enabled, default model).
 */
export function loadGoalSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): GoalSettings {
	const fileConfig = loadGoalSettingsFileConfig(cwd, env);
	return {
		disableTasks: asBool(env.PI_GOAL_DISABLE_TASKS) ?? fileConfig.disableTasks ?? false,
		disableContracts: asBool(env.PI_GOAL_DISABLE_CONTRACTS) ?? fileConfig.disableContracts ?? false,
		subtaskDepth: fileConfig.subtaskDepth ?? 1,
		provider: fileConfig.provider,
		model: fileConfig.model,
		thinkingLevel: fileConfig.thinkingLevel,
		disabled: fileConfig.disabled,
		autoSelectSingleGoal: fileConfig.autoSelectSingleGoal ?? false,
	};
}

/**
 * Save settings to the unified settings file on disk.
 * Persists only non-default values using the canonical key names.
 */
/**
 * Determine whether the auditor should be enabled by default based on settings.
 * The auditor is enabled by default unless settings.disabled === true.
 */
/**
 * E2: which env var (if any) overrides a settings key's effective value.
 * Returns the env var name when it is set and affects the key, else null.
 */
export function envOverrideFor(key: keyof GoalSettings | "settingsFile", env: NodeJS.ProcessEnv = process.env): string | null {
	if (key === "disableTasks" && env.PI_GOAL_DISABLE_TASKS !== undefined) return "PI_GOAL_DISABLE_TASKS";
	if (key === "disableContracts" && env.PI_GOAL_DISABLE_CONTRACTS !== undefined) return "PI_GOAL_DISABLE_CONTRACTS";
	if (key === "settingsFile" && env[PI_GOAL_SETTINGS_FILE_ENV] !== undefined) return PI_GOAL_SETTINGS_FILE_ENV;
	return null;
}

/**
 * E2: effective-settings report with provenance (env vs file vs default),
 * surfaced by /goal-status.
 */
export function effectiveSettingsReport(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const fileConfig = loadGoalSettingsFileConfig(cwd, env);
	const effective = loadGoalSettings(cwd, env);
	const lines = ["Settings (provenance):"];
	const rows: Array<{ key: keyof GoalSettings; label: string; format: (v: GoalSettings) => string }> = [
		{ key: "autoSelectSingleGoal", label: "autoSelectSingleGoal", format: (v) => (v.autoSelectSingleGoal === true ? "true" : "false") },
		{ key: "disableContracts", label: "disableContracts", format: (v) => (v.disableContracts === true ? "true" : "false") },
		{ key: "disableTasks", label: "disableTasks", format: (v) => (v.disableTasks === true ? "true" : "false") },
		{ key: "subtaskDepth", label: "subtaskDepth", format: (v) => String(v.subtaskDepth ?? 1) },
		{ key: "disabled", label: "auditor disabled", format: (v) => (v.disabled === true ? "true" : "false") },
		{ key: "provider", label: "provider", format: (v) => v.provider ?? "(default)" },
		{ key: "model", label: "model", format: (v) => v.model ?? "(default)" },
		{ key: "thinkingLevel", label: "thinking_level", format: (v) => v.thinkingLevel ?? "(default)" },
		{ key: "auditorProjectResources", label: "auditor project resources", format: (v) => (v.auditorProjectResources === true ? "true" : "false") },
	];
	for (const row of rows) {
		const envVar = envOverrideFor(row.key, env);
		const value = row.format(effective);
		const source = envVar ? `env (${envVar})` : row.key in fileConfig ? "file" : "default";
		lines.push(`  ${row.label}: ${value} (${source})`);
	}
	lines.push(`  settings file: ${goalSettingsPath(cwd, env)}`);
	const fileOverride = envOverrideFor("settingsFile", env);
	if (fileOverride) lines.push(`  (settings file overridden by ${fileOverride})`);
	return lines;
}

export function isAuditorEnabledByDefault(settings: GoalSettings): boolean {
	return settings.disabled !== true;
}

export function saveGoalSettingsFileConfig(cwd: string, settings: GoalSettings): GoalSettings {
	const clean: GoalSettings = {};
	const provider = asNonEmptyString(settings.provider);
	const model = asNonEmptyString(settings.model);
	const thinkingLevel = asThinkingLevel(settings.thinkingLevel);
	const disableTasks = asBool(settings.disableTasks);
	const disableContracts = asBool(settings.disableContracts);
	const subtaskDepth = asPositiveInt(settings.subtaskDepth);
	if (provider) clean.provider = provider;
	if (model) clean.model = model;
	if (thinkingLevel) clean.thinkingLevel = thinkingLevel;
	if (settings.disabled === true) clean.disabled = true;
	if (disableTasks === true) clean.disableTasks = true;
	if (disableContracts === true) clean.disableContracts = true;
	if (subtaskDepth !== undefined) clean.subtaskDepth = subtaskDepth;
	if (settings.autoSelectSingleGoal === true) clean.autoSelectSingleGoal = true;
	if (settings.auditorProjectResources === true) clean.auditorProjectResources = true;
	const configPath = goalSettingsPath(cwd);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	settingsFileCache.delete(configPath);
	const persisted: Record<string, unknown> = {};
	if (clean.provider) persisted.provider = clean.provider;
	if (clean.model) persisted.model = clean.model;
	if (clean.thinkingLevel) persisted.thinking_level = clean.thinkingLevel;
	if (clean.disabled) persisted.disabled = true;
	if (clean.disableTasks) persisted.disableTasks = true;
	if (clean.disableContracts) persisted.disableContracts = true;
	if (clean.subtaskDepth !== undefined) persisted.subtaskDepth = clean.subtaskDepth;
	if (settings.autoSelectSingleGoal === true) persisted.autoSelectSingleGoal = true;
	if (settings.auditorProjectResources === true) persisted.auditorProjectResources = true;
	fs.writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
	return clean;
}
