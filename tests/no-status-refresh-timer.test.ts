import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../extensions/goal.ts", import.meta.url), "utf8");

test("goal.ts does not schedule a periodic status-refresh timer while goals are active", () => {
	// PR #5 removed the 1s status refresh interval that forced TUI redraws
	// (ui.setStatus + goalWidgetComponent.update), pulling users out of
	// terminal scrollback while reviewing long goals. Reintroducing a
	// STATUS_REFRESH_MS constant or a statusRefreshTimer would regress that.
	assert.doesNotMatch(source, /STATUS_REFRESH_MS/);
	assert.doesNotMatch(source, /statusRefreshTimer/);
	assert.doesNotMatch(source, /syncStatusRefresh/);
	assert.doesNotMatch(source, /stopStatusRefresh/);
});

test("goal.ts still updates the widget and footer status on state changes", () => {
	// The widget reads live values through closures; updateUI still requests
	// renders on state changes so elapsed time catches up on natural renders.
	assert.match(source, /goalWidgetComponent\?\.update\(\)/);
	assert.match(source, /ctx\.ui\.setStatus\("goal"/);
});
