'use strict'

// Browser MCP bridge: exposes the shared embedded browser to CLI agents over a
// loopback Streamable HTTP transport with a cryptographic bearer token. One
// McpServer instance is reused per session; the HTTP server validates the token
// before forwarding requests to the transport.

const http = require('node:http')
const crypto = require('node:crypto')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js')
const { z } = require('zod')
const { normalizeUrl } = require('./browser-url.cjs')
const { AutomationError } = require('./browser-automation.cjs')

const SERVER_NAME = 'agentdock-browser'
const SERVER_VERSION = '0.2.0'

function describeError(error) {
  if (error instanceof AutomationError) return { code: error.code, message: error.message }
  return { code: 'INTERNAL_ERROR', message: error && error.message ? error.message : String(error) }
}

function toolError(error) {
  const { code, message } = describeError(error)
  return {
    isError: true,
    content: [{ type: 'text', text: `[${code}] ${message}` }],
  }
}

function createBrowserMcp(browserManager, automation, options = {}) {
  const token = options.token || crypto.randomBytes(32).toString('hex')
  const sessions = new Map()
  let httpServer = null
  let port = 0
  let started = false

  function buildServer() {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { instructions: 'Controls the AgentDock shared embedded browser. The page is visible to the user. Require approval for sensitive actions.' },
    )

    server.tool(
      'browser_get_state',
      'Returns the URL, title, loading and visibility state of the shared AgentDock browser tab. Safe, read-only.',
      {},
      async () => {
        try {
          const state = browserManager.getState()
          if (!state) return toolError(new AutomationError('NO_BROWSER', 'No embedded browser is open'))
          return { content: [{ type: 'text', text: JSON.stringify(state) }] }
        } catch (error) { return toolError(error) }
      },
    )

    server.tool(
      'browser_open',
      'Opens the shared AgentDock embedded browser and (optionally) navigates to a URL. The browser becomes visible to the user.',
      { url: z.string().optional() },
      async ({ url }) => {
        try {
          const state = await browserManager.open(url || undefined)
          return { content: [{ type: 'text', text: JSON.stringify(state) }] }
        } catch (error) { return toolError(error) }
      },
    )

    server.tool(
      'browser_navigate',
      'Navigates the shared AgentDock browser tab to a URL. http/https and localhost are allowed.',
      { url: z.string() },
      async ({ url }) => {
        try {
          const normalized = normalizeUrl(url)
          if (!normalized.ok) return toolError(new AutomationError('INVALID_URL', 'Invalid URL'))
          const state = await browserManager.navigate(normalized.url)
          return { content: [{ type: 'text', text: JSON.stringify(state) }] }
        } catch (error) { return toolError(error) }
      },
    )

    server.tool(
      'browser_snapshot',
      'Returns a live accessibility/DOM snapshot with interactive element refs and every data-testid found on the page. Use browser_click/browser_type with refs. Refs become stale after navigation.',
      {},
      async () => {
        try {
          const snapshot = await automation.snapshot()
          return { content: [{ type: 'text', text: JSON.stringify(snapshot) }] }
        } catch (error) { return toolError(error) }
      },
    )

    server.tool(
      'browser_get_page_source',
      'Returns the current page DOM HTML and visible text. Use this when the user asks about page source, markup, data-testid attributes, or rendered content. Current input and textarea values are removed.',
      {},
      async () => {
        try {
          const source = await automation.pageSource()
          return { content: [{ type: 'text', text: JSON.stringify(source) }] }
        } catch (error) { return toolError(error) }
      },
    )

    server.tool(
      'browser_screenshot',
      'Captures a PNG screenshot of the current viewport of the shared AgentDock browser.',
      {},
      async () => {
        try {
          const result = await automation.screenshot()
          return { content: [{ type: 'image', data: result.data, mimeType: result.mimeType }] }
        } catch (error) { return toolError(error) }
      },
    )

    server.tool(
      'browser_click',
      'Clicks an element identified by its snapshot ref (e.g. e12). Refs must come from a recent browser_snapshot.',
      { ref: z.string() },
      async ({ ref }) => {
        try {
          await automation.click(ref)
          return { content: [{ type: 'text', text: `Clicked ${ref}` }] }
        } catch (error) { return toolError(error) }
      },
    )

    server.tool(
      'browser_type',
      'Types text into an element identified by its snapshot ref. Clears focus first.',
      { ref: z.string(), text: z.string() },
      async ({ ref, text }) => {
        try {
          await automation.type(ref, text)
          return { content: [{ type: 'text', text: `Typed into ${ref}` }] }
        } catch (error) { return toolError(error) }
      },
    )

    server.tool(
      'browser_select',
      'Selects a value in a combobox element identified by its snapshot ref.',
      { ref: z.string(), value: z.string() },
      async ({ ref, value }) => {
        try {
          await automation.select(ref, value)
          return { content: [{ type: 'text', text: `Selected in ${ref}` }] }
        } catch (error) { return toolError(error) }
      },
    )

    server.tool(
      'browser_press_key',
      'Presses a keyboard key (e.g. Enter, Tab, Escape).',
      { key: z.string() },
      async ({ key }) => {
        try {
          await automation.pressKey(key)
          return { content: [{ type: 'text', text: `Pressed ${key}` }] }
        } catch (error) { return toolError(error) }
      },
    )

    server.tool(
      'browser_scroll',
      'Scrolls the page in a direction (up, down, left, right) by an amount.',
      { direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().optional() },
      async ({ direction, amount }) => {
        try {
          await automation.scroll(direction || 'down', amount)
          return { content: [{ type: 'text', text: 'Scrolled' }] }
        } catch (error) { return toolError(error) }
      },
    )

    server.tool(
      'browser_wait',
      'Waits for a condition (load, networkidle) or a timeout in milliseconds.',
      { condition: z.enum(['load', 'networkidle']).optional(), timeout: z.number().optional() },
      async ({ condition, timeout }) => {
        try {
          await automation.wait(condition || 'load', timeout)
          return { content: [{ type: 'text', text: 'Wait complete' }] }
        } catch (error) { return toolError(error) }
      },
    )

    server.tool('browser_back', 'Navigates the shared browser back in history.', {}, async () => {
      try { browserManager.back(); return { content: [{ type: 'text', text: 'Navigated back' }] } }
      catch (error) { return toolError(error) }
    })

    server.tool('browser_forward', 'Navigates the shared browser forward in history.', {}, async () => {
      try { browserManager.forward(); return { content: [{ type: 'text', text: 'Navigated forward' }] } }
      catch (error) { return toolError(error) }
    })

    server.tool('browser_reload', 'Reloads the current page of the shared browser.', {}, async () => {
      try { browserManager.reload(); return { content: [{ type: 'text', text: 'Reloaded' }] } }
      catch (error) { return toolError(error) }
    })

    return server
  }

  function jsonRpcError(res, status, message) {
    if (res.headersSent) return
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
  }

  async function readJsonBody(req) {
    if (req.method !== 'POST') return undefined
    const chunks = []
    let length = 0
    for await (const chunk of req) {
      length += chunk.length
      if (length > 1024 * 1024) throw new Error('Request body is too large')
      chunks.push(chunk)
    }
    if (!chunks.length) return undefined
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  async function handleRequest(req, res) {
    const auth = req.headers['authorization'] || ''
    const expected = `Bearer ${token}`
    if (auth !== expected) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    try {
      const sessionHeader = req.headers['mcp-session-id']
      const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader
      const parsedBody = await readJsonBody(req)
      let entry = sessionId ? sessions.get(sessionId) : null

      if (!entry && !sessionId && isInitializeRequest(parsedBody)) {
        const server = buildServer()
        let transport
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (initializedId) => {
            sessions.set(initializedId, { server, transport })
          },
        })
        transport.onclose = () => {
          const initializedId = transport.sessionId
          if (initializedId && sessions.get(initializedId)?.transport === transport) sessions.delete(initializedId)
        }
        entry = { server, transport }
        await server.connect(transport)
      }

      if (!entry) {
        jsonRpcError(res, 400, 'Bad Request: No valid MCP session ID provided')
        return
      }

      await entry.transport.handleRequest(req, res, parsedBody)
    } catch (error) {
      jsonRpcError(res, 500, error && error.message ? error.message : 'MCP error')
    }
  }

  async function start() {
    if (started) return { port, token, url: endpoint() }
    httpServer = http.createServer((req, res) => { void handleRequest(req, res) })
    await new Promise((resolve, reject) => {
      httpServer.listen(0, '127.0.0.1', resolve)
      httpServer.on('error', reject)
    })
    const address = httpServer.address()
    port = typeof address === 'object' && address ? address.port : 0
    started = true
    return { port, token, url: endpoint() }
  }

  function endpoint() {
    return `http://127.0.0.1:${port}/mcp`
  }

  function descriptor() {
    return { name: SERVER_NAME, url: endpoint(), token, port }
  }

  async function stop() {
    if (!started) return
    started = false
    for (const [, entry] of sessions) {
      try { await entry.server.close() } catch {}
    }
    sessions.clear()
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(() => resolve()))
      httpServer = null
    }
  }

  function isReady() { return started }

  return { start, stop, endpoint, descriptor, isReady, get token() { return token } }
}

module.exports = { createBrowserMcp, SERVER_NAME, SERVER_VERSION }
