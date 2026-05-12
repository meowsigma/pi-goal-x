# pi-autoresearch — Architecture Survey

A deep read of [`pi-autoresearch`](https://github.com/davebcn87/pi-autoresearch) by David Cortés (v1.4.0, MIT, ~4.6kLOC), with a view to porting an "auto-research" sister mode to `@capyup/pi-goal`. Source mirror at `/tmp/pi-autoresearch/`.

This document is internal context for the design conversation. It is **descriptive of upstream**, then **prescriptive about what to borrow** for our goal extension.

---

## 1. What pi-autoresearch is

> *"Try an idea, measure it, keep what works, discard what doesn't, repeat forever."*

A pi extension that gives the agent an **autonomous experiment loop**. The user names a metric (test speed, bundle KB, val_bpb, Lighthouse score, ...); the agent then iterates: edit code → benchmark → log → `git keep` or revert → propose next idea → repeat indefinitely, until the user interrupts.

It is **domain-agnostic infrastructure**: 3 tools + a CLI command + a live dashboard + an optional hook system. Domain knowledge (what to optimize, with what command) lives in a one-shot **skill** (`autoresearch-create`) that interviews the user, materializes `autoresearch.md` + `autoresearch.sh`, runs the baseline, and hands control to the loop.

Two on-disk files keep the session alive across **agent restarts, pi auto-compaction, and full context resets**:

- `autoresearch.jsonl` — append-only log of every run (one JSON line per `init_experiment` config, per `log_experiment` result, and per hook fire).
- `autoresearch.md` — living "session rules" document — objective, metric, files in scope, what's been tried, dead ends.

A fresh agent with empty context can read those two files plus `git log` and continue exactly where the previous one stopped. This is the **defining design move** of pi-autoresearch and the single thing most worth borrowing.

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch); current release is **v1.4.0** (configurable shortcuts), published on npm.

---

## 2. Repository layout

```
pi-autoresearch/
├── extensions/pi-autoresearch/
│   ├── index.ts            (3038L)  main extension: tools, command, widget, dashboard server, lifecycle hooks
│   ├── compaction.ts       ( 247L)  deterministic compaction summary builder
│   ├── jsonl.ts            ( 192L)  jsonl reader / state reconstructor
│   ├── hooks.ts            ( 185L)  before.sh / after.sh runner + jsonl observability
│   └── shortcuts.ts        ( 105L)  per-profile shortcut config loader
├── skills/
│   ├── autoresearch-create/SKILL.md      (interview + scaffold + start loop)
│   ├── autoresearch-finalize/SKILL.md    (split noisy branch into clean reviewable branches)
│   └── autoresearch-hooks/SKILL.md       (author before.sh/after.sh, with reference examples)
├── tests/                                    (~1.5kLOC of node:test + bash)
├── assets/                                   (template.html, logo.webp for /export)
├── README.md
└── CHANGELOG.md
```

Total: ~4.6kLOC of TypeScript + Markdown.

---

## 3. Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│  pi session                                                          │
│                                                                      │
│   user types: /autoresearch optimize test speed                      │
│       │                                                              │
│       ▼                                                              │
│  pi.registerCommand("autoresearch")     ──── (or) ───► /skill:autoresearch-create
│       │                                                  (one-shot setup agent)
│       ▼                                                                                                                       
│  runtime.autoresearchMode = true                                     │
│  hook before.sh fires (if present)                                   │
│  pi.sendUserMessage(kickoff)                                         │
│                                                                      │
│  ┌────────────────────────  LOOP  ────────────────────────────────┐  │
│  │                                                                │  │
│  │   agent reads autoresearch.md, picks hypothesis                │  │
│  │      │                                                         │  │
│  │      ▼                                                         │  │
│  │   edit code in scope                                           │  │
│  │      │                                                         │  │
│  │      ▼                                                         │  │
│  │   run_experiment("bash autoresearch.sh")                       │  │
│  │      ├── spawn("bash -c ...") with streaming tail              │  │
│  │      ├── parse `METRIC name=value` lines from stdout           │  │
│  │      ├── if autoresearch.checks.sh exists → run it             │  │
│  │      └── return {passed, parsedPrimary, parsedMetrics, ...}    │  │
│  │      │                                                         │  │
│  │      ▼                                                         │  │
│  │   log_experiment({commit, metric, status, description, asi})   │  │
│  │      ├── push ExperimentResult into runtime.state.results      │  │
│  │      ├── compute confidence = |best_delta| / MAD               │  │
│  │      ├── if status=="keep": git add -A && git commit           │  │
│  │      ├── else:              git checkout -- . (autoresearch.*) │  │
│  │      ├── append entry to autoresearch.jsonl                    │  │
│  │      ├── fire after.sh hook (steer if non-empty stdout)        │  │
│  │      ├── fire before.sh hook for the NEXT iteration            │  │
│  │      ├── broadcastDashboardUpdate(workDir) (SSE to /export)    │  │
│  │      └── updateWidget(ctx)                                     │  │
│  │      │                                                         │  │
│  │      ▼                                                         │  │
│  │   pi.on("agent_end")                                           │  │
│  │      └── ensurePendingResume → setTimeout 800ms → sendUserMessage("Run the next iteration...")  │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  pi.on("session_before_compact") ──► inject deterministic summary    │
│      built from autoresearch.jsonl + autoresearch.md + ideas.md      │
│                                                                      │
│  pi.on("session_compact") ──► ensurePendingResume (compaction msg)   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Layer map

