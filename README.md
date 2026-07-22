# AgentDock

**One workspace for Codex CLI, Claude Code, and OpenCode.**

AgentDock is a cross-platform Electron desktop app for working with multiple coding-agent CLIs from one interface. It keeps sessions organized by project, carries recent conversation context when you switch providers, and provides shared views for Skills, MCP servers, permissions, Git state, usage, and agent activity.

![AgentDock screenshot](assets/screenshot.png)

> AgentDock is currently at an early stage (`0.2.0`). It runs locally and uses the authentication and configuration of the installed CLIs.

## Why AgentDock

Coding-agent CLIs usually keep their own history, configuration, and workflows. AgentDock adds a provider-neutral workspace on top of them:

- **Switch providers without starting over.** Recent user and assistant messages, the active Git branch, and attachments are passed to the next CLI as continuation context.
- **Keep work project-oriented.** Sessions are stored locally and grouped by workspace rather than by provider.
- **Use Skills across CLIs.** AgentDock discovers project and global Skills, detects divergent copies, shares them between supported locations, and can inject selected global Skills into runs.
- **See MCP servers in one place.** Results reported by the installed Codex, Claude, and OpenCode CLIs are merged into a single read-only view, and a unified manager lets you add, edit, sync, and verify servers across all three CLIs from one catalog.
- **Use one permission selector.** Ask, Auto, and Full modes are translated into provider-specific CLI arguments and configuration.
- **Follow what the agent is doing.** JSON/JSONL output is normalized into messages, reasoning where available, commands, tool activity, and file-change summaries.

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

Sessions are saved as versioned JSON in Electron's `userData` directory. A session records its workspace, transcript, selected provider and model, reasoning level, agent, permission mode, attachments, Git information, and token usage.

When sending a prompt, AgentDock includes up to eight recent transcript messages as provider-neutral continuation context. This makes provider switching practical without depending on one CLI's native session format.

### Restart, resume, and retry

Three actions in the toolbar's "More" menu recover from a stopped or failed run without losing the current tab:

- **Restart agent** relaunches the CLI process in the current tab, preserving the working directory, selected provider, model, reasoning level, agent, permission mode, and attachments. The last user prompt is re-sent as a fresh attempt.
- **Resume session** continues a saved CLI session through the provider's native resume mechanism, using the stored CLI session id:
  - **Codex** — `codex exec resume --json --skip-git-repo-check <session-id> <prompt>`
  - **Claude Code** — `claude --print --output-format stream-json --verbose --resume <session-id> <prompt>`
  - **OpenCode** — `opencode run --format json --dir <workspace> --session <session-id> <prompt>`
- **Retry last action** re-sends the last user prompt as a new run. It is enabled only when the previous run exited with a non-zero code.

The CLI session id, last user prompt, last exit code, and run-failed flag are persisted alongside the session, so these actions remain available after restarting the app.

### Skills and MCP servers

AgentDock discovers Skills from supported global and project locations, groups matching copies by name and content hash, and identifies conflicts. Skills can be created, opened, shared between provider locations, or enabled as defaults for every run.

The MCP view runs each installed CLI's native list command and merges the reported servers. AgentDock does not proxy MCP traffic or modify the returned server list.

### Unified MCP manager

The MCP manager is a separate view that treats MCP servers as first-class, cross-provider objects. Instead of editing each CLI's config files by hand, you maintain one catalog and apply it to every provider.

- **One catalog, three CLIs.** Each server entry declares which providers (Codex, Claude Code, OpenCode) it applies to, its scope (global or workspace), transport (stdio, SSE, or HTTP), command/args/env, URL, and headers. The `agentdock-browser` server is reserved and cannot be edited here.
- **Import from existing configs.** Codex `config.toml`, Claude `~/.claude.json` and workspace `.mcp.json`, and OpenCode `opencode.json` are read into the unified format. Servers found in multiple providers are merged by name, preserving each provider tag. Project-scoped files are imported when a workspace is active.
- **Sync back to CLI configs.** "Apply changes" writes the catalog into each provider's native config files, scoped by the server's `providers` and `scope`. Existing CLI-only entries are preserved, and a timestamped backup of every touched file is written to `userData/mcp-backups` before any change. The read-only MCP view and the running agents are unaffected; the next CLI launch picks up the updated config.
- **Health checks.** A per-server check verifies that a stdio command resolves on `PATH` (`where`/`which`) or that an HTTP/SSE endpoint returns a status below 500.
- **Conflict detection.** Servers present in a CLI config but absent from the catalog, or whose command/URL/transport/enabled state diverges, are surfaced as conflicts so you can reconcile them with a sync.
- **Portable export/import.** The whole catalog (or selected servers) can be exported to a JSON file and imported on another machine, merging by server name.

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

### Activity and usage

AgentDock parses provider output into a shared activity model and shows commands, tool calls, reasoning when exposed, and changed-file summaries. Workspace changes are calculated from Git state before and after a run.

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
  browser-url.cjs      URL normalization and bounds validation for the embedded browser
  browser-manager.cjs  WebContentsView lifecycle, state, navigation, and events
  browser-automation.cjs
                        CDP attach, snapshot/refs, click/type/select/press/scroll/wait
  browser-mcp.cjs      Loopback HTTP MCP bridge with bearer token and tool schemas
  browser-mcp-config.cjs
                        Ephemeral provider MCP injection and browser-awareness prompt
  mcp-manager.cjs      Unified MCP catalog: store, import/sync to CLI configs, health, conflicts, export/import
src/
  App.tsx              React interface and session workflow
  components/
    MoreMenu.tsx       "More" dropdown with embedded-browser entry
    BrowserView.tsx    Browser chrome, address bar, bounds placeholder, agent-action bar
    McpManagerView.tsx Unified MCP manager UI: list, filters, editor, sync, health, conflicts, export/import
  agent-events.mjs     Provider output normalization
  activity-format.mjs
                       Human-readable activity descriptions
test/                  Node test suite for adapters, permissions, skills, browser URL/MCP config, event parsing, and MCP manager store/sync/health/conflicts
test/fixtures/browser-site/
                       HTML fixture for integration testing of browser automation
```

The Electron main process owns filesystem access and child processes. The React renderer uses the API exposed by `preload.cjs`; Electron is configured with `contextIsolation: true`, `nodeIntegration: false`, and renderer sandboxing enabled.

## Current limitations

- Session storage is local JSON and has no search or cloud synchronization.
- Context transfer across providers uses recent transcript messages; native CLI session resume is supported within the same provider only.
- The embedded browser is single-tab; multi-tab support is planned.
- Agent browser actions are visible but do not yet require per-action approval prompts (planned for a follow-up release).
- `evaluateJavaScript` is intentionally not exposed to agents; cookies, localStorage, sessionStorage, password fields, and request headers are never shared with MCP.
- Model discovery, usage parsing, and permission behavior depend on the installed CLI versions.

## License

No license file is currently included in this repository.
