# AgentDock

**One workspace for Codex CLI, Claude Code, and OpenCode.**

AgentDock is a cross-platform Electron desktop app for working with multiple coding-agent CLIs from one interface. It keeps sessions organized by project, carries recent conversation context when you switch providers, chains providers into configurable multi-stage agent pipelines, and provides shared views for Skills, MCP servers, permissions, Git state, usage, and agent activity.

![AgentDock screenshot](assets/screenshot.png)

> AgentDock is currently at an early stage (`0.2.0`). It runs locally and uses the authentication and configuration of the installed CLIs.

## Why AgentDock

Coding-agent CLIs usually keep their own history, configuration, and workflows. AgentDock adds a provider-neutral workspace on top of them:

- **Switch providers without starting over.** Recent user and assistant messages, the active Git branch, and attachments are passed to the next CLI as continuation context.
- **Chain providers into pipelines.** A configurable agent pipeline runs a prompt through multiple stages (formulate → plan → review → implement → verify), each with its own CLI, model, and reasoning level, with autopilot and an automatic fix-round loop.
- **Keep work project-oriented.** Sessions are stored locally, grouped by workspace, searchable, and deletable from the sidebar.
- **Use Skills across CLIs.** AgentDock discovers project and global Skills, detects divergent copies, shares them between supported locations, and can inject selected global Skills into runs.
- **Manage MCP servers in one place.** A single view combines the managed cross-CLI catalog, the built-in AgentDock servers, and everything the installed CLIs report — with per-CLI connection status and one-click sync to all CLIs.
- **Use one permission selector.** Ask, Auto, and Full modes are translated into provider-specific CLI arguments and configuration.
- **Follow what the agent is doing.** JSON/JSONL output is normalized into a chronological activity timeline — reasoning, intermediate messages, commands, tool activity, and file changes in the order they happened — with live streaming output, markdown rendering, and colored diffs.

## Features

### Three CLI backends

AgentDock detects and launches Codex CLI, Claude Code, and OpenCode. Each backend adapter converts a common run request into the arguments expected by that CLI. Authentication remains managed by the CLI itself.

### Portable sessions

Sessions are saved locally, grouped by workspace, searchable, and deletable. When switching providers, AgentDock builds a **continuation packet** with the delta of recent turns, so context carries over without re-sending the full transcript on every run.

### Restart, resume, and retry

Three actions in the toolbar's "More" menu recover from a stopped or failed run without losing the current tab:

- **Restart agent** — relaunch the CLI process in the current tab, preserving all settings; the last prompt is re-sent as a fresh attempt.
- **Resume session** — continue a saved CLI session through the provider's native resume mechanism.
- **Retry last action** — re-send the last prompt as a new run (enabled when the previous run failed).

### Agent pipelines

The **Pipeline** panel next to the composer chains multiple agents into one workflow. A prompt runs through every stage in order, each stage receiving the original request plus the labeled outputs of all previous stages.

- **Free-form stages.** Add, remove, and reorder steps. Each step picks a role (Formulate, Plan, Review, Implement, Verify, or Custom), its own CLI, model, reasoning level, and optional extra instructions. A one-click "classic 5-step template" creates the full formulate → plan → review → implement → verify chain.
- **Role template library.** Override the default instruction for each role in a built-in editor; overrides apply across workspaces.
- **Read-only vs. write stages.** Formulate/plan/review stages run read-only; implement and verify stages run with write intent under the selected permission mode.
- **Fix-round loop.** A Verify stage ends with `VERDICT: PASS` or `VERDICT: FAIL`. On FAIL the pipeline returns to the last Implement stage with the verifier's notes, up to a configurable cap.
- **Autopilot or step-by-step.** With autopilot on, stages advance automatically; with it off, a progress strip waits for **Continue** between stages.
- **Per-workspace persistence.** The pipeline configuration is saved per workspace and survives restarts.

### Skills

AgentDock discovers Skills from supported global and project locations, groups matching copies by name and content hash, and identifies conflicts. Skills can be created, opened, shared between provider locations, or enabled as defaults for every run.

### Unified MCP view

A single **MCP servers** view manages MCP connections for every CLI in one place:

- **Built-in AgentDock servers** — the browser MCP (injected into every run) and the delegate MCP (injected when delegation is enabled), shown with honest lifecycle states.
- **Managed catalog** — cross-provider server entries with per-CLI connection status (green ● connected, amber ◌ in catalog but not reported, blue for CLI-only extras) and one-click **Sync to all CLIs**.
- **Detected in CLI configs** — servers the CLIs report that are not yet in the catalog, with an **Import** action.