| Layer | Responsibility | File(s) |
|---|---|---|
| **State machine** | `AutoresearchRuntime` (mode, dashboardExpanded, pendingResumeTimer, experimentsThisSession), `ExperimentState` (results, segments, secondaryMetrics, confidence) | `index.ts` 90–145, 618–676 |
| **Persistence — write** | `autoresearch.jsonl` append on init/log/hook; `autoresearch.md` written by skill, never by extension | `index.ts` 1700–1750, 2360–2410 |
| **Persistence — read** | `reconstructJsonlState` rebuilds `ExperimentState` from disk on `session_start` / `session_tree` | `jsonl.ts`, `index.ts` 1202–1280 |
| **Tools** | `init_experiment` (one-shot config), `run_experiment` (spawn, time, capture, METRIC parse), `log_experiment` (record, git, hook, resume) | `index.ts` 1542–2655 |
| **Command** | `/autoresearch <text\|off\|clear\|export>` | `index.ts` 2941–3035 |
| **Live UI** | above-editor widget (`updateWidget`), expand/collapse shortcut (`Ctrl+Shift+T`), fullscreen overlay (`Ctrl+Shift+F`), running-spinner | `index.ts` 1281–1442, 2660–2720 |
| **Browser dashboard** | `/autoresearch export` spins up a localhost SSE server serving `template.html` + `autoresearch.jsonl` | `index.ts` 2723–2935 |
| **Auto-resume loop** | Pending-resume timer + `MAX_AUTORESUME_TURNS=20` cap + experiment-this-turn gate + 800ms settled-window debounce | `index.ts` 977–1080 |
| **Compaction-aware** | Pre-compact: replace LLM summary with deterministic markdown built from disk; post-compact: re-kick loop | `compaction.ts`, `index.ts` 1479–1495 |
| **Hooks** | Optional `autoresearch.hooks/{before,after}.sh`, JSON-on-stdin, stdout (8KB cap) → steer message | `hooks.ts` |
| **Per-profile config** | `<agent-dir>/extensions/pi-autoresearch.json` for shortcuts; `autoresearch.config.json` in cwd for `maxIterations` + `workingDir` | `shortcuts.ts`, `index.ts` 437–485 |

---

## 4. Key files in detail

Read order matches the dependency direction: leaves first.

### 4.1 `jsonl.ts` — append-only log as source of truth

The `autoresearch.jsonl` schema:

- **Config entry** (`type: "config"`): `{type, name, metricName, metricUnit, bestDirection}`. Written on every `init_experiment`. Each new config header starts a **new segment** so re-initializing for a different optimization target preserves history but resets the baseline.
- **Run entry**: `{run, commit, metric, metrics, status, description, timestamp, segment, confidence, asi?}`. Written on every `log_experiment`.
- **Hook entry**: `{type:"hook", stage, exit_code, duration_ms, stdout_bytes, timed_out}`. Written on every fired before/after hook. Observability-only, no semantic effect.

`reconstructJsonlState(content)` walks the file linearly, applies config entries (advancing segment), pushes run entries into `state.results`, registers secondary metrics as they first appear (with unit inference: `_µs`/`_ms`/`_s`/`_kb`/`_mb`). Pure function, defensive parsing — silently drops non-records and bad lines.

This is the **rehydration primitive**: any fresh process can replay a session's state from disk in <1ms with zero LLM cost.

