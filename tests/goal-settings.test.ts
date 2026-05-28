/**
 * Tests for the goal settings system (.pi/goal-settings.json + env var overrides).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
	goalSettingsPath,
	parseGoalSettings,
	loadGoalSettingsFileConfig,
	loadGoalSettings,
	type GoalSettings,
} from "../extensions/goal-settings.ts";

// ── parseGoalSettings ───────────────────────────────────────────────────

test("parseGoalSettings: null/undefined returns empty defaults", () => {
	assert.deepEqual(parseGoalSettings(null), {});
	assert.deepEqual(parseGoalSettings(undefined as unknown), {});
	assert.deepEqual(parseGoalSettings(""), {});
	assert.deepEqual(parseGoalSettings(42), {});
	assert.deepEqual(parseGoalSettings([]), {});
});

test("parseGoalSettings: empty object returns empty defaults", () => {
	assert.deepEqual(parseGoalSettings({}), {});
});

test("parseGoalSettings: both flags false returns false defaults", () => {
	const result = parseGoalSettings({ disableTasks: false, disableContracts: false });
	assert.equal(result.disableTasks, false);
	assert.equal(result.disableContracts, false);
});

test("parseGoalSettings: both flags true", () => {
	const result = parseGoalSettings({ disableTasks: true, disableContracts: true });
	assert.equal(result.disableTasks, true);
	assert.equal(result.disableContracts, true);
});

test("parseGoalSettings: boolean false stored correctly", () => {
	const result = parseGoalSettings({ disableTasks: false, disableContracts: true });
	assert.equal(result.disableTasks, false);
	assert.equal(result.disableContracts, true);
});

test("parseGoalSettings: string true/false values accepted", () => {
	assert.deepEqual(parseGoalSettings({ disableTasks: "true", disableContracts: "false" }), {
		disableTasks: true,
		disableContracts: false,
	});
});

test("parseGoalSettings: unknown keys ignored", () => {
	const result = parseGoalSettings({ disableTasks: true, disableContracts: false, foo: "bar" });
	assert.deepEqual(result, { disableTasks: true, disableContracts: false });
});

// ── goalSettingsPath ────────────────────────────────────────────────────

test("goalSettingsPath: resolves under .pi/", () => {
	const p = goalSettingsPath("/tmp/project");
	assert.ok(p.endsWith(path.join(".pi", "goal-settings.json")));
	assert.ok(p.startsWith("/tmp/project"));
});

// ── loadGoalSettingsFileConfig ──────────────────────────────────────────

function withTempDir(fn: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-settings-test-"));
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("loadGoalSettingsFileConfig: missing file returns empty defaults", () => {
	withTempDir((dir) => {
		const result = loadGoalSettingsFileConfig(dir);
		assert.deepEqual(result, {});
	});
});

test("loadGoalSettingsFileConfig: reads valid file config", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: true, disableContracts: false }), "utf8");
		const result = loadGoalSettingsFileConfig(dir);
		assert.equal(result.disableTasks, true);
		assert.equal(result.disableContracts, false);
	});
});

test("loadGoalSettingsFileConfig: malformed JSON returns empty defaults", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, "not-json", "utf8");
		const result = loadGoalSettingsFileConfig(dir);
		assert.deepEqual(result, {});
	});
});

// ── loadGoalSettings (env var overrides) ────────────────────────────────

test("loadGoalSettings: no file, no env vars -> defaults false", () => {
	withTempDir((dir) => {
		const result = loadGoalSettings(dir, {});
		assert.equal(result.disableTasks, false);
		assert.equal(result.disableContracts, false);
	});
});

test("loadGoalSettings: env vars override file config", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		// File says both should true
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: true, disableContracts: true }), "utf8");
		// Env says only disableTasks should be false (overriding file)
		const result = loadGoalSettings(dir, { PI_GOAL_DISABLE_TASKS: "false", PI_GOAL_DISABLE_CONTRACTS: "true" });
		assert.equal(result.disableTasks, false, "env override should win");
		assert.equal(result.disableContracts, true, "file value used when no env override");
	});
});

test("loadGoalSettings: env var true overrides file false", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: false, disableContracts: false }), "utf8");
		const result = loadGoalSettings(dir, { PI_GOAL_DISABLE_TASKS: "true" });
		assert.equal(result.disableTasks, true);
		assert.equal(result.disableContracts, false);
	});
});

test("loadGoalSettings: env var absent falls back to file", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: true, disableContracts: true }), "utf8");
		const result = loadGoalSettings(dir, { SOME_OTHER_VAR: "x" });
		assert.equal(result.disableTasks, true);
		assert.equal(result.disableContracts, true);
	});
});

test("loadGoalSettings: env var non-true values treated as absent", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: false, disableContracts: false }), "utf8");
		const result = loadGoalSettings(dir, { PI_GOAL_DISABLE_TASKS: "1", PI_GOAL_DISABLE_CONTRACTS: "" });
		assert.equal(result.disableTasks, false, "1 is not 'true'");
		assert.equal(result.disableContracts, false, "empty string treated as absent");
	});
});

test("loadGoalSettings: no file, env var true", () => {
	withTempDir((dir) => {
		const result = loadGoalSettings(dir, { PI_GOAL_DISABLE_TASKS: "true", PI_GOAL_DISABLE_CONTRACTS: "true" });
		assert.equal(result.disableTasks, true);
		assert.equal(result.disableContracts, true);
	});
});

test("loadGoalSettings: both flags disabled via file", () => {
	withTempDir((dir) => {
		const configPath = goalSettingsPath(dir);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ disableTasks: true, disableContracts: true }), "utf8");
		const result = loadGoalSettings(dir, {});
		assert.equal(result.disableTasks, true);
		assert.equal(result.disableContracts, true);
	});
});
