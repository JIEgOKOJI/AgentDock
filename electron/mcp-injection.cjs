'use strict'

// Unified per-provider injection of multiple HTTP/Streamable MCP servers.
//
// Why this exists: the browser MCP injector (browser-mcp-config.cjs) handled a
// single server. Delegation (#12) adds a second injected server, and Claude
// Code only honours one --mcp-config file, so the servers must be merged into a
// single config per run. This module is the single source of truth for the
// provider-specific injection mechanics; browser/delegate config modules build
// descriptors and delegate to it.
//
// Descriptor shape:
//   { name, url, token, tokenEnvVar, required }
//
// Token handling:
//  - Codex: one bearer-token env var per server (descriptor.tokenEnvVar).
//  - Claude Code: a single temporary JSON --mcp-config file merging all
//    mcpServers entries.
//  - OpenCode: merge all servers into OPENCODE_CONFIG_CONTENT.mcp, preserving
//    every other field already present (model, permission, ...).

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

function buildClaudeMcpConfigEntry(descriptor) {
  return {
    type: 'http',
    url: descriptor.url,
    headers: { Authorization: `Bearer ${descriptor.token}` },
  }
}

function buildOpenCodeMcpConfigEntry(descriptor) {
  return {
    type: 'remote',
    url: descriptor.url,
    enabled: true,
    headers: { Authorization: `Bearer ${descriptor.token}` },
  }
}

function mergeOpenCodeMcpConfig(baseValue, descriptors) {
  let config = {}
  if (baseValue) {
    try {
      const parsed = JSON.parse(baseValue)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed
    } catch {}
  }
  const mcp = config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp) ? { ...config.mcp } : {}
  for (const descriptor of descriptors) mcp[descriptor.name] = buildOpenCodeMcpConfigEntry(descriptor)
  return JSON.stringify({ ...config, mcp })
}

function injectMcpServers(provider, descriptors, runId, basePermissionEnv = {}) {
  const valid = (descriptors || []).filter((d) => d && d.url && d.token && d.name)
  if (!valid.length) return { args: [], env: {}, cleanup: async () => {} }

  if (provider === 'codex') {
    const args = []
    const env = {}
    for (const descriptor of valid) {
      const required = descriptor.required === false ? 'false' : 'true'
      const tomlValue = `{ url="${descriptor.url}", bearer_token_env_var="${descriptor.tokenEnvVar}", required=${required} }`
      args.push('-c', `mcp_servers.${descriptor.name}=${tomlValue}`)
      env[descriptor.tokenEnvVar] = descriptor.token
    }
    return { args, env, cleanup: async () => {} }
  }

  if (provider === 'claude') {
    const tempDir = path.join(os.tmpdir(), 'agentdock', runId)
    fs.mkdirSync(tempDir, { recursive: true })
    const configPath = path.join(tempDir, 'mcp-servers.json')
    const mcpServers = {}
    for (const descriptor of valid) mcpServers[descriptor.name] = buildClaudeMcpConfigEntry(descriptor)
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers }), 'utf8')
    return {
      args: ['--mcp-config', configPath],
      env: {},
      cleanup: async () => {
        try { fs.rmSync(tempDir, { force: true, recursive: true }) } catch {}
      },
    }
  }

  if (provider === 'opencode') {
    const baseValue = basePermissionEnv && basePermissionEnv.OPENCODE_CONFIG_CONTENT
    const merged = mergeOpenCodeMcpConfig(baseValue, valid)
    return {
      args: [],
      env: { OPENCODE_CONFIG_CONTENT: merged },
      cleanup: async () => {},
    }
  }

  return { args: [], env: {}, cleanup: async () => {} }
}

// Convenience: merge several injection results (args appended, env shallow-merged
// with later winning, cleanup runs all). Used when a caller builds options
// incrementally instead of via a single injectMcpServers call.
function mergeInjectionResults(...results) {
  const args = []
  const env = {}
  const cleanups = []
  for (const result of results) {
    if (!result) continue
    if (Array.isArray(result.args)) args.push(...result.args)
    if (result.env && typeof result.env === 'object') Object.assign(env, result.env)
    if (typeof result.cleanup === 'function') cleanups.push(result.cleanup)
  }
  return {
    args,
    env,
    cleanup: async () => { for (const fn of cleanups) { try { await fn() } catch {} } },
  }
}

module.exports = {
  injectMcpServers,
  mergeInjectionResults,
  buildClaudeMcpConfigEntry,
  buildOpenCodeMcpConfigEntry,
  mergeOpenCodeMcpConfig,
}