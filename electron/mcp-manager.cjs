'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const MCP_STORE_VERSION = 1
const SUPPORTED_PROVIDERS = ['codex', 'claude', 'opencode']
const RESERVED_NAMES = new Set(['agentdock-browser'])

function nowMs() { return Date.now() }

function normalizeTransport(value) {
  if (value === 'stdio' || value === 'sse' || value === 'http') return value
  return 'stdio'
}

function normalizeProviders(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item) => SUPPORTED_PROVIDERS.includes(item)))]
}

function normalizeServer(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim()) return null
  const name = value.name.trim()
  if (RESERVED_NAMES.has(name)) return null
  const transport = normalizeTransport(value.transport)
  const command = typeof value.command === 'string' ? value.command.trim() : ''
  const args = Array.isArray(value.args) ? value.args.filter((item) => typeof item === 'string' && item) : []
  const url = typeof value.url === 'string' ? value.url.trim() : ''
  const env = value.env && typeof value.env === 'object' && !Array.isArray(value.env)
    ? Object.fromEntries(Object.entries(value.env).filter(([key, val]) => typeof key === 'string' && typeof val === 'string'))
    : {}
  const headers = value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers)
    ? Object.fromEntries(Object.entries(value.headers).filter(([key, val]) => typeof key === 'string' && typeof val === 'string'))
    : {}
  const cwd = typeof value.cwd === 'string' ? value.cwd.trim() : ''
  const scope = value.scope === 'workspace' ? 'workspace' : 'global'
  const workspace = typeof value.workspace === 'string' && value.workspace.trim() ? path.resolve(value.workspace.trim()) : ''
  return {
    id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
    name,
    description: typeof value.description === 'string' ? value.description.trim() : '',
    transport,
    command,
    args,
    url,
    env,
    headers,
    cwd,
    providers: normalizeProviders(value.providers),
    scope,
    workspace: scope === 'workspace' ? workspace : '',
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : nowMs(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : nowMs(),
  }
}

function getStorePath(userDataDir) {
  return path.join(userDataDir, 'mcp-servers.json')
}

function readStore(userDataDir) {
  const storePath = getStorePath(userDataDir)
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'))
    if (raw?.version !== MCP_STORE_VERSION || !Array.isArray(raw.servers)) return { version: MCP_STORE_VERSION, servers: [] }
    return { version: MCP_STORE_VERSION, servers: raw.servers.map(normalizeServer).filter(Boolean) }
  } catch {
    return { version: MCP_STORE_VERSION, servers: [] }
  }
}

function writeStore(userDataDir, store) {
  const storePath = getStorePath(userDataDir)
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8')
}

function listServers(userDataDir, workspace) {
  const store = readStore(userDataDir)
  const resolvedWorkspace = workspace ? path.resolve(workspace) : ''
  return store.servers.filter((server) => {
    if (!resolvedWorkspace) return true
    if (server.scope === 'global') return true
    return server.workspace === resolvedWorkspace
  })
}

function upsertServer(userDataDir, serverInput) {
  const normalized = normalizeServer(serverInput)
  if (!normalized) throw new Error('Invalid MCP server definition')
  const store = readStore(userDataDir)
  const index = store.servers.findIndex((item) => item.id === normalized.id || (
    item.name === normalized.name && item.scope === normalized.scope && item.workspace === normalized.workspace
  ))
  normalized.updatedAt = nowMs()
  if (index >= 0) {
    normalized.createdAt = store.servers[index].createdAt
    normalized.id = store.servers[index].id
    store.servers[index] = normalized
  } else {
    store.servers.push(normalized)
  }
  writeStore(userDataDir, store)
  return normalized
}

function removeServer(userDataDir, id) {
  const store = readStore(userDataDir)
  const next = store.servers.filter((item) => item.id !== id)
  if (next.length === store.servers.length) return false
  writeStore(userDataDir, { ...store, servers: next })
  return true
}

function setServerEnabled(userDataDir, id, enabled) {
  const store = readStore(userDataDir)
  const server = store.servers.find((item) => item.id === id)
  if (!server) return null
  server.enabled = Boolean(enabled)
  server.updatedAt = nowMs()
  writeStore(userDataDir, store)
  return server
}

