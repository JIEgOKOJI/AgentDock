const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  listServers,
  upsertServer,
  removeServer,
  setServerEnabled,
  importIntoStore,
  importAll,
  syncAll,
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
} = require('../electron/mcp-manager.cjs')

function makeTempDir(context) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-mcp-'))
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  return temp
}

test('normalizeServer validates and normalizes server definition', () => {
  const server = normalizeServer({
    name: '  my-server  ',
    transport: 'invalid',
    command: '  node  ',
    args: ['server.js', 123, ''],
    env: { KEY: 'val', BAD: 456 },
    cwd: ' /some/path ',
    providers: ['codex', 'unknown', 'claude'],
    scope: 'workspace',
    workspace: '/repo',
    enabled: false,
  })
  assert.equal(server.name, 'my-server')
  assert.equal(server.transport, 'stdio')
  assert.deepEqual(server.args, ['server.js'])
  assert.deepEqual(server.env, { KEY: 'val' })
  assert.equal(server.cwd, '/some/path')
  assert.deepEqual(server.providers, ['codex', 'claude'])
  assert.equal(server.scope, 'workspace')
  assert.equal(server.workspace, path.resolve('/repo'))
  assert.equal(server.enabled, false)
  assert.ok(server.id)
  assert.ok(Number.isFinite(server.createdAt))
})

test('normalizeServer rejects reserved names and invalid input', () => {
  assert.equal(normalizeServer({ name: 'agentdock-browser' }), null)
  assert.equal(normalizeServer({ name: '   ' }), null)
  assert.equal(normalizeServer(null), null)
})

test('upsertServer creates and updates servers', (context) => {
  const temp = makeTempDir(context)
  const created = upsertServer(temp, { name: 'server-a', command: 'node', args: ['a.js'], providers: ['codex'], transport: 'stdio' })
  assert.ok(created.id)
  const list = listServers(temp)
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'server-a')
  assert.equal(list[0].createdAt, created.createdAt)

  const updated = upsertServer(temp, { id: created.id, name: 'server-a', command: 'python', args: ['a.py'], providers: ['codex', 'claude'], transport: 'stdio' })
  assert.equal(updated.id, created.id)
  assert.equal(updated.createdAt, created.createdAt)
  assert.equal(updated.command, 'python')
  const list2 = listServers(temp)
  assert.equal(list2.length, 1)
  assert.equal(list2[0].command, 'python')
  assert.deepEqual(list2[0].providers, ['codex', 'claude'])
})

test('setServerEnabled toggles enabled state', (context) => {
  const temp = makeTempDir(context)
  const created = upsertServer(temp, { name: 'srv', command: 'node', providers: ['codex'], transport: 'stdio' })
  assert.equal(created.enabled, true)
  const disabled = setServerEnabled(temp, created.id, false)
  assert.equal(disabled.enabled, false)
  const enabled = setServerEnabled(temp, created.id, true)
  assert.equal(enabled.enabled, true)
  assert.equal(setServerEnabled(temp, 'nonexistent'), null)
})

test('removeServer deletes server by id', (context) => {
  const temp = makeTempDir(context)
  const created = upsertServer(temp, { name: 'to-remove', command: 'node', providers: ['codex'], transport: 'stdio' })
  assert.equal(removeServer(temp, created.id), true)
  assert.equal(listServers(temp).length, 0)
  assert.equal(removeServer(temp, 'nonexistent'), false)
})

test('listServers filters by workspace scope', (context) => {
  const temp = makeTempDir(context)
  const repo = path.join(temp, 'myrepo')
  fs.mkdirSync(repo, { recursive: true })
  upsertServer(temp, { name: 'global-srv', command: 'node', providers: ['codex'], transport: 'stdio', scope: 'global' })
  upsertServer(temp, { name: 'ws-srv', command: 'node', providers: ['codex'], transport: 'stdio', scope: 'workspace', workspace: repo })
  const all = listServers(temp)
  assert.equal(all.length, 2)
  const wsOnly = listServers(temp, repo)
  assert.equal(wsOnly.length, 2)
  assert.ok(wsOnly.some((s) => s.name === 'ws-srv'))
  const globalOnly = listServers(temp, '/elsewhere')
  assert.equal(globalOnly.length, 1)
  assert.equal(globalOnly[0].name, 'global-srv')
})

