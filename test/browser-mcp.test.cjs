const test = require('node:test')
const assert = require('node:assert/strict')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const { createBrowserMcp } = require('../electron/browser-mcp.cjs')

function browserManagerStub() {
  const state = {
    id: 'default',
    url: 'https://example.test/',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    visible: true,
    revision: 1,
  }
  return {
    getState: () => state,
    open: async () => state,
    navigate: async () => state,
    back: () => {},
    forward: () => {},
    reload: () => {},
  }
}

function automationStub() {
  return {
    snapshot: async () => ({ revision: 1, url: 'https://example.test/', elements: [] }),
    pageSource: async () => ({ url: 'https://example.test/', html: '<html></html>', text: '', truncated: false }),
    screenshot: async () => ({ data: '', mimeType: 'image/png' }),
    click: async () => {},
    type: async () => {},
    select: async () => {},
    pressKey: async () => {},
    scroll: async () => {},
    wait: async () => {},
  }
}

test('browser MCP completes a stateful HTTP handshake and exposes tools', async (t) => {
  const server = createBrowserMcp(browserManagerStub(), automationStub(), { token: 'integration-token' })
  const started = await server.start()
  const transport = new StreamableHTTPClientTransport(new URL(started.url), {
    requestInit: { headers: { Authorization: 'Bearer integration-token' } },
  })
  const client = new Client({ name: 'agentdock-test', version: '1.0.0' }, { capabilities: {} })

  t.after(async () => {
    try { await client.close() } catch {}
    await server.stop()
  })

  await client.connect(transport)
  const result = await client.listTools()
  const names = result.tools.map((tool) => tool.name)
  assert.ok(names.includes('browser_get_state'))
  assert.ok(names.includes('browser_snapshot'))
  assert.ok(names.includes('browser_get_page_source'))
  assert.ok(names.includes('browser_open'))

  const stateResult = await client.callTool({ name: 'browser_get_state', arguments: {} })
  assert.equal(stateResult.isError, undefined)
  assert.match(stateResult.content[0].text, /https:\/\/example\.test\//)

  const sourceResult = await client.callTool({ name: 'browser_get_page_source', arguments: {} })
  assert.equal(sourceResult.isError, undefined)
  assert.match(sourceResult.content[0].text, /<html><\/html>/)
})

test('browser MCP rejects requests without its bearer token', async (t) => {
  const server = createBrowserMcp(browserManagerStub(), automationStub(), { token: 'expected-token' })
  const started = await server.start()
  t.after(() => server.stop())

  const response = await fetch(started.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
  })
  assert.equal(response.status, 401)
})