// ---------------------------------------------------------------------------
// Minimal TOML reader/writer for the subset used by Codex config.toml
// Supports: top-level key = value, [section], [section.subsection], inline
// tables { key = "value", key2 = "value2" }, arrays of strings, bare strings,
// integers, booleans. Preserves unknown sections as raw text.
// ---------------------------------------------------------------------------

function tomlEscapeString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"'
}

function tomlFormatValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return tomlEscapeString(value)
  if (Array.isArray(value)) return `[${value.map(tomlFormatValue).join(', ')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, val]) => `${key} = ${tomlFormatValue(val)}`)
    return `{ ${entries.join(', ')} }`
  }
  return '""'
}

function tomlFormatKey(value) {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlEscapeString(value)
}

function tomlSerializeCodexServers(servers) {
  const lines = []
  for (const server of servers) {
    lines.push(`[mcp_servers.${tomlFormatKey(server.name)}]`)
    if (server.transport === 'stdio') {
      if (server.command) lines.push(`command = ${tomlFormatValue(server.command)}`)
      if (server.args.length) lines.push(`args = ${tomlFormatValue(server.args)}`)
      if (Object.keys(server.env).length) lines.push(`env = ${tomlFormatValue(server.env)}`)
      if (server.cwd) lines.push(`cwd = ${tomlFormatValue(server.cwd)}`)
    } else {
      lines.push(`url = ${tomlFormatValue(server.url)}`)
      lines.push(`transport = ${tomlFormatValue(server.transport === 'http' ? 'http' : 'sse')}`)
      if (Object.keys(server.headers || {}).length) lines.push(`http_headers = ${tomlFormatValue(server.headers)}`)
    }
    lines.push(`enabled = ${tomlFormatValue(server.enabled)}`)
    lines.push('')
  }
  return lines.join('\n')
}

function parseTomlStringLiteral(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) } catch {}
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'")
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  const num = Number(trimmed)
  if (!Number.isNaN(num) && trimmed !== '') return num
  return trimmed
}

function parseTomlInlineTable(value) {
  const inner = value.trim().replace(/^\{/, '').replace(/\}$/, '').trim()
  if (!inner) return {}
  const result = {}
  let cursor = 0
  while (cursor < inner.length) {
    const keyMatch = inner.slice(cursor).match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*/)
    if (!keyMatch) break
    const key = keyMatch[1]
    cursor += keyMatch[0].length
    if (inner[cursor] === '{') {
      let depth = 0
      let end = cursor
      for (; end < inner.length; end++) {
        if (inner[end] === '{') depth++
        else if (inner[end] === '}') { depth--; if (depth === 0) { end++; break } }
      }
      result[key] = parseTomlInlineTable(inner.slice(cursor, end))
      cursor = end
    } else if (inner[cursor] === '[') {
      let end = cursor + 1
      let inString = false
      for (; end < inner.length; end++) {
        if (inner[end] === '"' && inner[end - 1] !== '\\') inString = !inString
        else if (inner[end] === ']' && !inString) { end++; break }
      }
      const arrContent = inner.slice(cursor, end)
      try { result[key] = JSON.parse(arrContent.replace(/'/g, '"')) } catch { result[key] = arrContent }
      cursor = end
    } else {
      let end = cursor
      let inString = inner[cursor] === '"'
      for (end = inString ? cursor + 1 : cursor; end < inner.length; end++) {
        if (inString) {
          if (inner[end] === '"' && inner[end - 1] !== '\\') { end++; break }
        } else {
          if (inner[end] === ',') break
        }
      }
      result[key] = parseTomlStringLiteral(inner.slice(cursor, end))
      cursor = end
    }
    cursor = inner.slice(cursor).match(/^\s*,\s*/) ? cursor + inner.slice(cursor).match(/^\s*,\s*/)[0].length : cursor
  }
  return result
}

function splitTomlPath(value) {
  const parts = []
  let current = ''
  let quote = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (quote) {
      if (char === quote && value[index - 1] !== '\\') quote = ''
      else current += char
    } else if (char === '"' || char === "'") quote = char
    else if (char === '.') { parts.push(current.trim()); current = '' }
    else current += char
  }
  parts.push(current.trim())
  return parts
}

function parseTomlArray(value) {
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '')
  const items = []
  let current = ''
  let quote = ''
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]
    if (quote) {
      current += char
      if (char === quote && inner[index - 1] !== '\\') quote = ''
    } else if (char === '"' || char === "'") { quote = char; current += char }
    else if (char === ',') {
      if (current.trim()) items.push(parseTomlStringLiteral(current))
      current = ''
    } else current += char
  }
  if (current.trim()) items.push(parseTomlStringLiteral(current))
  return items
}

function parseCodexConfigToml(content) {
  const sections = []
  const mcpServers = {}
  let currentSection = null
  let currentRaw = []
  let preSectionRaw = []

  const flushSection = () => {
    if (currentSection) {
      sections.push({ header: currentSection, body: currentRaw.join('\n') })
      currentSection = null
      currentRaw = []
    }
  }

  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const headerMatch = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (headerMatch) {
      flushSection()
      currentSection = headerMatch[1]
      currentRaw = []
      continue
    }
    if (currentSection) {
      currentRaw.push(line)
    } else {
      preSectionRaw.push(line)
    }
  }
  flushSection()

  const otherSections = []
  for (const section of sections) {
    const sectionPath = splitTomlPath(section.header)
    if (sectionPath[0] === 'mcp_servers' && sectionPath.length >= 2) {
      const name = sectionPath[1]
      const server = mcpServers[name] || { name, transport: 'stdio' }
      const isEnvSection = sectionPath.length === 3 && sectionPath[2] === 'env'
      const bodyLines = section.body.split(/\r?\n/)
      for (let index = 0; index < bodyLines.length; index++) {
        const line = bodyLines[index]
        const match = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*?)\s*$/)
        if (!match) continue
        const [, key] = match
        let rawValue = match[2]
        if (rawValue.trim().startsWith('[') && !rawValue.includes(']')) {
          while (++index < bodyLines.length) {
            rawValue += `\n${bodyLines[index]}`
            if (bodyLines[index].includes(']')) break
          }
        }
        if (isEnvSection) {
          server.env = { ...(server.env || {}), [key]: String(parseTomlStringLiteral(rawValue)) }
          continue
        }
        if (key === 'command') server.command = parseTomlStringLiteral(rawValue)
        else if (key === 'args') server.args = parseTomlArray(rawValue)
        else if (key === 'env') server.env = parseTomlInlineTable(rawValue)
        else if (key === 'http_headers' || key === 'headers') server.headers = parseTomlInlineTable(rawValue)
        else if (key === 'cwd') server.cwd = parseTomlStringLiteral(rawValue)
        else if (key === 'url') { server.url = parseTomlStringLiteral(rawValue); server.transport = 'sse' }
        else if (key === 'transport') server.transport = parseTomlStringLiteral(rawValue) === 'http' ? 'http' : 'sse'
        else if (key === 'enabled') server.enabled = parseTomlStringLiteral(rawValue)
        else server[`__${key}`] = parseTomlStringLiteral(rawValue)
      }
      mcpServers[name] = server
    } else {
      otherSections.push(section)
    }
  }

  return { mcpServers, otherSections, preSection: preSectionRaw.join('\n') }
}

function writeCodexConfigToml(parsed, servers) {
  const parts = []
  if (parsed.preSection.trim()) parts.push(parsed.preSection.trim())
  for (const section of parsed.otherSections) {
    parts.push(`[${section.header}]`)
    if (section.body.trim()) parts.push(section.body.trim())
    parts.push('')
  }
  const codexServers = servers.map((server) => ({
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    headers: server.headers,
    cwd: server.cwd,
    url: server.url,
    enabled: server.enabled,
  }))
  const serversToml = tomlSerializeCodexServers(codexServers)
  if (serversToml.trim()) parts.push(serversToml)
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

// ---------------------------------------------------------------------------
// Claude Code JSON config reader/writer
// ---------------------------------------------------------------------------

function claudeConfigPath(home, workspace) {
  if (workspace) return path.join(path.resolve(workspace), '.mcp.json')
  return path.join(home, '.claude.json')
}

function readClaudeConfig(home, workspace) {
  const configPath = claudeConfigPath(home, workspace)
  try {
    const content = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (!content || typeof content !== 'object') return { raw: {}, path: configPath }
    return { raw: content, path: configPath }
  } catch {
    return { raw: {}, path: configPath }
  }
}

function writeClaudeConfig(configPath, raw, servers, managedServerNames) {
  const existing = (raw.mcpServers && typeof raw.mcpServers === 'object') ? raw.mcpServers : {}
  const managedNames = new Set(managedServerNames || servers.map((server) => server.name))
  const mcpServers = {}
  for (const [name, entry] of Object.entries(existing)) {
    if (!managedNames.has(name)) mcpServers[name] = entry
  }
  for (const server of servers) {
    if (server.transport === 'stdio') {
      mcpServers[server.name] = {
        command: server.command,
        ...(server.args.length ? { args: server.args } : {}),
        ...(Object.keys(server.env).length ? { env: server.env } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
      }
    } else {
      mcpServers[server.name] = {
        type: server.transport,
        url: server.url,
        ...(Object.keys(server.headers || {}).length ? { headers: server.headers } : {}),
        ...(server.enabled ? {} : { disabled: true }),
      }
    }
  }
  const updated = { ...raw, mcpServers }
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// OpenCode JSON config reader/writer
// ---------------------------------------------------------------------------

function opencodeConfigPath(home, workspace) {
  if (workspace) return path.join(path.resolve(workspace), 'opencode.json')
  return path.join(home, '.config', 'opencode', 'opencode.json')
}

function readOpenCodeConfig(home, workspace) {
  const configPath = opencodeConfigPath(home, workspace)
  try {
    const content = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (!content || typeof content !== 'object') return { raw: {}, path: configPath }
    return { raw: content, path: configPath }
  } catch {
    return { raw: {}, path: configPath }
  }
}

function writeOpenCodeConfig(configPath, raw, servers, managedServerNames) {
  const existing = (raw.mcp && typeof raw.mcp === 'object') ? raw.mcp : {}
  const managedNames = new Set(managedServerNames || servers.map((server) => server.name))
  const mcp = {}
  for (const [name, entry] of Object.entries(existing)) {
    if (!managedNames.has(name)) mcp[name] = entry
  }
  for (const server of servers) {
    if (server.transport === 'stdio') {
      mcp[server.name] = {
        type: 'local',
        command: [server.command, ...server.args].filter(Boolean),
        enabled: server.enabled,
        ...(Object.keys(server.env || {}).length ? { environment: server.env } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
      }
    } else {
      mcp[server.name] = {
        type: 'remote',
        url: server.url,
        enabled: server.enabled,
        ...(Object.keys(server.headers || {}).length ? { headers: server.headers } : {}),
      }
    }
  }
  const updated = { ...raw, mcp }
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// Import: read existing CLI configs into unified format
// ---------------------------------------------------------------------------

function importFromCodex(home, codexHome, workspace) {
  const configPath = path.join(codexHome, 'config.toml')
  const servers = []
  try {
    const content = fs.readFileSync(configPath, 'utf8')
    const parsed = parseCodexConfigToml(content)
    for (const name of Object.keys(parsed.mcpServers)) {
      const raw = parsed.mcpServers[name]
      if (RESERVED_NAMES.has(name)) continue
      servers.push({
        name,
        description: `Imported from Codex config.toml`,
        transport: raw.transport || (raw.url ? 'sse' : 'stdio'),
        command: raw.command || '',
        args: Array.isArray(raw.args) ? raw.args : [],
        env: raw.env && typeof raw.env === 'object' ? raw.env : {},
        headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : {},
        cwd: raw.cwd || '',
        url: raw.url || '',
        providers: ['codex'],
        scope: 'global',
        workspace: '',
        enabled: raw.enabled !== false,
      })
    }
  } catch {}
  return servers
}

function importFromClaude(home, workspace) {
  const { raw } = readClaudeConfig(home, workspace)
  const servers = []
  const entries = raw.mcpServers || {}
  for (const name of Object.keys(entries)) {
    if (RESERVED_NAMES.has(name)) continue
    const entry = entries[name]
    if (!entry || typeof entry !== 'object') continue
    if (entry.type === 'sse' || entry.type === 'http' || entry.url) {
      servers.push({
        name,
        description: `Imported from Claude ${workspace ? 'project' : 'global'} config`,
        transport: entry.type === 'http' ? 'http' : 'sse',
        command: '',
        args: [],
        env: {},
        headers: entry.headers && typeof entry.headers === 'object' ? entry.headers : {},
        cwd: '',
        url: entry.url || '',
        providers: ['claude'],
        scope: workspace ? 'workspace' : 'global',
        workspace: workspace ? path.resolve(workspace) : '',
        enabled: !entry.disabled,
      })
    } else {
      servers.push({
        name,
        description: `Imported from Claude ${workspace ? 'project' : 'global'} config`,
        transport: 'stdio',
        command: entry.command || '',
        args: Array.isArray(entry.args) ? entry.args : [],
        env: entry.env && typeof entry.env === 'object' ? entry.env : {},
        headers: {},
        cwd: entry.cwd || '',
        url: '',
        providers: ['claude'],
        scope: workspace ? 'workspace' : 'global',
        workspace: workspace ? path.resolve(workspace) : '',
        enabled: !entry.disabled,
      })
    }
  }
  return servers
}

function importFromOpenCode(home, workspace) {
  const { raw } = readOpenCodeConfig(home, workspace)
  const servers = []
  const entries = raw.mcp || {}
  for (const name of Object.keys(entries)) {
    if (RESERVED_NAMES.has(name)) continue
    const entry = entries[name]
    if (!entry || typeof entry !== 'object') continue
    if (entry.type === 'remote' || entry.url) {
      servers.push({
        name,
        description: `Imported from OpenCode ${workspace ? 'project' : 'global'} config`,
        transport: 'http',
        command: '',
        args: [],
        env: {},
        headers: entry.headers && typeof entry.headers === 'object' ? entry.headers : {},
        cwd: '',
        url: entry.url || '',
        providers: ['opencode'],
        scope: workspace ? 'workspace' : 'global',
        workspace: workspace ? path.resolve(workspace) : '',
        enabled: entry.enabled !== false,
      })
    } else {
      const cmdParts = Array.isArray(entry.command) ? entry.command : []
      servers.push({
        name,
        description: `Imported from OpenCode ${workspace ? 'project' : 'global'} config`,
        transport: 'stdio',
        command: cmdParts[0] || '',
        args: cmdParts.slice(1),
        env: entry.environment && typeof entry.environment === 'object' ? entry.environment : {},
        headers: {},
        cwd: entry.cwd || '',
        url: '',
        providers: ['opencode'],
        scope: workspace ? 'workspace' : 'global',
        workspace: workspace ? path.resolve(workspace) : '',
        enabled: entry.enabled !== false,
      })
    }
  }
  return servers
}

function importAll(home, codexHome, workspace) {
  const imported = [
    ...importFromCodex(home, codexHome, workspace),
    ...importFromClaude(home),
    ...importFromOpenCode(home),
    ...(workspace ? importFromClaude(home, workspace) : []),
    ...(workspace ? importFromOpenCode(home, workspace) : []),
  ]
  const merged = new Map()
  for (const server of imported) {
    const normalized = normalizeServer(server)
    if (!normalized) continue
    const identity = `${normalized.scope}\0${normalized.workspace}\0${normalized.name}`
    const existing = merged.get(identity)
    if (existing) {
      for (const provider of normalized.providers) {
        if (!existing.providers.includes(provider)) existing.providers.push(provider)
      }
    } else {
      merged.set(identity, normalized)
    }
  }
  return [...merged.values()]
}

function importIntoStore(userDataDir, home, codexHome, workspace) {
  const imported = importAll(home, codexHome, workspace)
  const store = readStore(userDataDir)
  const identity = (server) => `${server.scope}\0${server.workspace}\0${server.name}`
  const byName = new Map(store.servers.map((server) => [identity(server), server]))
  let added = 0
  let merged = 0
  for (const server of imported) {
    const existing = byName.get(identity(server))
    if (existing) {
      for (const provider of server.providers) {
        if (!existing.providers.includes(provider)) existing.providers.push(provider)
      }
      existing.updatedAt = nowMs()
      merged += 1
    } else {
      store.servers.push(server)
      byName.set(identity(server), server)
      added += 1
    }
  }
  writeStore(userDataDir, store)
  return { added, merged, imported }
}

// ---------------------------------------------------------------------------
// Sync: write unified store into CLI configs, with backup and preservation
// ---------------------------------------------------------------------------

function backupFile(filePath, backupDir) {
  if (!fs.existsSync(filePath)) return null
  const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  const backupPath = path.join(backupDir, stamp, path.basename(filePath))
  fs.mkdirSync(path.dirname(backupPath), { recursive: true })
  fs.copyFileSync(filePath, backupPath)
  return backupPath
}

function syncServersToCodex(home, codexHome, servers, backupDir) {
  const configPath = path.join(codexHome, 'config.toml')
  let parsed = { mcpServers: {}, otherSections: [], preSection: '' }
  try {
    const content = fs.readFileSync(configPath, 'utf8')
    parsed = parseCodexConfigToml(content)
  } catch {}
  const targeted = servers.filter((server) => server.providers.includes('codex') && server.scope === 'global')
  const targetedNames = new Set(targeted.map((server) => server.name))
  const preserved = Object.values(parsed.mcpServers)
    .filter((server) => !targetedNames.has(server.name))
    .map((server) => normalizeServer({ ...server, providers: ['codex'], scope: 'global' }))
    .filter(Boolean)
  const applicable = targeted.filter((server) => server.enabled)
  const backup = backupFile(configPath, backupDir)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, writeCodexConfigToml(parsed, [...preserved, ...applicable]), 'utf8')
  return { provider: 'codex', path: configPath, backup, count: applicable.length }
}

function syncServersToClaude(home, servers, backupDir, workspace) {
  const configPath = claudeConfigPath(home, workspace)
  const { raw } = readClaudeConfig(home, workspace)
  const targeted = servers.filter((server) => {
    if (!server.providers.includes('claude')) return false
    if (workspace) return server.scope === 'workspace' && server.workspace === path.resolve(workspace)
    return server.scope === 'global'
  })
  const applicable = targeted.filter((server) => server.enabled)
  const backup = backupFile(configPath, backupDir)
  writeClaudeConfig(configPath, raw, applicable, targeted.map((server) => server.name))
  return { provider: 'claude', path: configPath, backup, count: applicable.length }
}

function syncServersToOpenCode(home, servers, backupDir, workspace) {
  const configPath = opencodeConfigPath(home, workspace)
  const { raw } = readOpenCodeConfig(home, workspace)
  const targeted = servers.filter((server) => {
    if (!server.providers.includes('opencode')) return false
    if (workspace) return server.scope === 'workspace' && server.workspace === path.resolve(workspace)
    return server.scope === 'global'
  })
  const applicable = targeted.filter((server) => server.enabled)
  const backup = backupFile(configPath, backupDir)
  writeOpenCodeConfig(configPath, raw, applicable, targeted.map((server) => server.name))
  return { provider: 'opencode', path: configPath, backup, count: applicable.length }
}

function syncAll(userDataDir, home, codexHome, options = {}) {
  const store = readStore(userDataDir)
  const backupDir = path.join(userDataDir, 'mcp-backups', `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`)
  const results = []
  const workspace = options.workspace ? path.resolve(options.workspace) : ''
  const includes = (provider) => !options.providers || options.providers.includes(provider)

  if (includes('codex')) {
    results.push(syncServersToCodex(home, codexHome, store.servers, backupDir))
  }
  if (includes('claude')) {
    results.push(syncServersToClaude(home, store.servers, backupDir, undefined))
  }
  if (includes('opencode')) {
    results.push(syncServersToOpenCode(home, store.servers, backupDir, undefined))
  }
  if (workspace) {
    if (includes('claude')) {
      results.push(syncServersToClaude(home, store.servers, backupDir, workspace))
    }
    if (includes('opencode')) {
      results.push(syncServersToOpenCode(home, store.servers, backupDir, workspace))
    }
  }
  return { results, backupDir }
}

// ---------------------------------------------------------------------------
// Health check: verify stdio command exists, or HTTP/SSE URL is reachable
// ---------------------------------------------------------------------------

function checkStdio(server) {
  return new Promise((resolve) => {
    if (!server.command) return resolve({ ok: false, detail: 'No command configured' })
    const locator = process.platform === 'win32' ? 'where.exe' : 'which'
    const { execFile } = require('node:child_process')
    execFile(locator, [server.command], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve({ ok: false, detail: `Command not found: ${server.command}` })
      resolve({ ok: true, detail: `Found at ${stdout.trim().split(/\r?\n/)[0]}` })
    })
  })
}

function checkRemote(server) {
  return new Promise((resolve) => {
    if (!server.url) return resolve({ ok: false, detail: 'No URL configured' })
    const url = new URL(server.url)
    const lib = url.protocol === 'https:' ? require('node:https') : require('node:http')
    const req = lib.request(url, { method: 'GET', timeout: 8000, headers: server.headers || {} }, (res) => {
      res.resume()
      resolve({ ok: res.statusCode && res.statusCode < 500, detail: `HTTP ${res.statusCode}`, statusCode: res.statusCode })
    })
    req.on('error', (error) => resolve({ ok: false, detail: error.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, detail: 'Connection timed out' }) })
    req.end()
  })
}

async function checkServerHealth(server) {
  if (server.transport === 'stdio') return checkStdio(server)
  return checkRemote(server)
}

// ---------------------------------------------------------------------------
// Export: produce portable JSON for transfer between machines
// ---------------------------------------------------------------------------

function exportServers(userDataDir, ids) {
  const store = readStore(userDataDir)
  const servers = ids && ids.length
    ? store.servers.filter((server) => ids.includes(server.id))
    : store.servers
  return { version: MCP_STORE_VERSION, exportedAt: nowMs(), servers }
}

function importExport(userDataDir, payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.servers)) {
    throw new Error('Invalid export payload')
  }
  const store = readStore(userDataDir)
  let added = 0
  let merged = 0
  for (const serverInput of payload.servers) {
    const normalized = normalizeServer(serverInput)
    if (!normalized) continue
    const existing = store.servers.find((item) => item.name === normalized.name)
    if (existing) {
      Object.assign(existing, { ...normalized, id: existing.id, createdAt: existing.createdAt, updatedAt: nowMs() })
      merged += 1
    } else {
      store.servers.push(normalized)
      added += 1
    }
  }
  writeStore(userDataDir, store)
  return { added, merged }
}

// ---------------------------------------------------------------------------
// Conflict detection: find name/scope collisions between store and CLI configs
// ---------------------------------------------------------------------------

function detectConflicts(userDataDir, home, codexHome, workspace) {
  const store = readStore(userDataDir)
  const cliServers = importAll(home, codexHome, workspace)
  const conflicts = []
  for (const cli of cliServers) {
    const managed = store.servers.find((server) => (
      server.name === cli.name && server.scope === cli.scope && server.workspace === cli.workspace
    ))
    if (managed) {
      const sameCommand = managed.command === cli.command
      const sameUrl = managed.url === cli.url
      const sameTransport = managed.transport === cli.transport
      const sameEnabled = managed.enabled === cli.enabled
      if (!sameCommand || !sameUrl || !sameTransport || !sameEnabled) {
        conflicts.push({
          name: cli.name,
          managed: { command: managed.command, url: managed.url, transport: managed.transport },
          cli: { command: cli.command, url: cli.url, transport: cli.transport, providers: cli.providers },
        })
      }
    } else {
      conflicts.push({
        name: cli.name,
        managed: null,
        cli: { command: cli.command, url: cli.url, transport: cli.transport, providers: cli.providers },
      })
    }
  }
  return conflicts
}

module.exports = {
  SUPPORTED_PROVIDERS,
  RESERVED_NAMES,
  listServers,
  upsertServer,
  removeServer,
  setServerEnabled,
  importIntoStore,
  importAll,
  syncAll,
  checkServerHealth,
  exportServers,
  importExport,
  detectConflicts,
  normalizeServer,
  parseCodexConfigToml,
  writeCodexConfigToml,
  tomlSerializeCodexServers,
  claudeConfigPath,
  opencodeConfigPath,
  readClaudeConfig,
  readOpenCodeConfig,
  writeClaudeConfig,
  writeOpenCodeConfig,
}
