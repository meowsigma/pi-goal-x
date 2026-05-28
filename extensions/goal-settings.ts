/**
 * Global goal settings: config file + env var overrides for disabling
 * task lists and/or verification contracts.
 *
 * Reads `.pi/goal-settings.json` with env var overrides:
 *   PI_GOAL_DISABLE_TASKS     — "true" to disable, any other value = use file config
 *   PI_GOAL_DISABLE_CONTRACTS — "true" to disable, any other value = use file config
 *
 * Pattern mirrors `goalAuditorConfig` in goal-auditor.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface GoalSettings {
	disableTasks?: boolean;
	disableContracts?: boolean;
}

/**
 * Resolve the path to the global goal-settings.json file.
 */
export function goalSettingsPath(cwd: string): string {
	return path.join(cwd, ".pi", "goal-settings.json");
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBool(value: unknown): boolean | undefined {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	return undefined;
}

const ALLOWED_SETTINGS_KEYS = new Set(["disableTasks", "disableContracts"]);

/**
 * Parse raw (deserialized JSON) into a GoalSettings object.
 * Rejects unknown keys (additionalProperties: false semantics).
 */
export function parseGoalSettings(raw: unknown): GoalSettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const unknownKeys = Object.keys(record).filter((k) => !ALLOWED_SETTINGS_KEYS.has(k));
	if (unknownKeys.length > 0) {
		throw new Error(`Unknown goal-settings.json key(s): ${unknownKeys.join(", ")}`);
	}
	const settings: GoalSettings = {};
	const disableTasks = asBool(record.disableTasks);
	const disableContracts = asBool(record.disableContracts);
	if (disableTasks !== undefined) settings.disableTasks = disableTasks;
	if (disableContracts !== undefined) settings.disableContracts = disableContracts;
	return settings;
}

/**
 * Load settings from the file on disk. Returns {} if file missing or invalid.
 */
export function loadGoalSettingsFileConfig(cwd: string): GoalSettings {
	try {
		const configPath = goalSettingsPath(cwd);
		if (fs.existsSync(configPath)) return parseGoalSettings(JSON.parse(fs.readFileSync(configPath, "utf8")));
	} catch {
		// file missing, malformed JSON, etc. — use defaults
	}
	return {};
}

/**
 * Load settings with env var overrides.
 * Env vars take precedence over file config.
 * Default: both flags false (features enabled).
 */
export function loadGoalSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): GoalSettings {
	const fileConfig = loadGoalSettingsFileConfig(cwd);
	return {
		disableTasks: asBool(env.PI_GOAL_DISABLE_TASKS) ?? fileConfig.disableTasks ?? false,
		disableContracts: asBool(env.PI_GOAL_DISABLE_CONTRACTS) ?? fileConfig.disableContracts ?? false,
	};
}