test('parseCodexConfigToml reads stdio and remote servers', () => {
  const content = [
    'some_global = "value"',
    '',
    '[mcp_servers.my-stdio]',
    'command = "node"',
    'args = ["server.js", "--port", "8080"]',
    'env = { NODE_ENV = "production", DEBUG = "true" }',
    'enabled = true',
    '',
    '[mcp_servers.my-remote]',
    'url = "http://localhost:3000/mcp"',
    'transport = "http"',
    'enabled = false',
    '',
    '[other_section]',
    'key = "value"',
  ].join('\n')
  const parsed = parseCodexConfigToml(content)
  assert.ok(parsed.mcpServers['my-stdio'])
  assert.equal(parsed.mcpServers['my-stdio'].command, 'node')
  assert.deepEqual(parsed.mcpServers['my-stdio'].args, ['server.js', '--port', '8080'])
  assert.deepEqual(parsed.mcpServers['my-stdio'].env, { NODE_ENV: 'production', DEBUG: 'true' })
  assert.equal(parsed.mcpServers['my-stdio'].enabled, true)
  assert.ok(parsed.mcpServers['my-remote'])
  assert.equal(parsed.mcpServers['my-remote'].url, 'http://localhost:3000/mcp')
  assert.equal(parsed.mcpServers['my-remote'].transport, 'http')
  assert.equal(parsed.mcpServers['my-remote'].enabled, false)
  assert.equal(parsed.otherSections.length, 1)
  assert.equal(parsed.otherSections[0].header, 'other_section')
})

test('parseCodexConfigToml handles quoted names, multiline args, nested env, and headers', () => {
  const parsed = parseCodexConfigToml([
    '[mcp_servers."server.with.dot"]',
    'command = "node"',
    'args = [',
    '  "server.js",',
    '  "--verbose",',
    ']',
    '',
    '[mcp_servers."server.with.dot".env]',
    'API_KEY = "secret"',
    '',
    '[mcp_servers.remote]',
    'url = "https://example.test/mcp"',
    'transport = "http"',
    'http_headers = { Authorization = "Bearer token" }',
  ].join('\n'))
  assert.deepEqual(parsed.mcpServers['server.with.dot'].args, ['server.js', '--verbose'])
  assert.deepEqual(parsed.mcpServers['server.with.dot'].env, { API_KEY: 'secret' })
  assert.equal(parsed.mcpServers['server.with.dot.env'], undefined)
  assert.deepEqual(parsed.mcpServers.remote.headers, { Authorization: 'Bearer token' })
})

test('writeCodexConfigToml preserves unknown sections', () => {
  const content = [
    'title = "Codex"',
    '',
    '[other_section]',
    'key = "value"',
    '',
    '[mcp_servers.old]',
    'command = "old-cmd"',
  ].join('\n')
  const parsed = parseCodexConfigToml(content)
  const servers = [{ name: 'new-server', transport: 'stdio', command: 'node', args: ['index.js'], env: { FOO: 'bar' }, cwd: '', url: '', enabled: true }]
  const result = writeCodexConfigToml(parsed, servers)
  assert.match(result, /title = "Codex"/)
  assert.match(result, /\[other_section\]/)
  assert.match(result, /key = "value"/)
  assert.match(result, /\[mcp_servers\.new-server\]/)
  assert.match(result, /command = "node"/)
  assert.match(result, /args = \["index\.js"\]/)
  assert.match(result, /env = \{ FOO = "bar" \}/)
  assert.doesNotMatch(result, /old-cmd/)
})

test('writeClaudeConfig writes stdio and remote entries preserving unknown keys', (context) => {
  const temp = makeTempDir(context)
  const configPath = path.join(temp, 'claude.json')
  const raw = { mcpServers: { existing: { command: 'keep', args: ['run'] } }, customField: 'preserve' }
  fs.writeFileSync(configPath, JSON.stringify(raw), 'utf8')
  const servers = [
    { name: 'srv-stdio', transport: 'stdio', command: 'node', args: ['a.js'], env: { K: 'v' }, cwd: '/tmp', url: '', enabled: true },
    { name: 'srv-http', transport: 'http', command: '', args: [], env: {}, cwd: '', url: 'http://x/mcp', enabled: true },
  ]
  writeClaudeConfig(configPath, raw, servers)
  const written = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.equal(written.customField, 'preserve')
  assert.ok(written.mcpServers['existing'])
  assert.equal(written.mcpServers['existing'].command, 'keep')
  assert.equal(written.mcpServers['srv-stdio'].command, 'node')
  assert.deepEqual(written.mcpServers['srv-stdio'].env, { K: 'v' })
  assert.equal(written.mcpServers['srv-http'].type, 'http')
  assert.equal(written.mcpServers['srv-http'].url, 'http://x/mcp')
})

