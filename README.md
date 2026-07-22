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

AgentDock detects and launches:

| Provider | Executable | Model discovery |
|---|---|---|
| Codex CLI | `codex` | `codex app-server --stdio` |
| Claude Code | `claude` | Claude's `/model` command |
| OpenCode | `opencode` | `opencode models` |

Each backend adapter converts a common run request into the arguments expected by that CLI. Authentication remains managed by the CLI itself.

### Portable sessions

Sessions are saved as versioned JSON in Electron's `userData` directory. A session records its workspace, transcript, selected provider and model, reasoning level, agent, permission mode, attachments, Git information, and token usage. The sidebar groups sessions by project, supports live search across session titles and project names, and allows deleting sessions (with confirmation; run artifacts stay on disk).

When switching providers, AgentDock builds a **continuation packet** — the delta of transcript turns since the last lane checkpoint is written to a file (`context/THREAD.md`) and referenced by absolute path in the prompt, so the body is not embedded in-line. A cached LLM summary or mechanical one-liners cover older history beyond the byte budget. A typed `session.continuity` event records each lane switch. This makes provider switching practical without depending on one CLI's native session format and avoids re-sending the full transcript on every run.

### Restart, resume, and retry

Three actions in the toolbar's "More" menu recover from a stopped or failed run without losing the current tab:

- **Restart agent** relaunches the CLI process in the current tab, preserving the working directory, selected provider, model, reasoning level, agent, permission mode, and attachments. The last user prompt is re-sent as a fresh attempt.
- **Resume session** continues a saved CLI session through the provider's native resume mechanism, using the stored CLI session id:
  - **Codex** — `codex exec resume --json --skip-git-repo-check <session-id> <prompt>`
  - **Claude Code** — `claude --print --output-format stream-json --verbose --resume <session-id> <prompt>`
  - **OpenCode** — `opencode run --format json --dir <workspace> --session <session-id> <prompt>`
- **Retry last action** re-sends the last user prompt as a new run. It is enabled only when the previous run exited with a non-zero code.

The CLI session id, last user prompt, last exit code, and run-failed flag are persisted alongside the session, so these actions remain available after restarting the app.

### Agent pipelines

The **Pipeline** panel next to the composer chains multiple agents into one workflow. A prompt sent with the pipeline enabled runs through every stage in order, each stage receiving the original request plus the labeled outputs of all previous stages.

- **Free-form stages.** Steps can be added, removed, and reordered. Each step selects a role (Formulate task, Plan, Review, Implement, Verify, or Custom), its own CLI (Codex / Claude Code / OpenCode), model, and reasoning level, plus optional extra instructions. A one-click "classic 5-step template" creates formulate → plan → review → implement → verify.
- **Role template library.** The default instruction for each role can be overridden in a built-in template editor (Pipeline → Role templates), with per-role reset to default. Overrides are stored in AgentDock settings and apply across workspaces; steps using a customized template are labeled in the editor.
- **Read-only vs. write stages.** Formulate/plan/review stages run with the read-only `ask` intent; implement and verify stages run with full `agent` intent under the selected permission mode.
- **Fix-round loop.** A Verify stage must end with `VERDICT: PASS` or `VERDICT: FAIL`. On FAIL the pipeline automatically returns to the last Implement stage with the verifier's notes attached, up to a configurable **Max fix rounds** cap.
- **Autopilot or step-by-step.** With autopilot on, stages advance automatically; with it off, a progress strip shows the next stage and waits for **Continue**. The strip tracks every stage (done / running / pending), shows fix-round badges, and offers Stop and Retry for failed stages.
- **Per-workspace persistence.** The pipeline configuration is saved per workspace and survives restarts. Validation blocks sending when a step references an uninstalled CLI or a custom step has no instruction.

Each stage appears in the chat as a normal run — compact stage label, live activity timeline, and final summary — and the pipeline ends with a completion message.

### Skills

AgentDock discovers Skills from supported global and project locations, groups matching copies by name and content hash, and identifies conflicts. Skills can be created, opened, shared between provider locations, or enabled as defaults for every run.

### Unified MCP view

A single **MCP servers** view is the one place to manage MCP connections for every CLI. It combines three sections:

