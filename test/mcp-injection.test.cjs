const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const {
  injectMcpServers,
  mergeInjectionResults,
  buildClaudeMcpConfigEntry,
  buildOpenCodeMcpConfigEntry,
  mergeOpenCodeMcpConfig,
} = require('../electron/mcp-injection.cjs')

const browserDescriptor = { name: 'agentdock-browser', url: 'http://127.0.0.1:5001/mcp', token: 'browser-token', tokenEnvVar: 'AGENTDOCK_BROWSER_MCP_TOKEN' }
const delegateDescriptor = { name: 'agentdock-delegate', url: 'http://127.0.0.1:5002/mcp', token: 'delegate-token', tokenEnvVar: 'AGENTDOCK_DELEGATE_MCP_TOKEN' }

test('codex injection emits one -c mcp_servers entry per server with distinct token env vars', () => {
  const result = injectMcpServers('codex', [browserDescriptor, delegateDescriptor], 'run-1')
  const serverEntries = result.args.filter((arg) => arg.startsWith('mcp_servers.'))
  assert.equal(serverEntries.length, 2)
  assert.ok(result.args.some((arg) => arg.startsWith('mcp_servers.agentdock-browser=')))
  assert.ok(result.args.some((arg) => arg.startsWith('mcp_servers.agentdock-delegate=')))
  assert.equal(result.env.AGENTDOCK_BROWSER_MCP_TOKEN, 'browser-token')
  assert.equal(result.env.AGENTDOCK_DELEGATE_MCP_TOKEN, 'delegate-token')
})

test('claude injection merges all servers into a single temp --mcp-config file', () => {
  const result = injectMcpServers('claude', [browserDescriptor, delegateDescriptor], 'run-2')
  const configIndex = result.args.indexOf('--mcp-config')
  assert.ok(configIndex > -1)
  const configPath = result.args[configIndex + 1]
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.deepEqual(config.mcpServers['agentdock-browser'], { type: 'http', url: browserDescriptor.url, headers: { Authorization: 'Bearer browser-token' } })
  assert.deepEqual(config.mcpServers['agentdock-delegate'], { type: 'http', url: delegateDescriptor.url, headers: { Authorization: 'Bearer delegate-token' } })
  result.cleanup()
  assert.equal(fs.existsSync(configPath), false)
})

test('opencode injection merges all servers into OPENCODE_CONFIG_CONTENT preserving other fields', () => {
  const permission = { '*': 'allow', external_directory: 'ask' }
  const baseEnv = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'example/model', permission }) }
  const result = injectMcpServers('opencode', [browserDescriptor, delegateDescriptor], 'run-3', baseEnv)
  const merged = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT)
  assert.equal(merged.model, 'example/model')
  assert.deepEqual(merged.permission, permission)
  assert.deepEqual(merged.mcp['agentdock-browser'], { type: 'remote', url: browserDescriptor.url, enabled: true, headers: { Authorization: 'Bearer browser-token' } })
  assert.deepEqual(merged.mcp['agentdock-delegate'], { type: 'remote', url: delegateDescriptor.url, enabled: true, headers: { Authorization: 'Bearer delegate-token' } })
})

test('returns empty options when no valid descriptors are provided', () => {
  const result = injectMcpServers('codex', [], 'run-4')
  assert.deepEqual(result.args, [])
  assert.deepEqual(result.env, {})
})

test('mergeInjectionResults concatenates args, shallow-merges env, runs all cleanups', async () => {
  let cleanupRan = 0
  const a = { args: ['--a'], env: { FOO: '1' }, cleanup: async () => { cleanupRan += 1 } }
  const b = { args: ['--b'], env: { BAR: '2' }, cleanup: async () => { cleanupRan += 1 } }
  const merged = mergeInjectionResults(a, b)
  assert.deepEqual(merged.args, ['--a', '--b'])
  assert.equal(merged.env.FOO, '1')
  assert.equal(merged.env.BAR, '2')
  await merged.cleanup()
  assert.equal(cleanupRan, 2)
})

test('buildClaudeMcpConfigEntry and buildOpenCodeMcpConfigEntry produce correct shapes', () => {
  assert.deepEqual(buildClaudeMcpConfigEntry(browserDescriptor), { type: 'http', url: browserDescriptor.url, headers: { Authorization: 'Bearer browser-token' } })
  assert.deepEqual(buildOpenCodeMcpConfigEntry(delegateDescriptor), { type: 'remote', url: delegateDescriptor.url, enabled: true, headers: { Authorization: 'Bearer delegate-token' } })
})

test('mergeOpenCodeMcpConfig preserves existing mcp servers while adding new ones', () => {
  const base = JSON.stringify({ mcp: { 'existing-server': { type: 'local', command: 'foo' } } })
  const merged = JSON.parse(mergeOpenCodeMcpConfig(base, [browserDescriptor, delegateDescriptor]))
  assert.ok(merged.mcp['existing-server'])
  assert.ok(merged.mcp['agentdock-browser'])
  assert.ok(merged.mcp['agentdock-delegate'])
})