test('writeOpenCodeConfig writes stdio and remote entries preserving unknown keys', (context) => {
  const temp = makeTempDir(context)
  const configPath = path.join(temp, 'opencode.json')
  const raw = { mcp: { existing: { type: 'local', command: ['keep'] } }, model: 'test' }
  fs.writeFileSync(configPath, JSON.stringify(raw), 'utf8')
  const servers = [
    { name: 'srv-local', transport: 'stdio', command: 'node', args: ['a.js'], env: {}, cwd: '/tmp', url: '', enabled: true },
    { name: 'srv-remote', transport: 'http', command: '', args: [], env: {}, cwd: '', url: 'http://x/mcp', enabled: false },
  ]
  writeOpenCodeConfig(configPath, raw, servers)
  const written = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.equal(written.model, 'test')
  assert.ok(written.mcp['existing'])
  assert.deepEqual(written.mcp['srv-local'].command, ['node', 'a.js'])
  assert.equal(written.mcp['srv-local'].enabled, true)
  assert.equal(written.mcp['srv-remote'].type, 'remote')
  assert.equal(written.mcp['srv-remote'].url, 'http://x/mcp')
  assert.equal(written.mcp['srv-remote'].enabled, false)
})

test('importIntoStore imports from Claude and OpenCode configs', (context) => {
  const temp = makeTempDir(context)
  const home = path.join(temp, 'home')
  const codexHome = path.join(home, '.codex')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      'claude-stdio': { command: 'node', args: ['srv.js'], env: { K: 'v' } },
      'claude-http': { type: 'http', url: 'http://x/mcp' },
    },
  }))
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true })
  fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
    mcp: {
      'oc-local': { type: 'local', command: ['python', 'main.py'], enabled: true },
      'oc-remote': { type: 'remote', url: 'http://y/mcp', enabled: true },
    },
  }))
  const result = importIntoStore(temp, home, codexHome, undefined)
  assert.ok(result.added >= 4)
  assert.equal(result.merged, 0)
  const list = listServers(temp)
  const names = list.map((s) => s.name)
  assert.ok(names.includes('claude-stdio'))
  assert.ok(names.includes('claude-http'))
  assert.ok(names.includes('oc-local'))
  assert.ok(names.includes('oc-remote'))
})

test('syncAll writes to all CLI configs and creates backups', (context) => {
  const temp = makeTempDir(context)
  const home = path.join(temp, 'home')
  const codexHome = path.join(home, '.codex')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true })
  const existingClaude = path.join(home, '.claude.json')
  const existingOpencode = path.join(home, '.config', 'opencode', 'opencode.json')
  fs.writeFileSync(existingClaude, JSON.stringify({ mcpServers: { old: { command: 'x' } } }), 'utf8')
  fs.writeFileSync(existingOpencode, JSON.stringify({ mcp: { old: { type: 'local', command: ['x'] } } }), 'utf8')

  upsertServer(temp, { name: 'synced-srv', transport: 'stdio', command: 'node', args: ['srv.js'], providers: ['codex', 'claude', 'opencode'], scope: 'global' })
  upsertServer(temp, { name: 'disabled-srv', transport: 'stdio', command: 'node', args: ['off.js'], providers: ['claude'], scope: 'global', enabled: false })

  const { results, backupDir } = syncAll(temp, home, codexHome, {})
  assert.equal(results.length, 3)
  assert.ok(fs.existsSync(path.join(codexHome, 'config.toml')))
  const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')
  assert.match(toml, /synced-srv/)
  assert.doesNotMatch(toml, /disabled-srv/)

  const claude = JSON.parse(fs.readFileSync(existingClaude, 'utf8'))
  assert.ok(claude.mcpServers['synced-srv'])
  assert.equal(claude.mcpServers['old'].command, 'x')

  const oc = JSON.parse(fs.readFileSync(existingOpencode, 'utf8'))
  assert.ok(oc.mcp['synced-srv'])
  assert.ok(oc.mcp['old'])

  assert.ok(fs.existsSync(backupDir))
  const backups = fs.readdirSync(backupDir, { recursive: true })
  assert.ok(backups.some((b) => b.includes('claude.json')))
  assert.ok(backups.some((b) => b.includes('opencode.json')))
})

