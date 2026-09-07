import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const goalSource = process.env.PI_GOAL_EXTENSION_PATH ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/goal.ts");
const btwSource = process.env.PI_BTW_EXTENSION_PATH;
const hostRoot = process.env.PI_HOST_PACKAGE_ROOT;

if (!hostRoot || !btwSource) {
  console.log("SKIP native goal+BTW proof: set PI_HOST_PACKAGE_ROOT and PI_BTW_EXTENSION_PATH for the installed host and external BTW source.");
  process.exit(0);
}

const codingAgentRoot = path.join(hostRoot, "@earendil-works/pi-coding-agent");
const tuiRoot = process.env.PI_TUI_PACKAGE_ROOT ?? path.join(codingAgentRoot, "node_modules/@earendil-works/pi-tui");
const loader = await import(path.join(codingAgentRoot, "dist/core/extensions/loader.js"));
const { TuiMainScreen } = await import(path.join(tuiRoot, "dist/index.js"));
const { CustomEditor } = await import(path.join(codingAgentRoot, "dist/index.js"));
const { KeybindingsManager } = await import(path.join(codingAgentRoot, "dist/core/keybindings.js"));
const runtime = loader.createExtensionRuntime();
const handlers = new Map();
const commands = new Map();
const tools = new Map();
const sentMessages = [];
let terminalInput;
let activeTools = ["read", "bash", "edit", "write"];
runtime.sendMessage = (message) => sentMessages.push(message);
runtime.sendUserMessage = () => {};
runtime.appendEntry = () => {};
runtime.getActiveTools = () => activeTools;
runtime.getAllTools = () => activeTools;
runtime.setActiveTools = (next) => { activeTools = [...next]; };
runtime.refreshTools = () => {};
runtime.getThinkingLevel = () => "medium";
runtime.getContextUsage = () => undefined;

const terminal = { write() {}, hideCursor() {}, showCursor() {}, stop() {}, getWidth() { return 100; }, getHeight() { return 30; } };
const tui = new TuiMainScreen(terminal);
let overlay;
let overlayHandle;
const ui = {
  notify() {},
  onTerminalInput(callback) { terminalInput = callback; return () => {}; },
  setWidget() {}, setStatus() {}, setFooter() {}, setHeader() {}, setTitle() {}, setWorkingMessage() {}, setWorkingVisible() {},
  custom: async (factory, options) => {
    let done;
    const donePromise = new Promise((resolve) => { done = resolve; });
    const handle = await (async () => {
      overlay = await factory(
        tui,
        { fg: (_name, text) => text, bg: (_name, text) => text, italic: (text) => text, bold: (text) => text },
        { matches: () => false },
        done,
      );
      const createdHandle = tui.showOverlay(overlay, options?.overlayOptions);
      options?.onHandle?.(createdHandle);
      return createdHandle;
    })();
    overlayHandle = handle;
    try {
      await donePromise;
    } finally {
      handle.hide();
      if (overlayHandle === handle) overlayHandle = undefined;
    }
  },
  select: async () => undefined, confirm: async () => false, input: async () => undefined,
  pasteToEditor() {}, setEditorText() {}, getEditorText() { return ""; }, editor: async () => undefined,
  getAllThemes() { return []; }, getTheme() {}, setTheme() {}, getToolsExpanded() { return false; }, setToolsExpanded() {},
};
const proofCwd = mkdtempSync(path.join(os.tmpdir(), "pi-goal-btw-native-"));
mkdirSync(path.join(proofCwd, ".pi", "goals", "archived"), { recursive: true });
const globalSettingsFile = path.join(proofCwd, "global-settings.json");
writeFileSync(globalSettingsFile, "{}");
const previousGlobalSettingsFile = process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = globalSettingsFile;
const ctx = {
  cwd: proofCwd, hasUI: true, ui, model: undefined,
  modelRegistry: { getAvailable: () => [], find: () => undefined },
  sessionManager: { getBranch: () => [], getCwd: () => proofCwd, getSessionId: () => "native-goal-btw-proof", getRoot: () => proofCwd },
  getSystemPrompt: () => "base", isIdle: () => true, hasPendingMessages: () => false, abort() {},
};

