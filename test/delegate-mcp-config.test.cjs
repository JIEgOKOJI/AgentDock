const test = require('node:test')
const assert = require('node:assert/strict')
const {
  DELEGATE_AWARENESS_PROMPT,
  withDelegateAwarenessPrompt,
  normalizeDelegateConfig,
  buildPolicy,
  combinedMcpLaunchOptions,
} = require('../electron/delegate-mcp-config.cjs')

const browserDescriptor = { name: 'agentdock-browser', url: 'http://127.0.0.1:5001/mcp', token: 'browser-token', tokenEnvVar: 'AGENTDOCK_BROWSER_MCP_TOKEN' }
const delegateDescriptor = { name: 'agentdock-delegate', url: 'http://127.0.0.1:5002/mcp', token: 'delegate-token', tokenEnvVar: 'AGENTDOCK_DELEGATE_MCP_TOKEN' }

test('normalizeDelegateConfig enables delegation only when explicitly opted in', () => {
  assert.equal(normalizeDelegateConfig(null).enabled, false)
  assert.equal(normalizeDelegateConfig(false).enabled, false)
  assert.equal(normalizeDelegateConfig({}).enabled, true)
  assert.equal(normalizeDelegateConfig({ maxSubRuns: 4 }).maxSubRuns, 4)
  assert.equal(normalizeDelegateConfig({ maxSubRuns: 99 }).maxSubRuns, 16)
  assert.equal(normalizeDelegateConfig({ maxSubRuns: 0 }).maxSubRuns, 1)
  assert.equal(normalizeDelegateConfig({ maxBestOfN: 99 }).maxBestOfN, 5)
  assert.equal(normalizeDelegateConfig({ maxBestOfN: 1 }).maxBestOfN, 2)
})

test('buildPolicy maps parent budget into the delegate policy', () => {
  const policy = buildPolicy({ maxSubRuns: 4, maxDepth: 1, maxBestOfN: 2 }, { maxUsd: 12, sessionSpendUsd: 3 })
  assert.equal(policy.maxSubRuns, 4)
  assert.equal(policy.maxDepth, 1)
  assert.equal(policy.maxBestOfN, 2)
  assert.equal(policy.parentBudgetUsd, 12)
  assert.equal(policy.sessionSpendUsd, 3)
})

test('withDelegateAwarenessPrompt adds the belt prompt exactly once', () => {
  const result = withDelegateAwarenessPrompt('Do the thing')
  assert.ok(result.includes('<agentdock_delegate>'))
  assert.ok(result.includes('delegate_run'))
  assert.equal(withDelegateAwarenessPrompt(result), result)
  assert.equal(withDelegateAwarenessPrompt(null), null)
})

test('combinedMcpLaunchOptions injects both browser and delegate for codex', () => {
  const result = combinedMcpLaunchOptions('codex', browserDescriptor, delegateDescriptor, 'run-1')
  assert.ok(result.args.some((arg) => arg.startsWith('mcp_servers.agentdock-browser=')))
  assert.ok(result.args.some((arg) => arg.startsWith('mcp_servers.agentdock-delegate=')))
  assert.equal(result.env.AGENTDOCK_BROWSER_MCP_TOKEN, 'browser-token')
  assert.equal(result.env.AGENTDOCK_DELEGATE_MCP_TOKEN, 'delegate-token')
})

test('combinedMcpLaunchOptions falls back to browser-only when delegate is missing', () => {
  const result = combinedMcpLaunchOptions('codex', browserDescriptor, null, 'run-2')
  assert.ok(result.args.some((arg) => arg.startsWith('mcp_servers.agentdock-browser=')))
  assert.ok(!result.args.some((arg) => arg.startsWith('mcp_servers.agentdock-delegate=')))
})

test('combinedMcpLaunchOptions returns empty when neither descriptor is present', () => {
  const result = combinedMcpLaunchOptions('codex', null, null, 'run-3')
  assert.deepEqual(result.args, [])
  assert.deepEqual(result.env, {})
})