test('syncAll updates global and workspace configs and removes disabled managed entries', (context) => {
  const temp = makeTempDir(context)
  const home = path.join(temp, 'home')
  const codexHome = path.join(home, '.codex')
  const workspace = path.join(temp, 'repo')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {
    disabled: { command: 'old' },
    unmanaged: { command: 'keep' },
  } }))
  upsertServer(temp, { name: 'disabled', command: 'node', providers: ['claude'], scope: 'global', enabled: false })
  upsertServer(temp, { name: 'project-server', command: 'node', providers: ['claude', 'opencode'], scope: 'workspace', workspace })

  const { results } = syncAll(temp, home, codexHome, { workspace })
  assert.equal(results.length, 5)
  const globalClaude = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))
  assert.equal(globalClaude.mcpServers.disabled, undefined)
  assert.equal(globalClaude.mcpServers.unmanaged.command, 'keep')
  const projectClaude = JSON.parse(fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8'))
  const projectOpenCode = JSON.parse(fs.readFileSync(path.join(workspace, 'opencode.json'), 'utf8'))
  assert.ok(projectClaude.mcpServers['project-server'])
  assert.ok(projectOpenCode.mcp['project-server'])
})

test('exportServers and importExport round-trip', (context) => {
  const tempA = makeTempDir(context)
  const tempB = makeTempDir(context)
  upsertServer(tempA, { name: 'export-srv', transport: 'stdio', command: 'node', providers: ['codex'], scope: 'global' })
  const payload = exportServers(tempA)
  assert.equal(payload.servers.length, 1)
  const result = importExport(tempB, payload)
  assert.equal(result.added, 1)
  assert.equal(listServers(tempB).length, 1)
  const reExport = exportServers(tempB, [listServers(tempB)[0].id])
  assert.equal(reExport.servers.length, 1)
})

test('detectConflicts finds mismatched and unmanaged servers', (context) => {
  const temp = makeTempDir(context)
  const home = path.join(temp, 'home')
  const codexHome = path.join(home, '.codex')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      'managed-srv': { command: 'node', args: ['srv.js'] },
      'unmanaged-srv': { command: 'unknown' },
    },
  }))
  upsertServer(temp, { name: 'managed-srv', transport: 'stdio', command: 'different', providers: ['claude'], scope: 'global' })
  const conflicts = detectConflicts(temp, home, codexHome, undefined)
  const names = conflicts.map((c) => c.name)
  assert.ok(names.includes('managed-srv'))
  assert.ok(names.includes('unmanaged-srv'))
  const managedConflict = conflicts.find((c) => c.name === 'managed-srv')
  assert.notEqual(managedConflict.managed.command, managedConflict.cli.command)
})

test('claudeConfigPath returns project path when workspace given', () => {
  assert.equal(claudeConfigPath('/home', undefined), path.join('/home', '.claude.json'))
  assert.equal(claudeConfigPath('/home', '/repo'), path.resolve('/repo', '.mcp.json'))
})

test('opencodeConfigPath returns project path when workspace given', () => {
  assert.equal(opencodeConfigPath('/home', undefined), path.join('/home', '.config', 'opencode', 'opencode.json'))
  assert.equal(opencodeConfigPath('/home', '/repo'), path.resolve('/repo', 'opencode.json'))
})

test('tomlSerializeCodexServers serializes stdio and http servers', () => {
  const servers = [
    { name: 's1', transport: 'stdio', command: 'node', args: ['a.js'], env: { K: 'v' }, cwd: '/tmp', url: '', enabled: true },
    { name: 's2', transport: 'http', command: '', args: [], env: {}, cwd: '', url: 'http://x/mcp', enabled: true },
  ]
  const toml = tomlSerializeCodexServers(servers)
  assert.match(toml, /\[mcp_servers\.s1\]/)
  assert.match(toml, /command = "node"/)
  assert.match(toml, /args = \["a\.js"\]/)
  assert.match(toml, /env = \{ K = "v" \}/)
  assert.match(toml, /cwd = "\/tmp"/)
  assert.match(toml, /\[mcp_servers\.s2\]/)
  assert.match(toml, /url = "http:\/\/x\/mcp"/)
  assert.match(toml, /transport = "http"/)
})