The catalog syncs to each CLI's native config files with timestamped backups, per-server health checks, conflict detection, and portable JSON export/import.

### Permissions, Git, and attachments

- **Ask / Auto / Full** permission modes are translated into each CLI's native approval settings.
- The current Git branch and available branches are shown in the composer; branches can be checked out or created from the app.
- Files and folders can be attached; each provider receives them through its supported mechanism, and paths are also included in the prompt context.

### Credential profiles

Run several accounts of the same provider side by side, each in its own isolated configuration directory — keep a personal subscription and a work subscription available at the same time without logout/login cycles. AgentDock auto-detects existing logins on first launch, and a chip in the composer selects the active profile per run.

**Quota rotation.** When a run hits the vendor's usage limit for the active profile, AgentDock can automatically switch to the next enabled profile of the same provider (configurable: Fail / Ask / Auto-rotate).

### Plan lifecycle

A run can be sent with intent **ask** (read-only question), **plan** (explore and propose, never implement), or **agent** (write). A plan run parses structured **Open Questions** and reports readiness (`ready` / `needs_answers` / `unverified`). **Implement** freezes the accepted plan as a content-hashed contract and verifies the hash before spawn, so the agent implements exactly the reviewed plan.

### Council planning

`plan --council` drafts a plan in parallel across N harnesses, persists each draft as a file-backed artifact, and a primary harness merges them into one unified plan with one question set — cheaper and faster than drafting plans one provider at a time.

### Best-of-N race with cross-family review

`agent:race` spawns N candidate runs in parallel, each in its own isolated worktree. Deterministic gates, cross-family review (a run through a different provider family), and a scoring arbitration function pick a winner, whose patch is auto-adopted into the live tree. A Compare tab shows candidate diffs side by side.

### Deterministic gates and protected paths

Post-run verification runs an explicit test command (e.g. `npm test`). `protected_paths` globs flag any touched sensitive file for human-approval — those changes are never auto-applied.

### Repair loops

`--attempts N` runs a repair loop with a hard cap: spawn → run gates → if gates fail and attempts remain, re-spawn with the previous failure output inlined. `--until-clean` removes the fixed cap and stops on clean gates, budget/quota exhaust, cancellation, or a no-progress stall.

### Budget and cost accounting

`--max-usd N` sets an explicit cash cap. Unknown cost is never reported as `$0` — a run can end `cost_unverifiable` or `exhausted_overshoot` instead. A per-run spend ledger and per-profile attribution accumulate cost and block further runs at the cap. The composer exposes a budget field and a live spend indicator.

### Isolated Git worktree envelopes

Write runs can optionally execute in an isolated Git worktree. The proven work product is a clean `git diff`; the winner is auto-adopted into the live tree via `git apply`. This keeps race candidates from clobbering each other, leaves no debris from failed runs, and gives a clean before/after diff. For non-race runs it is opt-in; the default remains in-place execution.

### Delegation Belt (scoped sub-run MCP tools)

A run can opt into a **delegation** capability through the `agentdock-delegate` MCP server. The running agent can spawn scoped sub-work itself — research, plan, compare approaches, or isolate risky writes — with policy enforced server-side: a hard cap of 8 sub-runs per parent, nesting depth capped at 1, and sub-run cost drawn from the parent's remaining budget. Six scoped tools are exposed; none can apply a patch, approve gates, rotate profiles, or change settings.

### Run artifacts as files

Every run is recorded as a directory containing `events.jsonl`, `final/patch.diff`, `final/summary.md`, `final/telemetry.yaml`, and — for council/race runs — drafts, reviews, and an arbitration decision. Files are the source of truth; the session only stores a `runId` reference, so any run can be inspected, diffed, exported, or recovered independently.

### Typed events and run receipts

Each run ends with a typed outcome (`success` | `blocked` | `needs_human` | `cost_unverifiable` | `exhausted_overshoot`). Lifecycle signals (continuity, fallback, profile rotation, unsatisfied web evidence) carry structured payloads instead of free-form text. The renderer surfaces an outcome badge per message and an expandable evidence panel.

### Activity timeline and chat

Provider output is normalized into a single **chronological timeline**: reasoning, intermediate agent messages, commands, tool calls, and file edits appear in the order the CLI produced them. While a run is active, the chat shows a working indicator with elapsed time, the live activity feed, the streaming answer, and a spinner on the running command.