const mainAbort = new AbortController();
const mainEditor = new CustomEditor(tui, { borderColor: (text) => text, selectList: {} }, new KeybindingsManager());
mainEditor.onEscape = () => mainAbort.abort();
tui.addChild(mainEditor);
tui.setFocus(mainEditor);

try {
  const loaded = await loader.loadExtensions([goalSource, btwSource], proofCwd, undefined, runtime);
  assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
  assert.ok(loaded.extensions.some((extension) => extension.path === goalSource), "goal source loaded by host loader");
  assert.ok(loaded.extensions.some((extension) => extension.path === btwSource), "BTW source loaded by host loader");
  for (const extension of loaded.extensions) {
    for (const [name, list] of extension.handlers) {
      const current = handlers.get(name) ?? [];
      current.push(...list);
      handlers.set(name, current);
    }
    for (const [name, definition] of extension.commands) commands.set(name, definition);
    for (const [name, definition] of extension.tools) tools.set(name, definition);
  }
  for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "native-proof" }, ctx);
  assert.ok(terminalInput, "actual goal Escape handler registered with host UI");
  let goalEscapeCalls = 0;
  tui.addInputListener((data) => {
    goalEscapeCalls++;
    return terminalInput(data);
  });

  const createGoal = tools.get("create_goal")?.definition;
  assert.ok(createGoal, "actual goal create_goal loaded");
  const created = await createGoal.execute("native-proof-goal", { objective: "Native goal+BTW Escape proof" }, undefined, undefined, ctx);
  const goalId = created.details?.goal?.id;
  const getGoal = tools.get("get_goal")?.definition;
  const btw = commands.get("btw");
  assert.ok(btw, "actual BTW command loaded");

  // Focused BTW: the goal listener sees the handoff but must not pause; BTW dismisses.
  await btw.handler("", ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(overlay && overlayHandle, "actual BTW overlay constructed");
  assert.deepEqual(globalThis.__pi_extension_focus_ownership_v1, {
    version: 1,
    owner: "btw",
    focused: true,
    controllerId: globalThis.__pi_extension_focus_ownership_v1.controllerId,
    overlayId: globalThis.__pi_extension_focus_ownership_v1.overlayId,
  });
  tui.handleTerminalInput("\x1b");
  assert.equal(globalThis.__pi_extension_focus_ownership_v1, undefined, "actual BTW dismisses and releases ownership");
  assert.equal(mainAbort.signal.aborted, false, "focused BTW Escape must not interrupt the main editor");
  let current = await getGoal?.execute("native-proof-status-1", { goal_id: goalId }, undefined, undefined, ctx);
  assert.match(String(current?.content?.[0]?.text), /running|active/);

  // Reopen the same real command, then make the visible handle unfocused.
  await btw.handler("", ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(overlayHandle && !overlayHandle.isHidden(), "reopened BTW handle remains visible");
  overlayHandle.unfocus();
  assert.equal(overlay.focused, false, "native handle unfocus propagates to the actual BTW component");
  assert.equal(mainEditor.focused, true, "native TUI restores main editor focus");
  assert.equal(globalThis.__pi_extension_focus_ownership_v1, undefined, "unfocused BTW releases ownership");

  // Unfocused BTW: main Escape reaches the real goal handler and abort path.
  tui.handleTerminalInput("\x1b");
  assert.equal(goalEscapeCalls, 2, "both Escapes traversed the actual goal input listener");
  assert.equal(mainAbort.signal.aborted, true, "native CustomEditor receives Escape and invokes main interruption");
  current = await getGoal?.execute("native-proof-status-2", { goal_id: goalId }, undefined, undefined, ctx);
  assert.match(String(current?.content?.[0]?.text), /paused/);
} finally {
  for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
  tui.stop?.();
  if (previousGlobalSettingsFile === undefined) delete process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;
  else process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = previousGlobalSettingsFile;
  rmSync(proofCwd, { recursive: true, force: true });
}

console.log("native goal+BTW host-loader/TUI lifecycle proof: passed");