- **Built-in AgentDock servers.** `agentdock-browser` (injected into every run) and `agentdock-delegate` (the Delegation Belt, injected when "Allow delegation" is enabled in Orchestration) are listed with honest lifecycle states — *Active*, *Starting*, or *On-demand* — instead of a misleading "unavailable".
- **Managed catalog.** Cross-provider server entries with scope (global or workspace), transport (stdio, SSE, or HTTP), command/args/env, URL, and headers. Provider chips show the **actual connection state** per CLI by comparing the catalog against each CLI's native `mcp list` output: green ● connected, amber ◌ in catalog but not yet reported, blue for CLI-only extras. A **Sync to all CLIs** action enables a server for Codex, Claude Code, and OpenCode and writes their configs in one click.
- **Detected in CLI configs.** Servers the CLIs report that are not in the catalog yet, with an **Import** action to take them over.

The catalog syncs back to each CLI's native config files ("Apply changes"), with timestamped backups under `userData/mcp-backups`, per-server health checks, conflict detection, and portable JSON export/import. The CLI-reported list refreshes automatically when the view opens and after every sync.

### Permissions, Git, and attachments

- **Ask** uses each CLI's restricted or manual approval settings.
- **Auto** uses each CLI's automatic/on-request settings.
- **Full** uses the provider's unrestricted mode and should be selected with care.
- The current Git branch and available branches are shown in the composer; branches can be checked out or created from the app.
- Files and folders can be attached. Codex receives supported images through `--image`, OpenCode receives attachments through `--file`, and attachment paths are also included in the prompt context.

Because the three CLIs expose different permission systems, the modes are equivalent at the UI level but their exact behavior remains provider-specific.

### Credential profiles

AgentDock can run several accounts of the same provider side by side, each in its own isolated configuration directory. This lets you keep a personal subscription and a work subscription available at the same time without logout/login cycles.

**How it works.** Each profile is a named entry that points at a configuration directory on disk. When a run starts, AgentDock sets the provider's config-dir environment variable for that process only, so the CLI reads credentials and settings from the chosen directory instead of its default location:

| Provider | Environment variable | Default directory |
|---|---|---|
| Codex | `CODEX_HOME` | `~/.codex` |
| Claude Code | `CLAUDE_CONFIG_DIR` | `~/.claude` |
| OpenCode | `OPENCODE_CONFIG_DIR` | `~/.config/opencode` |

Profiles are stored in `profiles.json` inside Electron's `userData` directory. The Profiles view groups them by provider and shows the config directory each one is scoped to.

**Auto-detection.** On first launch AgentDock scans the default directories for each provider. If it finds existing auth markers (`auth.json` for Codex, `.credentials.json` for Claude, `opencode.json` for OpenCode), it creates an auto-detected "Default account" profile automatically, so existing logins appear without any setup. Auto-detected profiles cannot be deleted, but they can be disabled.

**Authenticating a new profile.** AgentDock never handles credentials directly — login is performed by the vendor CLI, scoped to the profile directory:

1. Open the **Profiles** view and click **New profile**.
2. Enter a name (e.g. "Work account"), pick the provider, and set the configuration directory (e.g. `~/.codex-work`).
3. Save the profile.
4. From a terminal, log in through the provider's own CLI with the config-dir environment variable pointing at the new directory:
   ```bash
   CODEX_HOME=~/.codex-work codex login        # Codex
   CLAUDE_CONFIG_DIR=~/.claude-work claude     # Claude Code (login on first run)
   OPENCODE_CONFIG_DIR=~/.config/opencode-work opencode auth login  # OpenCode
   ```
5. The profile is now ready. Select it from the profile chip in the composer before sending a prompt.

**Selecting a profile.** A chip in the composer lists enabled profiles for the active provider. Choosing "Default account" runs the CLI with its native configuration (no env overlay). The selected profile is persisted with the session and restored on reopen.

**Quota rotation.** When a run hits the vendor's usage limit for the active profile, AgentDock can automatically switch to the next enabled profile of the same provider. The behavior is controlled by the **Quota limit action** setting under Settings:

- **Fail** — stop the run (default).
- **Ask** — prompt before rotating.
- **Auto-rotate** — silently switch to the next ready profile and emit a `profile_rotated` event so the UI can surface a banner.

Rotation checks the per-profile rate limits through the provider's native CLI interface (`codex` / `claude`) with the profile's env overlay applied, so each account's quota is measured independently.

### Per-lane homes

Each (session × provider × profile) combination gets its own scoped home directory under `userData/lanes/<sessionId>/<provider>-<profile>/home`, passed to the CLI as `HOME` / `CODEX_HOME` / `CLAUDE_CONFIG_DIR`. Native CLI state (plan files, session rollouts, transcripts) no longer spills into `~`, and a per-lane `cliSessionId` makes `codex exec resume` / `claude --resume` reachable on the next lane turn instead of only within a single provider.

### Run artifacts as files