### 4.2 `compaction.ts` — deterministic summary

When pi's `session_before_compact` fires, the extension intercepts via the extension event hook and returns a **pre-built markdown summary** instead of letting pi's default LLM-based summarizer touch the conversation. The summary is composed from:

1. Static header reminding the agent that conversation history is gone.
2. **Session block**: goal, metric, direction, run counts by status, baseline vs best with delta%.
3. **Experiment Rules**: full content of `autoresearch.md`.
4. **Ideas Backlog**: full content of `autoresearch.ideas.md`.
5. **Recent Runs**: last 50 entries, one line each (`#run status metric (delta%) | desc | hyp | next | rollback`), ASI fields opportunistically mined from `asi.hypothesis` / `asi.next_action_hint` / `asi.rollback_reason`.
6. Static "Next Step" tail telling the agent to pick the most promising hypothesis and run immediately.

The result is **lossless on what counts** (the agent never *needs* the prior chat — it needs the rules + the ideas + the recent runs) and saves the user a compaction LLM call. This pattern transfers cleanly to any goal extension whose state lives on disk.

### 4.3 `hooks.ts` — optional escape hatch

A 30s-timeout child process runner for `autoresearch.hooks/{before,after}.sh`. Contract:

- **Stdin**: one JSON line. Shape depends on stage. `before.sh` gets `{event, cwd, next_run, last_run, session}`; `after.sh` gets `{event, cwd, run_entry, session}`.
- **Stdout**: capped at 8KB (truncated at line / UTF-8 boundary). Non-empty stdout becomes a `pi.sendUserMessage(steer, {deliverAs: "steer"})` for the next turn.
- **Stderr + non-zero exit**: surfaced as `[after hook exited N] <err>` steer.
- **Timeout / runtime error**: flagged in the jsonl observability entry.

**Three transparency principles** make this stable:
1. The agent is unaware the hook exists — it never reads stdin or addresses stdout intentionally.
2. The hook reads whatever fields the agent *naturally* writes (`description`, `asi.hypothesis`, `asi.next_focus`) — no "hook input" parameter.
3. Hooks survive auto-revert because their path matches the `autoresearch.*` preservation glob.

Skill ships 10 reference scripts: external search (Exa/Tavily), qmd document grep, persistent learnings journal, macOS native notifications, git tagging on new best, anti-thrash detection, idea rotator, hypothesis reflection, context rotation.

### 4.4 `shortcuts.ts` — pluggable bindings

Per-profile config at `<agent-dir>/extensions/pi-autoresearch.json`:

```json
{"shortcuts": {"toggleDashboard": "ctrl+shift+y", "fullscreenDashboard": null}}
```

`null` disables; missing key keeps the default. Defaults are `Ctrl+Shift+T` and `Ctrl+Shift+F`. The extension only calls `pi.registerShortcut` when the resolved value is a non-null string.

### 4.5 `index.ts` — the engine

3038 lines, but only a handful of conceptual blocks.

#### 4.5.1 State

```ts
interface AutoresearchRuntime {
  autoresearchMode: boolean;            // command-controlled mode flag
  dashboardExpanded: boolean;           // widget collapsed/expanded
  experimentsThisSession: number;       // gate for auto-resume after plain chat
  autoResumeTurns: number;              // counter against MAX_AUTORESUME_TURNS=20
  lastRunChecks: {...} | null;          // checks_failed gate for log_experiment
  lastRunDuration: number | null;
  runningExperiment: {startedAt, command} | null;  // drives spinner
  state: ExperimentState;
  pendingResumeTimer: Timeout | null;
  pendingResumeMessage: string | null;
}
```

Per-session via a `runtimeStore` keyed by `ctx.sessionManager.getSessionId()`. Multi-session safe.

#### 4.5.2 Auto-resume loop (the heart)

The mechanism that makes "never stop" work without an infinite-recursion crash:

1. `agent_end` fires → `ensurePendingResume(ctx, shouldAutoResumeAfterTurn)`.
2. Gate `shouldAutoResumeAfterTurn` = `autoresearchMode && experimentsThisSession > 0`. The experiment-this-turn requirement prevents chat-only turns from re-prompting forever.
3. If `autoResumeTurns >= MAX_AUTORESUME_TURNS=20`, notify and bail.
4. Otherwise `schedulePendingResume` sets `pendingResumeMessage = "Run the next iteration now..."` and a 800ms `setTimeout`. The 800ms is the **`SETTLED_WINDOW_MS`** — long enough to outlast pi's internal `setTimeout 0` retry and the `setTimeout 100` compaction-continue jitter.
5. When the timer fires `sendPendingResumeIfReady` checks `ctx.isIdle() && !ctx.hasPendingMessages()`. If yes, increments `autoResumeTurns`, sends the message. If no, schedules itself again.
6. On `agent_start`, `pausePendingResume` cancels any pending timer (without losing the message) so a re-arrived turn doesn't double-fire.