- **Markdown rendering** — headings, lists, bold, inline code, code blocks, and links through a dependency-free renderer.
- **Colored diffs** — highlighted everywhere they appear: the activity feed, final summaries, the approval inbox, race candidates, and run artifacts.
- **Agent questions** — when a finished run ends with questions, an answer panel appears under the message with one input per question.
- **Timestamps** — messages carry real timestamps; the run tree shows each run's duration and age.

### Usage

The usage panel displays normalized session token counts. Codex and Claude plan limits are queried through their native CLI interfaces when available; unavailable or unparseable values are reported as such.

### Embedded browser and Browser MCP

AgentDock includes an embedded Chromium browser, opened as a split panel to the right of the chat. The browser and the running CLI agents share the same view instance, so when a user asks an agent to "look at the open browser," the agent inspects the exact page the user sees.

- **One shared browser** — a single persistent view stores logins and cookies across restarts, isolated from the AgentDock renderer.
- **Automatic MCP injection** — every run receives an `agentdock-browser` MCP server via ephemeral provider-specific configuration. No global CLI config is modified.
- **Built-in browser capability** — every run is told that the browser MCP can inspect the live page, verify completed web pages, and review reference sites.
- **CDP automation** — the MCP exposes tools for state, open, navigate, snapshot (accessibility tree with element refs and `data-testid` metadata), page source, screenshot, click, type, select, key press, scroll, wait, and history navigation.
- **Security model** — the bridge binds only to `127.0.0.1` with a per-session bearer token that never reaches the renderer, transcripts, events, or logs. Cookies, localStorage, sessionStorage, password fields, and request headers are not exposed. Guest contents run sandboxed with `nodeIntegration: false` and `contextIsolation: true`; camera, microphone, geolocation, notifications, clipboard, and downloads are denied by default. The UI shows an agent-action indicator with a cancel button.

The embedded browser is currently single-tab. Mutating agent actions are visible to the user; future releases will add explicit approval prompts for sensitive operations.

## Run locally

Requirements:

- Node.js and npm
- At least one supported CLI installed, authenticated, and available on `PATH`

```bash
npm install
npm run dev
```

Build the renderer and run the test suite:

```bash
npm run build
npm test
```

## Package the app

Package for the current platform:

```bash
npm run dist
```

Platform-specific commands are also available:

```bash
npm run dist:win
npm run dist:mac
npm run dist:linux
```

Configured package targets are NSIS for Windows, DMG for macOS, and AppImage plus DEB for Linux. Generated artifacts are copied to `release/`.

To prepare every release artifact from Windows in one command, use:

```bash
npm run release -- 0.3.0
```

This updates `package.json` and `package-lock.json`, runs the tests and frontend build, then creates the Windows x64 installer, Linux x64 AppImage and DEB, and an unsigned macOS arm64 ZIP. Linux and macOS packaging runs in WSL so Unix permissions and symlinks are preserved. WSL must provide `curl`, `tar`, and `xz`; the script downloads a matching temporary Linux Node.js runtime automatically.

Omit the version to rebuild the version already in `package.json`. Use the dedicated plan command to inspect the artifact list without changing files, or the fast command when tests have already been run:

```bash
npm run release:plan -- 0.3.0
npm run release:fast -- 0.3.0
```

## Architecture & technical details

For the architecture overview, module map, and implementation internals (CLI argument builders, continuation packet mechanics, credential env overlays, worktree lifecycle, MCP injection, delegate policy enforcement, CDP security model, artifact schema, and more), see:

- [docs/architecture.md](docs/architecture.md) — process model, module map, and file-as-source-of-truth design.
- [docs/technical-details.md](docs/technical-details.md) — per-feature implementation notes.

## Current limitations

- Session storage is local JSON and has no cloud synchronization.
- Context transfer across providers uses continuation packets with a byte budget; very long histories are summarized or truncated to one-liners beyond the budget.
- The embedded browser is single-tab; multi-tab support is planned.
- Agent browser actions are visible but do not yet require per-action approval prompts (planned for a follow-up release).
- `evaluateJavaScript` is intentionally not exposed to agents; cookies, localStorage, sessionStorage, password fields, and request headers are never shared with MCP.
- Model discovery, usage parsing, and permission behavior depend on the installed CLI versions.

## License

No license file is currently included in this repository.