Every run is recorded as a directory `userData/runs/<runId>/` containing `events.jsonl`, `final/patch.diff` (the clean Git diff for the run), `final/summary.md`, `final/telemetry.yaml`, and — for council/race runs — `council/draft-*.md`, `reviews/*.yaml`, and `arbitration/decision.yaml`. Files are the source of truth and the session only stores a `runId` reference, so any run can be inspected, diffed, exported, or recovered independently of `sessions.json`.

### Typed events and run receipts

Each run ends with a typed outcome (`success` | `blocked` | `needs_human` | `cost_unverifiable` | `exhausted_overshoot`), and lifecycle signals (`session.continuity`, `route.fallback.*`, `route.profile.rotated`, `web.unsatisfied`) carry structured payloads instead of free-form text. The renderer surfaces an outcome badge per message and an expandable evidence panel, giving machine- and human-readable state instead of vibe interpretation of CLI output.

### Plan lifecycle

A run can be sent with intent `ask` (read-only question), `plan` (explore and propose, never implement), or `agent` (write). A `plan` run wraps the goal in "plan, do not implement" and parses a structured `## Open Questions` block (single/multi/text). The plan's readiness is `ready`, `needs_answers`, or `unverified`. **Implement** freezes the accepted plan as a content-hashed contract (`context/PLAN.md` outside the worktree) and verifies the hash before spawn, so the agent implements exactly the reviewed plan.

### Council planning

`plan --council` drafts a plan in parallel across N harnesses (round 1), persists each draft as a file-backed artifact (`council/draft-<harness>.md`), and a primary harness runs one merge iteration that references the draft files by absolute path rather than embedding their text. `## Open Questions` is parsed from the merged output, producing one unified plan and one question set.

### Best-of-N race with cross-family review

`agent:race` spawns N candidate runs in parallel, each through its own harness and (optionally) its own isolated Git worktree. Deterministic gates, cross-family review (a run through a different provider family with a "review this patch" prompt), and a scoring arbitration function pick a winner, and the winner's patch is auto-adopted into the live tree via `git apply`. A Compare tab shows candidate diffs side by side.

### Deterministic gates and protected paths

Post-run verification runs an explicit test argv (e.g. `npm test`). `protected_paths` globs (`migrations/**`, `**/*.env`) flag any touched file for human-approval — those changes are never auto-applied. Externally-granted test commands are invalidated when the config, argv, executable, script bytes, project, or profile changes.

### Repair loops

`--attempts N` runs a repair loop with a hard cap: spawn → run gates → if gates fail and attempts remain, re-spawn with the previous gate output inlined ("previous attempt failed because: …, fix it"). `--until-clean` removes the fixed cap and stops on clean gates, budget/quota exhaust, cancellation, or a no-progress stall (the same error three times in a row).

### Budget and cost accounting

`--max-usd N` sets an explicit cash cap; zero means a real zero, not "unknown". Unknown cost is never reported as `$0` — a run can end `cost_unverifiable` or `exhausted_overshoot` instead. A per-run spend ledger and per-profile attribution accumulate cost (Claude Pro = 0 marginal, API = per-token price) and block further runs at the cap. The composer exposes a budget field and a live spend indicator.

### Isolated Git worktree envelopes

Write runs can optionally execute in an isolated Git worktree under `userData/workspaces/<task>/<attempt>/tree`. The proven work product is a `git diff` captured in the worktree; the winner is auto-adopted into the live tree via `git apply --check` → apply. Non-Git projects auto-init a baseline commit. This keeps race candidates from clobbering each other, leaves no debris from failed runs, and gives a clean before/after diff. For non-race runs it is opt-in via an "isolated run" toggle; the default remains in-place execution.

### Delegation Belt (scoped sub-run MCP tools)

A run can opt into a **delegation** capability through the `agentdock-delegate` MCP server. It exposes a controlled subset of AgentDock orchestration to the running agent, so a Claude/Codex/OpenCode agent can spawn scoped sub-work itself — research, plan, compare approaches, or isolate risky writes — with policy enforced server-side.

**Tools.** Six scoped tools, none of which can apply a patch, approve gates, rotate profiles, or change settings:

| Tool | Intent | Scope |
|---|---|---|
| `delegate_ask` | read-only question | `ask` sub-run, no apply |
| `delegate_plan` | plan + open questions | `plan` sub-run, writes a plan file only |
| `delegate_run` | write | `agent` sub-run inside an isolated worktree |
| `delegate_best_of` | best-of-N race | candidates in worktrees; winner is **not** auto-adopted |
| `delegate_run_status` | poll | status of a spawned sub-run |
| `delegate_run_result` | fetch | summary + artifacts of a finished sub-run |

