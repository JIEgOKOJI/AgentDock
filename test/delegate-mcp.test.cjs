const test = require('node:test')
const assert = require('node:assert/strict')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const { createDelegateMcp, SERVER_NAME, DEFAULT_POLICY } = require('../electron/delegate-mcp.cjs')

test('delegate MCP exposes the six scoped tools and enforces the sub-run cap', async (t) => {
  let spawns = 0
  const server = createDelegateMcp({
    policy: { ...DEFAULT_POLICY, maxSubRuns: 2 },
    spawnSubRun: async (kind, params) => { spawns += 1; return { subRunId: `sub-${spawns}`, ok: true, kind, params } },
    statusOf: () => ({ state: 'running' }),
    resultOf: () => ({ summary: 'done', outcome: 'success', exitCode: 0 }),
  })
  const started = await server.start()
  const transport = new StreamableHTTPClientTransport(new URL(started.url), {
    requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
  })
  const client = new Client({ name: 'agentdock-test', version: '1.0.0' }, { capabilities: {} })
  t.after(async () => { try { await client.close() } catch {} ; await server.stop() })

  await client.connect(transport)
  const tools = (await client.listTools()).tools.map((tool) => tool.name)
  for (const expected of ['delegate_ask', 'delegate_plan', 'delegate_run', 'delegate_best_of', 'delegate_run_status', 'delegate_run_result']) {
    assert.ok(tools.includes(expected), `missing ${expected}`)
  }

  const ask = await client.callTool({ name: 'delegate_ask', arguments: { prompt: 'research the bundle' } })
  assert.equal(ask.isError, undefined)
  const plan = await client.callTool({ name: 'delegate_plan', arguments: { prompt: 'plan a refactor' } })
  assert.equal(plan.isError, undefined)

  // Third spawn exceeds the cap of 2.
  const blocked = await client.callTool({ name: 'delegate_run', arguments: { prompt: 'write a helper' } })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content[0].text, /CAP_EXCEEDED/)

  const status = await client.callTool({ name: 'delegate_run_status', arguments: { subRunId: 'sub-1' } })
  assert.equal(status.isError, undefined)

  const result = await client.callTool({ name: 'delegate_run_result', arguments: { subRunId: 'sub-1' } })
  assert.equal(result.isError, undefined)

  assert.equal(spawns, 2)
})

test('delegate best_of caps n at policy.maxBestOfN', async (t) => {
  let captured
  const server = createDelegateMcp({
    policy: { ...DEFAULT_POLICY, maxSubRuns: 8, maxBestOfN: 3 },
    spawnSubRun: async (kind, params) => { captured = params; return { subRunId: 'race-1', ok: true } },
  })
  const started = await server.start()
  const transport = new StreamableHTTPClientTransport(new URL(started.url), {
    requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
  })
  const client = new Client({ name: 'agentdock-test', version: '1.0.0' }, { capabilities: {} })
  t.after(async () => { try { await client.close() } catch {} ; await server.stop() })
  await client.connect(transport)

  await client.callTool({ name: 'delegate_best_of', arguments: { prompt: 'compare approaches', n: 7 } })
  assert.equal(captured.n, 3)
  assert.equal(captured.autoAdopt, false)
})

test('delegate MCP rejects requests without its bearer token', async (t) => {
  const server = createDelegateMcp()
  const started = await server.start()
  t.after(() => server.stop())
  const response = await fetch(started.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
  })
  assert.equal(response.status, 401)
})

test('describePolicy reflects remaining quota and budget headroom', () => {
  const server = createDelegateMcp({ policy: { ...DEFAULT_POLICY, maxSubRuns: 4, parentBudgetUsd: 10, sessionSpendUsd: 3 } })
  const policy = server.describePolicy()
  assert.equal(policy.maxSubRuns, 4)
  assert.equal(policy.remainingSubRuns, 4)
  assert.equal(policy.maxDepth, 1)
  assert.equal(policy.budgetRemaining, 7)
})