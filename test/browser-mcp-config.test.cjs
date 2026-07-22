const test = require('node:test')
const assert = require('node:assert/strict')
const {
  browserMcpLaunchOptions,
  buildClaudeMcpConfig,
  buildOpenCodeMcpConfig,
  mergeOpenCodeConfig,
  withBrowserAwarenessPrompt,
  BROWSER_AWARENESS_PROMPT,
} = require('../electron/browser-mcp-config.cjs')
const { permissionLaunchOptions } = require('../electron/permissions.cjs')

const descriptor = { name: 'agentdock-browser', url: 'http://127.0.0.1:5432/mcp', token: 'secret-token' }

test('codex launch options use -c mcp_servers and token env var', () => {
  const options = browserMcpLaunchOptions('codex', descriptor, 'run-1')
  const config = options.args.find((arg) => arg.startsWith('mcp_servers.agentdock-browser='))
  assert.ok(config)
  assert.match(config, /url="http:\/\/127\.0\.0\.1:5432\/mcp"/)
  assert.match(config, /bearer_token_env_var="AGENTDOCK_BROWSER_MCP_TOKEN"/)
  assert.match(config, /required=true/)
  assert.doesNotMatch(config, /transport=/)
  assert.equal(options.env.AGENTDOCK_BROWSER_MCP_TOKEN, 'secret-token')
  assert.equal(typeof options.cleanup, 'function')
})

test('claude launch options write temp --mcp-config file', () => {
  const options = browserMcpLaunchOptions('claude', descriptor, 'run-2')
  const configIndex = options.args.indexOf('--mcp-config')
  assert.ok(configIndex > -1)
  const configPath = options.args[configIndex + 1]
  const fs = require('node:fs')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.deepEqual(config.mcpServers['agentdock-browser'], { type: 'http', url: descriptor.url, headers: { Authorization: 'Bearer secret-token' } })
  options.cleanup()
  assert.equal(fs.existsSync(configPath), false)
})

test('opencode launch options merge into OPENCODE_CONFIG_CONTENT preserving fields', () => {
  const permission = { '*': 'allow', external_directory: 'ask', doom_loop: 'ask' }
  const baseEnv = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'example/model', permission }) }
  const options = browserMcpLaunchOptions('opencode', descriptor, 'run-3', baseEnv)
  const merged = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT)
  assert.equal(merged.model, 'example/model')
  assert.deepEqual(merged.permission, permission)
  assert.deepEqual(merged.mcp['agentdock-browser'], { type: 'remote', url: descriptor.url, enabled: true, headers: { Authorization: 'Bearer secret-token' } })
})

test('opencode full-access mode stays a valid permission action after browser injection', () => {
  const permissions = permissionLaunchOptions('opencode', 'full', {})
  const options = browserMcpLaunchOptions('opencode', descriptor, 'run-full', permissions.env)
  const merged = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT)
  assert.equal(merged.permission, 'allow')
  assert.notEqual(merged.permission, 'full')
})

test('returns empty options when descriptor is missing', () => {
  const options = browserMcpLaunchOptions('codex', null, 'run-4')
  assert.deepEqual(options.args, [])
  assert.deepEqual(options.env, {})
})

test('buildClaudeMcpConfig produces correct shape', () => {
  const config = buildClaudeMcpConfig(descriptor)
  assert.deepEqual(config, { mcpServers: { 'agentdock-browser': { type: 'http', url: descriptor.url, headers: { Authorization: 'Bearer secret-token' } } } })
})

test('buildOpenCodeMcpConfig produces correct shape', () => {
  const config = buildOpenCodeMcpConfig(descriptor)
  assert.deepEqual(config, { 'agentdock-browser': { type: 'remote', url: descriptor.url, enabled: true, headers: { Authorization: 'Bearer secret-token' } } })
})

test('mergeOpenCodeConfig preserves existing mcp servers', () => {
  const base = JSON.stringify({ mcp: { 'existing-server': { type: 'local', command: 'foo' } } })
  const merged = JSON.parse(mergeOpenCodeConfig(base, descriptor, 'allow'))
  assert.ok(merged.mcp['existing-server'])
  assert.ok(merged.mcp['agentdock-browser'])
})

test('withBrowserAwarenessPrompt adds prompt once', () => {
  const result = withBrowserAwarenessPrompt('Hello')
  assert.ok(result.includes('<agentdock_browser>'))
  assert.ok(result.includes('verify completed web pages'))
  assert.ok(result.includes('example or\nreference web pages'))
  const twice = withBrowserAwarenessPrompt(result)
  assert.equal(twice, result)
})

test('withBrowserAwarenessPrompt handles non-string input', () => {
  assert.equal(withBrowserAwarenessPrompt(null), null)
  assert.equal(withBrowserAwarenessPrompt(undefined), undefined)
})