This is essentially **pi-goal's `MAX_AUTOCONTINUE_TURNS=30`** but with: (a) a different gate (experiment-this-turn vs. step-this-turn), (b) a settled-window debounce, (c) `pi.sendUserMessage` instead of pi-goal's structured XML continuation.

#### 4.5.3 Tool — `init_experiment`

One-shot session config. Validates `workingDir` exists, writes the `{type:"config", ...}` header line to `autoresearch.jsonl`, advances segment if re-init, fires `before.sh` hook on **first** activation only. Output guidance tells the agent "now run the baseline with `run_experiment`".

#### 4.5.4 Tool — `run_experiment`

The workhorse:

1. **Working-dir validation** + **maxIterations gate** (block before spawn if segment count reached).
2. **`autoresearch.sh` guard**: if the file exists in workDir, *only* allow commands whose first real token is `autoresearch.sh` (after stripping env-var prefixes and harmless wrappers like `env time nice nohup`). Rejects chaining tricks like `evil.py; autoresearch.sh`. Pragmatic but tight.
3. **Spawn** via `child_process.spawn("bash", ["-c", cmd])` with `detached: true` (own process group) so timeout/abort can `kill -- -PID`.
4. **Streaming**: per-1s `onUpdate` with formatted elapsed + tail; rolling buffer kept at `2 × DEFAULT_MAX_BYTES`, trimmed to newline boundaries to avoid UTF-8 split.
5. **Overflow temp file**: once total > 4KB, mirror the full stream to a `/tmp/pi-experiment-<rand>.log`.
6. **METRIC parsing**: `/^METRIC\s+([\w.µ]+)=(\S+)\s*$/gm` over the output. Rejects `__proto__`/`constructor`/`prototype` keys. Last occurrence wins. `parsedPrimary` = the entry matching `state.metricName`.
7. **Backpressure**: if `autoresearch.checks.sh` exists and the benchmark passed, run it via `pi.exec` with a separate timeout (default 300s). Stores `lastRunChecks` for the log gate.
8. **LLM response**: truncated to last **10 lines / 4KB** (`EXPERIMENT_MAX_LINES`/`EXPERIMENT_MAX_BYTES`) with a `Full output: <temp path>` pointer.

#### 4.5.5 Tool — `log_experiment`

1. **Schema gate — checks-failed**: if `lastRunChecks.pass === false`, refuse `keep` status, force `checks_failed`.
2. **Schema gate — secondary metrics**: every previously-tracked metric must be reported every time; a new metric requires `force: true`. (Prevents silent loss of tracked secondaries between runs.)
3. **Record**: push to `state.results`; register new secondary names with inferred units.
4. **Confidence**: `|best_delta| / MAD(values_in_segment)`, `null` for <3 points or MAD=0. Stored on the entry AND on session state.
5. **Git**: on `keep` → `git add -A && git commit -m "<desc>\n\nResult: <JSON trailer>"`. On any non-keep → `git checkout -- . ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**'` + `git clean -fd -e 'autoresearch.*'`. **Autoresearch files are preserved across reverts** — that's how `autoresearch.md`/`autoresearch.ideas.md` survive even when the agent's edits get rolled back.
6. **Persist**: append run entry to `autoresearch.jsonl`; broadcast SSE update; fire `after.sh` then `before.sh` hooks.
7. **maxIterations**: if segment count reached, set mode off and `ctx.abort()`.

#### 4.5.6 Lifecycle hooks

```
session_start         → reconstructState from autoresearch.jsonl, updateWidget
session_tree          → same (after tree edits)
session_before_switch → clearOverlay
session_shutdown      → clearSessionUi, cancelPendingResume, stopDashboardServer
agent_start           → reset experimentsThisSession, pausePendingResume
session_before_compact → return deterministic compaction summary
session_compact       → ensurePendingResume (compaction-specific message)
agent_end             → ensurePendingResume (post-turn message)
before_agent_start    → inject systemPrompt extras pointing at autoresearch.md + ideas.md + checks.sh
```