**Policy.** Enforced server-side in `delegate-mcp.cjs`: hard cap of 8 sub-runs per parent run, nesting depth capped at 1 (a sub-run cannot delegate further), `--n` inside `delegate_best_of` capped at 3, and sub-run cost must stay within the parent run's remaining budget. Every sub-run is attributed to the parent session and its spend ledger.

**Unified MCP injection.** Both the browser MCP and the delegate MCP are injected per run through a single source of truth in `mcp-injection.cjs`, which merges multiple server descriptors into the provider-specific mechanism:

- **Codex** — one `-c mcp_servers.<name>=…` arg and one bearer-token env var per server.
- **Claude Code** — a single temporary `--mcp-config` JSON file merging all `mcpServers` entries (Claude honours only one config file).
- **OpenCode** — all servers merged into `OPENCODE_CONFIG_CONTENT.mcp` as `remote` entries, preserving existing fields and permissions.

The delegate server binds to `127.0.0.1` with a per-run bearer token (never reaches the renderer, transcripts, events, or logs), self-terminates with the parent run, and receives an awareness prompt injected into the agent's context describing the available scoped tools and the nesting cap.

### Activity timeline and chat

AgentDock parses provider output into a shared activity model and renders it as a single **chronological timeline**: reasoning, intermediate agent messages, commands, tool calls, and file edits appear in the order the CLI produced them. While a run is active, the chat shows a working indicator with elapsed time, the live activity feed, the agent's streaming answer, and a spinner on the currently running command.

- **Markdown rendering.** Final agent answers render headings, lists, bold, inline code, code blocks, and links through a dependency-free renderer.
- **Colored diffs.** File diffs are highlighted (additions, deletions, hunk headers) everywhere they appear — the activity feed, final summaries, the approval inbox, race candidates, and `.diff`/`.patch` run artifacts.
- **Agent questions.** When a finished run ends with questions, an answer panel appears under the message with one input per question; answers are sent back as a structured follow-up. Plan-contract open questions keep their dedicated form in the Plan panel.
- **Timestamps.** Messages carry real timestamps, and the run tree shows each run's duration and age.

### Usage

The usage panel displays normalized session token counts. Codex and Claude plan limits are queried through their native CLI interfaces when available; unavailable or unparseable values are reported as such.

### Embedded browser and Browser MCP

AgentDock includes an embedded Chromium browser, opened as a split panel to the right of the chat from the toolbar's "more" menu. The browser and the running CLI agents share the same `WebContentsView` instance, so when a user asks an agent to "look at the open browser," the agent inspects the exact page the user sees.

- **One shared browser.** A single `WebContentsView` with a persistent partition (`persist:agentdock-browser`) stores logins and cookies across restarts, isolated from the AgentDock renderer session.
- **Automatic MCP injection.** Every `agent:run` automatically receives an `agentdock-browser` MCP server via ephemeral provider-specific configuration. No global CLI config is modified:
  - **Codex** receives the server through `-c mcp_servers.agentdock-browser=...` with the bearer token passed via an environment variable.
  - **Claude Code** receives a temporary `--mcp-config` JSON file written to the OS temp directory and removed after the run.
  - **OpenCode** receives the server merged into the inline `OPENCODE_CONFIG_CONTENT`, preserving existing fields and permissions.
- **Built-in browser capability.** Every Codex, Claude Code, and OpenCode run is told that `agentdock-browser` can inspect the live page, verify completed web pages, and review example or reference sites.
- **CDP automation.** The `agentdock-browser` MCP exposes tools for `browser_get_state`, `browser_open`, `browser_navigate`, `browser_snapshot` (accessibility tree, revision-aware element refs, and `data-testid` metadata), `browser_get_page_source` (sanitized DOM HTML and visible text), `browser_screenshot`, `browser_click`, `browser_type`, `browser_select`, `browser_press_key`, `browser_scroll`, `browser_wait`, and history navigation. Element refs are invalidated on navigation to prevent stale interactions.
- **Security model.** The MCP bridge binds only to `127.0.0.1` with a cryptographic bearer token generated per app session. The token never reaches the renderer, transcripts, events, or logs. Cookies, localStorage, sessionStorage, password fields, and request headers are not exposed to agents. Guest web contents run with `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`; camera, microphone, geolocation, notifications, clipboard, and downloads are denied by default. The UI shows an agent-action indicator with a cancel button when an agent is controlling the browser.

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

