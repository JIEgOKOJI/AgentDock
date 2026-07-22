'use strict'

// Provider-specific ephemeral MCP configuration for the agentdock-browser
// server. Does NOT modify global CLI configs. Returns args/env/cleanup that are
// merged with permissionLaunchOptions and adapter args in agent:run.
//
// Token handling:
//  - Codex: bearer token via env var reference (--bearer-token-env-var), token
//    placed in the child env.
//  - Claude Code: temporary JSON --mcp-config file with Authorization header.
//  - OpenCode: merge server into OPENCODE_CONFIG_CONTENT with Authorization header.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const TOKEN_ENV_VAR = 'AGENTDOCK_BROWSER_MCP_TOKEN'

function buildClaudeMcpConfig(descriptor) {
  return {
    mcpServers: {
      [descriptor.name]: {
        type: 'http',
        url: descriptor.url,
        headers: { Authorization: `Bearer ${descriptor.token}` },
      },
    },
  }
}

function buildOpenCodeMcpConfig(descriptor) {
  return {
    [descriptor.name]: {
      type: 'remote',
      url: descriptor.url,
      enabled: true,
      headers: { Authorization: `Bearer ${descriptor.token}` },
    },
  }
}

function mergeOpenCodeConfig(baseValue, descriptor) {
  let config = {}
  if (baseValue) {
    try {
      const parsed = JSON.parse(baseValue)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed
    } catch {}
  }
  const mcp = config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp) ? { ...config.mcp } : {}
  Object.assign(mcp, buildOpenCodeMcpConfig(descriptor))
  return JSON.stringify({ ...config, mcp })
}

function mergeWithPermissionLaunchOptions(browserOptions, permissionOptions) {
  const env = { ...permissionOptions.env, ...browserOptions.env }
  const args = [...permissionOptions.args, ...browserOptions.args]
  return { mode: permissionOptions.mode, args, env, cleanup: browserOptions.cleanup }
}

function browserMcpLaunchOptions(provider, descriptor, runId, basePermissionEnv) {
  if (!descriptor || !descriptor.url || !descriptor.token) {
    return { args: [], env: {}, cleanup: async () => {} }
  }
  const tempDir = path.join(os.tmpdir(), 'agentdock', runId)
  const cleanupFiles = []

  if (provider === 'codex') {
    // A URL selects Codex's Streamable HTTP transport. Marking the managed
    // server required prevents a run from silently continuing without tools.
    const tomlValue = `{ url="${descriptor.url}", bearer_token_env_var="${TOKEN_ENV_VAR}", required=true }`
    return {
      args: ['-c', `mcp_servers.${descriptor.name}=${tomlValue}`],
      env: { [TOKEN_ENV_VAR]: descriptor.token },
      cleanup: async () => {
        for (const file of cleanupFiles) { try { fs.rmSync(file, { force: true, recursive: true }) } catch {} }
      },
    }
  }

  if (provider === 'claude') {
    fs.mkdirSync(tempDir, { recursive: true })
    const configPath = path.join(tempDir, 'browser-mcp.json')
    fs.writeFileSync(configPath, JSON.stringify(buildClaudeMcpConfig(descriptor)), 'utf8')
    cleanupFiles.push(tempDir)
    return {
      args: ['--mcp-config', configPath],
      env: {},
      cleanup: async () => {
        for (const file of cleanupFiles) { try { fs.rmSync(file, { force: true, recursive: true }) } catch {} }
      },
    }
  }

  if (provider === 'opencode') {
    // permissionLaunchOptions has already translated AgentDock's ask/auto/full
    // modes to OpenCode's schema. Preserve that normalized value while adding
    // the remote MCP server.
    const baseValue = basePermissionEnv && basePermissionEnv.OPENCODE_CONFIG_CONTENT
    const merged = mergeOpenCodeConfig(baseValue, descriptor)
    return {
      args: [],
      env: { OPENCODE_CONFIG_CONTENT: merged },
      cleanup: async () => {},
    }
  }

  return { args: [], env: {}, cleanup: async () => {} }
}

const BROWSER_AWARENESS_PROMPT = `<agentdock_browser>
You have a built-in browser capability through the agentdock-browser MCP server.
It controls AgentDock's shared embedded browser.
If the user refers to the open/current/embedded browser, inspect it with
browser_get_state and browser_snapshot before answering or acting.
Use browser_get_page_source when the user asks about page HTML, DOM, source
code, rendered text, element attributes, or data-testid values.
Use browser_open to verify completed web pages and to inspect example or
reference web pages when that helps with the task.
The page is visible to the user; require approval for sensitive actions.
</agentdock_browser>`

function withBrowserAwarenessPrompt(prompt) {
  if (typeof prompt !== 'string') return prompt
  if (prompt.includes('<agentdock_browser>')) return prompt
  return `${prompt}\n\n${BROWSER_AWARENESS_PROMPT}`
}

module.exports = {
  browserMcpLaunchOptions,
  mergeWithPermissionLaunchOptions,
  mergeOpenCodeConfig,
  buildClaudeMcpConfig,
  buildOpenCodeMcpConfig,
  withBrowserAwarenessPrompt,
  BROWSER_AWARENESS_PROMPT,
  TOKEN_ENV_VAR,
}