The **`before_agent_start` systemPrompt injection** is short — just pointers, not file content. This is cache-safe (the prompt body doesn't change with run state, only with which optional files exist).

#### 4.5.7 UI

- **Collapsed widget** (default): `🔬 12 runs 8 kept │ ★ total_µs: 15,200 #11 (-12.3%) │ conf: 2.1×` plus a right-aligned shortcut hint that adaptively shrinks under narrow widths.
- **Expanded widget** (`Ctrl+Shift+T`): full table — `# │ commit │ ★ metric │ secondaries... │ status │ description`. Columns sized from actual content; secondaries dropped right-to-left until they fit; description gets minimum 25% width.
- **Fullscreen overlay** (`Ctrl+Shift+F`): `ctx.ui.custom` overlay with `anchor:"center", width:"95%", maxHeight:"90%"`. Vim navigation (`j/k`, `u/d`, `g/G`, `q/esc`). A spinner inside the overlay ticks while `runningExperiment !== null`.
- **Browser dashboard** (`/autoresearch export`): writes `template.html` (with placeholders for title + base64-embedded logo) to a tmpdir, starts a localhost HTTP server, serves the html + the live `autoresearch.jsonl`, plus SSE on `/events` so the page auto-refreshes when `log_experiment` calls `broadcastDashboardUpdate`. Browser-side JS (in `template.html`, not surveyed here) consumes the SSE stream.

#### 4.5.8 `/autoresearch` command

Five paths:

| Subcommand | Behavior |
|---|---|
| _(no arg)_ | Show help notification |
| `<text>` | If already in mode → notify "already active"; else set mode=on, fire `before.sh` hook, `sendWhenReady(kickoff)` |
| `off` | Mode=off, cancel pending resume, stop dashboard server, clear widget, **`ctx.abort()` if running** |
| `clear` | Mode=off + reset state + `unlink autoresearch.jsonl` |
| `export` | Start localhost server, open browser |

---

## 5. Capability inventory

### 5.1 User-facing surface

| Surface | Where |
|---|---|
| `/autoresearch <text\|off\|clear\|export>` | command |
| `Ctrl+Shift+T` | toggle dashboard widget expand/collapse |
| `Ctrl+Shift+F` | fullscreen scrollable dashboard overlay |
| `Escape` | interrupt loop (pi default) |
| Above-editor widget | always-on status line / table |
| Browser dashboard | localhost via `/autoresearch export` |
| `/skill:autoresearch-create` | scaffold a new session |
| `/skill:autoresearch-finalize` | split branch into reviewable PRs |
| `/skill:autoresearch-hooks` | author optional hooks |

### 5.2 Agent-facing tools

| Tool | Visibility | Schema highlights |
|---|---|---|
| `init_experiment` | Always | `{name, metric_name, metric_unit?, direction?}`; advances segment on re-init |
| `run_experiment` | Always | `{command, timeout_seconds?, checks_timeout_seconds?}`; enforces `autoresearch.sh` guard if file exists |
| `log_experiment` | Always | `{commit, metric, status, description, metrics?, force?, asi?}`; gated on `checks_failed`, secondary-metric consistency |

There are **no agent-callable "pause" / "clear" / "resume" tools**. The mode flag is owned by the human via `/autoresearch ...`. The closest the agent gets is `ctx.abort()` triggered indirectly on `maxIterations` hit.

### 5.3 Disk artifacts (per session)

| File | Owner | Survives revert? |
|---|---|---|
| `autoresearch.md` | skill writes; agent updates | ✅ |
| `autoresearch.sh` | skill writes; agent may extend | ✅ |
| `autoresearch.jsonl` | extension appends | ✅ |
| `autoresearch.ideas.md` | agent appends | ✅ |
| `autoresearch.checks.sh` | user creates (optional) | ✅ |
| `autoresearch.hooks/before.sh` | user creates (optional) | ✅ |
| `autoresearch.hooks/after.sh` | user creates (optional) | ✅ |
| `autoresearch.config.json` | user creates (optional) | ✅ |

The shared `autoresearch.*` glob in the revert script is the magic — everything autoresearch-related rides through `discard`/`crash` reverts intact.

---

## 6. pi-goal sisyphus vs pi-autoresearch — side-by-side

| Axis | pi-goal `sisyphus` mode | pi-autoresearch |
|---|---|---|
| **Loop shape** | Linear, finite — N numbered steps, ordered, with optional verifyCommand per step | Cyclic, unbounded — try → measure → keep/revert, indefinite |
| **Success criterion** | step-by-step plan completion + final verify | metric-direction monotone improvement (subjective keep/discard) |
| **What "done" means** | All steps marked `step_complete` | User says `/autoresearch off` (or `maxIterations` hit) |
| **Drafting** | `propose_goal_draft` + confirm dialog; schema-gated focus + step-count + step-inflation | Skill `autoresearch-create` interviews + materializes files; no schema gate on plan shape |
| **Persistent state** | Markdown file in `.pi/goals/active_goal_*.md` (one objective per file) | `autoresearch.jsonl` (append-only log) + `autoresearch.md` (living rules) |
| **Continuation loop** | `MAX_AUTOCONTINUE_TURNS=30` cap + structured `<pi_goal_continuation>` XML prefix | `MAX_AUTORESUME_TURNS=20` cap + plain-prose `Run the next iteration now…` message |
| **Continuation gate** | autoContinue flag + status=active | autoresearchMode=true + at least one `log_experiment` this turn |
| **Compaction-aware** | Phase 5+ opt-in `compaction.json` per case; `postCompactReminderPending` flag | Deterministic markdown summary intercepted at `session_before_compact`; auto-resume after `session_compact` |
| **Status overlay** | Factory widget with box-drawing, sisyphus progress bar `[▰▰▱] 3/5` | Factory widget with run-count / kept / metric / confidence / shortcut hint |
| **Dashboard** | None | Localhost browser via SSE + collapsed/expanded/fullscreen TUI |
| **Hooks** | None | `before.sh` / `after.sh` (8KB stdout → steer) |
| **Branch model** | None — works on whatever branch you start on | Skill creates dedicated `autoresearch/<goal>-<date>` branch; finalize-skill splits it into reviewable independent branches |
| **Pause / blocker** | `pause_goal` tool (agent-callable); `pauseReason`/`pauseSuggestedAction` schema fields; `/goal-resume` | None; user types `/autoresearch off`. No agent self-pause; agent may only `ctx.abort()` indirectly via maxIterations |
| **Schema gates** | `propose_goal_draft` focus check, sisyphus step-count, drafting tool whitelist via `pi.on("tool_call")`, post-stop block | `init_experiment` re-init handling, `run_experiment` autoresearch.sh guard, `log_experiment` checks_failed gate + secondary-metric consistency + force flag for new secondaries |
| **Test surface** | 18 case experiments harness, drive.mjs/grade.sh, 92.6% full-pass | `node --test` over jsonl/compaction/shortcuts (+ bash for finalize) |
| **Author** | Mitch Fultz's `pi-codex-goal` + porting work | David Cortés |

The two extensions answer **complementary** questions:

- pi-goal: *"I have a list of things to do; make sure they all get done, no skipping, no inventing extra steps."*
- pi-autoresearch: *"I have a number to push; try ideas indefinitely until I tell you to stop."*

The pause-and-ask discipline of pi-goal is the *opposite* of pi-autoresearch's never-stop discipline; one cannot port both unchanged.

---

## 7. Porting "auto-research" as a `pi-goal` mode — design recommendations

### 7.1 Mode positioning

Add a **third** mode alongside `goal` and `sisyphus`, not as a replacement:

| Mode | Trigger | Loop shape | Done when |
|---|---|---|---|
| `goal` | `/goal-set` | open-ended | agent declares done OR user marks done |
| `sisyphus` | `/goal-sis` | finite numbered steps | all `step_complete` |
| `autoresearch` | `/goal-research` (proposed) | unbounded measure-loop | user says `/goal-clear` OR maxIterations |

This preserves all the existing schema gates (`focus` in drafting tells `propose_goal_draft` which path to validate) and stays consistent with the "one extension, multiple disciplines" framing in the README.

### 7.2 What to borrow as-is

- **`<topic>.jsonl` + `<topic>.md` dual-file pattern**. Already disk-backed in pi-goal (`active_goal_*.md`) — but a jsonl event log per active goal would (a) let the deterministic compaction summary reuse upstream's pattern, (b) enable per-run history without bloating the .md file, (c) make experiment history auditable.
- **Deterministic compaction summary**. pi-goal's `postCompactReminderPending` is a single boolean today; replacing pi's LLM summary with a markdown-rebuild from the goal record + recent step results gives us lossless context survival for `autoresearch` mode for free, and is also worth applying to `sisyphus` mode while we're there.
- **`MAX_AUTORESUME_TURNS`** is already mirrored in our `MAX_AUTOCONTINUE_TURNS`. Keep our value (30) and our `PI_GOAL_MAX_AUTOCONTINUE_TURNS` env override (Phase 5++ work). No change needed.
- **`autoresearch.sh` command guard**. Adopt a "registered benchmark script" pattern: when the goal has a registered `verify_script` (or `benchmark_script`), `run_experiment` may only invoke that script. Stops the agent from `bash -c` ing random commands as "experiments". This composes cleanly with our existing sisyphus `verifyCommand` gate.
- **METRIC line parser** is ~20 lines, copy-paste with attribution. Defensive prototype-pollution check is worth keeping.
- **Confidence score** (MAD-based, advisory-only). Cheap (<5ms), adds genuine value over raw min/max, never auto-discards (so it can't fight the agent). Direct port.
- **`autoresearch.*` revert glob**. Add the `pi-goal-research.*` namespace to whatever future revert/cleanup the mode does, with the same exclusion pattern.
- **Disk-backed mode flag**. pi-autoresearch reconstructs `autoresearchMode = fs.existsSync(jsonl)`. pi-goal already does this via the markdown file existing. Keep our existing pattern; the principle (disk is the source of truth) is identical.

### 7.3 What to leave behind

- **Skill-based scaffolding** as the *only* entry point. pi-goal already routes everything through `propose_goal_draft` + confirm dialog (Phase 5 D-gate). Don't add a parallel skill-only path; instead route `/goal-research` through the same drafting interview, with `focus: "autoresearch"`. The schema-gated drafting is the strongest feature of pi-goal and would be a regression to abandon.
- **`/autoresearch off`/`clear` as agent-blind commands**. Our `pause_goal` + `/goal-clear` model already separates agent-callable and human-only intent (Phase 5 intent-ownership work). Keep that; don't reintroduce a free-for-all command set.
- **The browser dashboard server**. Nice-to-have, ~200 lines of code, requires `template.html` + assets, opens a port. Defer to a v2; the TUI widget + the on-disk jsonl already give 90% of the value. If the user wants it later, copy the SSE pattern directly.
- **`maxIterations` auto-abort**. pi-goal has token budget; do not duplicate the iteration-counter axis. If the user wants a hard turn cap, they already have `PI_GOAL_MAX_AUTOCONTINUE_TURNS`.
- **autoresearch-finalize as a built-in command**. Branch-splitting is real work but orthogonal to the loop. If we ship it, ship it as a separate skill, not coupled to the extension.

### 7.4 New schema gates the port should add

If we add `autoresearch` as a mode, the following gates are unique to this discipline and aren't covered by existing pi-goal gates:

| Gate | Where | Why |
|---|---|---|
| **"benchmark script required at first run"** | `run_experiment` (or rename to `run_research_step`) | refuse to run anything except the registered script; analog to `autoresearch.sh` guard |
| **"primary metric direction declared"** | drafting / `init_research` tool | reject `propose_goal_draft` for focus=`autoresearch` that lacks `metric_name` and `direction` |
| **"keep requires improvement"** | `log_research_step` (or rename) | refuse `keep` status when the metric did not improve over the current best (configurable strict / advisory). Pi-autoresearch leaves this to the agent — we can be stricter as a deliberate divergence. |
| **"secondary metric consistency"** | same | port the upstream gate: every prior secondary metric must appear; new ones require explicit `force: true`. |
| **"max one config segment per goal"** | `init_research` | reject re-init for an active goal; ask the user to `/goal-clear` first. pi-goal goals are scoped tighter than autoresearch sessions, so re-init mid-goal is almost certainly a mistake. |

### 7.5 Pitfalls flagged during the read

1. **Settled-window timing**. Upstream uses `SETTLED_WINDOW_MS = 800` specifically because pi's internal `setTimeout 0` retries and `setTimeout 100` compaction-continue can fire between `agent_end` and the agent's actual idle state. Our `CONTINUATION_IDLE_RETRY_MS = 50` may be too aggressive for the autoresearch use case where each turn ends with an `exec` that just resolved. Set the autoresearch continuation interval to ≥500ms.

2. **`pi.sendUserMessage` vs structured prompt prefix**. Upstream uses raw `pi.sendUserMessage("Run the next iteration now...")`. pi-goal uses `<pi_goal_continuation goal_id="...">` XML prefix. The XML prefix gives us a hard handle for filtering / debugging / undoing — keep ours. Borrow only the "send when settled" timing logic.

3. **The hook stdout-as-steer pattern is powerful but easy to misuse**. Their reference scripts include things like an "anti-thrash detector" that reads `autoresearch.jsonl` and prints a steer when the last 3 discards repeated the same hypothesis. This is essentially **schema-extension via user shell scripts**, with the steer-message channel as the I/O surface. For pi-goal, if we expose hooks at all, scope them tightly to the `autoresearch` mode and document the 8KB cap + 30s timeout up front.

4. **`isAutoresearchShCommand` regex is suggestive, not airtight**. It can be fooled by `bash -c "/path/to/autoresearch.sh; rm -rf /"` because the regex only looks at the *first* command. The author's docstring acknowledges this is best-effort. If we adopt the guard, narrow further or run the command via `pi.exec("bash", [registered_script])` with a literal arg array instead of shell parsing.

5. **Multi-segment baselining is subtle**. Re-init creates a new segment, advancing `currentSegment++`. All "current segment" lookups filter by segment, so old data stays in the dashboard but doesn't contaminate baselines or confidence. If we adopt segments, replicate the filter discipline carefully — a stray query against `state.results` instead of `currentResults(state.results, state.currentSegment)` will silently regress.

6. **The 800ms compaction `settle` and the `pendingResumeMessage` storage are coupled**. The reschedule pattern requires the message to be remembered across timer cancel/reset cycles. A naive "if timer pending, reset" without preserving the message will lose the resume on `agent_start → agent_end → agent_start` rapid bursts.

7. **Hook log entries in jsonl are fire-and-forget**. They don't update `state.results` — they're purely observability. Don't accidentally let the state reconstructor count them as runs.

### 7.6 Suggested minimal MVP slice

If the user wants to ship `autoresearch` mode in one focused pass:

1. New focus value `autoresearch` for `propose_goal_draft`.
2. Drafting prompt for `/goal-research` collects: goal name, command, metric name, unit, direction, files in scope.
3. Two new tools: `run_research_step` (port of `run_experiment` minus the autoresearch.sh guard for now), `log_research_step` (port of `log_experiment` minus secondary-metric flexibility for v1).
4. Deterministic compaction summary borrowed from `compaction.ts`, generalized to read pi-goal's existing markdown record.
5. Reuse existing `MAX_AUTOCONTINUE_TURNS` cap — no new env var.
6. Widget changes: when goal mode is `autoresearch`, render `🔬 #N runs · N kept · ★ metric · conf×` instead of the sisyphus progress bar.
7. No browser dashboard, no hooks, no finalize-branch tool in v1.

This is ~500 LOC additive in `extensions/goal.ts` plus ~150 LOC of new compaction code. Existing 18 experiment cases need no changes; add 3 new cases (`C19-research-baseline`, `C20-research-keep-only-on-improvement`, `C21-research-compaction-rehydrate`) to drive the new path.

---

## 8. Glossary

| Term | Meaning |
|---|---|
| **Segment** | A contiguous block of runs sharing the same `init_experiment` config. Re-init bumps the segment counter. |
| **Baseline** | First run in the current segment. Frozen — never recomputed. |
| **Best** | Optimal metric across `keep` runs in the current segment, by direction. |
| **MAD** | Median Absolute Deviation — robust noise estimator, `median(|v_i - median(v)|)`. |
| **Confidence** | `|best_delta| / MAD`. >2 = green, 1–2 = yellow, <1 = red. Advisory-only. |
| **ASI** | "Actionable Side Information". Free-form key/value diagnostics the agent attaches to each run. Survives reverts via jsonl. |
| **Steer message** | A `pi.sendUserMessage(text, {deliverAs: "steer"})` — appears as a system steer in the next turn, distinct from user input. |
| **Backpressure check** | Optional correctness gate (`autoresearch.checks.sh`) that runs after a passing benchmark. Failures block `keep`. |
| **Settled window** | 800ms grace period after `agent_end` before sending the next-iteration nudge — outlasts pi's internal retry timers. |
| **Pre-compact intercept** | Returning `{compaction: {...}}` from `session_before_compact` to replace pi's LLM summarizer with a deterministic markdown blob. |

---

*Survey written from a fresh read of upstream v1.4.0. Citations of line numbers are accurate against `/tmp/pi-autoresearch/extensions/pi-autoresearch/*.ts` as cloned.*