## Architecture

```text
electron/
  main.cjs             Electron main process, IPC, persistence, CLI execution, Git and MCP
  preload.cjs          Narrow IPC bridge exposed to the renderer
  adapters.cjs         Provider-specific CLI argument builders
  permissions.cjs      Permission-mode mapping
  skills.cjs           Skill discovery, grouping, sharing, and prompt injection
  artifacts.cjs        Run artifacts as files (events.jsonl, patch.diff, summary, telemetry)
  plan.cjs             Plan lifecycle: ask/plan/agent intent, open questions, hashed contract
  council.cjs          Parallel multi-harness plan drafting and merge
  race.cjs             Best-of-N race: parallel candidates, review, arbitration, auto-adopt
  gates.cjs            Deterministic test gates and protected-path approval
  repair.cjs           Repair loops (--attempts / --until-clean) with stall detection
  budget.cjs           Per-run cost accounting, cash caps, and spend ledger
  worktree.cjs         Isolated Git worktree envelopes for write runs
  browser-url.cjs      URL normalization and bounds validation for the embedded browser
  browser-manager.cjs  WebContentsView lifecycle, state, navigation, and events
  browser-automation.cjs
                       CDP attach, snapshot/refs, click/type/select/press/scroll/wait
  browser-mcp.cjs      Loopback HTTP MCP bridge with bearer token and tool schemas
  browser-mcp-config.cjs
                        Ephemeral browser-MCP injection and browser-awareness prompt
  mcp-injection.cjs    Single source of truth for per-provider injection of multiple
                        HTTP/Streamable MCP servers (browser + delegate); merges descriptors
                        into one Claude --mcp-config file / Codex -c args / OpenCode env
  delegate-mcp.cjs     Scoped delegation MCP server (agentdock-delegate): six sub-run tools,
                        policy caps, nesting/budget enforcement, self-terminates with the run
  delegate-mcp-config.cjs
                        Per-run scoping for the Delegation Belt: policy from parent request,
                        combined browser + delegate launch options via mcp-injection
  mcp-manager.cjs      Unified MCP catalog: store, import/sync to CLI configs, health, conflicts, export/import
src/
  App.tsx              React interface, session workflow, chat timeline, pipeline engine
  components/
    MoreMenu.tsx       "More" dropdown with embedded-browser entry
    BrowserView.tsx    Browser chrome, address bar, bounds placeholder, agent-action bar
    McpManagerView.tsx Unified MCP view: built-in servers, managed catalog with per-CLI
                       connection status, sync-to-all, detected CLI servers, editor, health
    PipelinePanel.tsx  Agent pipeline: step editor, role templates + library, prompt builder,
                       verdict parsing, progress strip
    Markdown.tsx       Dependency-free markdown renderer and colored diff view
    PlanPanel.tsx      Plan contract: readiness, open-questions form, implement/re-plan
    OrchestrationControls.tsx
                       Gates, repair, budget, delegation, race, and council configuration
    CompareView.tsx    Best-of-N race candidate comparison and adoption
    ApprovalInbox.tsx  Pending needs-human runs with diff preview and approve/reject
    RunTree.tsx        Run hierarchy with outcomes, durations, and stop controls
    ArtifactsPanel.tsx Run artifact browser with manifest verification and export
    ProfilesView.tsx   Credential profile management
  agent-events.mjs     Provider output normalization, chronological timeline, typed events
  activity-format.mjs
                       Human-readable activity descriptions
test/                  Node test suite for adapters, permissions, skills, browser URL/MCP config,
                       event parsing, MCP manager, plan, council, gates, repair, budget, race,
                       worktree, MCP injection, and delegate MCP
test/fixtures/browser-site/
                       HTML fixture for integration testing of browser automation
```

The Electron main process owns filesystem access and child processes. The React renderer uses the API exposed by `preload.cjs`; Electron is configured with `contextIsolation: true`, `nodeIntegration: false`, and renderer sandboxing enabled.

## Current limitations

- Session storage is local JSON and has no cloud synchronization.
- Context transfer across providers uses continuation packets with a byte budget; very long histories are summarized or truncated to one-liners beyond the budget.
- The embedded browser is single-tab; multi-tab support is planned.
- Agent browser actions are visible but do not yet require per-action approval prompts (planned for a follow-up release).
- `evaluateJavaScript` is intentionally not exposed to agents; cookies, localStorage, sessionStorage, password fields, and request headers are never shared with MCP.
- Model discovery, usage parsing, and permission behavior depend on the installed CLI versions.

## License

No license file is currently included in this repository.
