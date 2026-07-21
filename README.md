# AgentDock

**One workspace for Codex CLI, Claude Code, and OpenCode.**

AgentDock is a cross-platform Electron desktop app for working with multiple coding-agent CLIs from one interface. It keeps sessions organized by project, carries recent conversation context when you switch providers, and provides shared views for Skills, MCP servers, permissions, Git state, usage, and agent activity.

![AgentDock screenshot](assets/screenshot.png)

> AgentDock is currently at an early stage (`0.1.0`). It runs locally and uses the authentication and configuration of the installed CLIs.

## Why AgentDock

Coding-agent CLIs usually keep their own history, configuration, and workflows. AgentDock adds a provider-neutral workspace on top of them:

- **Switch providers without starting over.** Recent user and assistant messages, the active Git branch, and attachments are passed to the next CLI as continuation context.
- **Keep work project-oriented.** Sessions are stored locally and grouped by workspace rather than by provider.
- **Use Skills across CLIs.** AgentDock discovers project and global Skills, detects divergent copies, shares them between supported locations, and can inject selected global Skills into runs.
- **See MCP servers in one place.** Results reported by the installed Codex, Claude, and OpenCode CLIs are merged into a single view.
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

### Skills and MCP servers

AgentDock discovers Skills from supported global and project locations, groups matching copies by name and content hash, and identifies conflicts. Skills can be created, opened, shared between provider locations, or enabled as defaults for every run.

The MCP view runs each installed CLI's native list command and merges the reported servers. AgentDock does not proxy MCP traffic or modify the returned server list.

### Permissions, Git, and attachments

- **Ask** uses each CLI's restricted or manual approval settings.
- **Auto** uses each CLI's automatic/on-request settings.
- **Full** uses the provider's unrestricted mode and should be selected with care.
- The current Git branch and available branches are shown in the composer; branches can be checked out or created from the app.
- Files and folders can be attached. Codex receives supported images through `--image`, OpenCode receives attachments through `--file`, and attachment paths are also included in the prompt context.

Because the three CLIs expose different permission systems, the modes are equivalent at the UI level but their exact behavior remains provider-specific.

### Activity and usage

AgentDock parses provider output into a shared activity model and shows commands, tool calls, reasoning when exposed, and changed-file summaries. Workspace changes are calculated from Git state before and after a run.

The usage panel displays normalized session token counts. Codex and Claude plan limits are queried through their native CLI interfaces when available; unavailable or unparseable values are reported as such.

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

## Architecture

```text
electron/
  main.cjs         Electron main process, IPC, persistence, CLI execution, Git and MCP
  preload.cjs      Narrow IPC bridge exposed to the renderer
  adapters.cjs     Provider-specific CLI argument builders
  permissions.cjs  Permission-mode mapping
  skills.cjs       Skill discovery, grouping, sharing, and prompt injection
src/
  App.tsx          React interface and session workflow
  agent-events.mjs Provider output normalization
  activity-format.mjs
                    Human-readable activity descriptions
test/               Node test suite for adapters, permissions, Skills, and event parsing
```

The Electron main process owns filesystem access and child processes. The React renderer uses the API exposed by `preload.cjs`; Electron is configured with `contextIsolation: true`, `nodeIntegration: false`, and renderer sandboxing enabled.

## Current limitations

- Session storage is local JSON and has no search or cloud synchronization.
- Context transfer uses recent transcript messages rather than native cross-provider session resumption.
- MCP support is a consolidated read-only view.
- Model discovery, usage parsing, and permission behavior depend on the installed CLI versions.

## License

No license file is currently included in this repository.
