# Architecture

AgentDock is a single-repo Electron + Vite application. The Electron main process owns filesystem access and child processes. The React renderer uses the IPC bridge exposed by `preload.cjs`. Electron is configured with `contextIsolation: true`, `nodeIntegration: false`, and renderer sandboxing enabled.

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

## Process model

- **Main process** — owns all filesystem access, child-process spawning, Git operations, and MCP server lifecycle.
- **Renderer** — React UI, communicates with the main process exclusively through the narrow IPC bridge exposed by `preload.cjs`.
- **Isolation** — `contextIsolation: true`, `nodeIntegration: false`, renderer sandboxing enabled.

## File-as-source-of-truth

Run artifacts are written to disk under `userData/runs/<runId>/`. The session store (`sessions.json`) only holds a `runId` reference. Any run can be inspected, diffed, exported, or recovered independently of the session store. See [technical-details.md](technical-details.md) for the artifact schema and lifecycle.