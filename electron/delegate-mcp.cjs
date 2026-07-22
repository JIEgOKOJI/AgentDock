'use strict'

// Delegation Belt — a scoped MCP server that exposes a controlled subset of
// AgentDock orchestration to the running agent. Spawned only when a run opts in
// (request.delegate = true). One server instance per run; it self-terminates
// with the run.
//
// Policy is enforced server-side (caps, nesting depth, budget headroom):
//  - delegate_ask    → read-only sub-run (intent = ask), no apply/decision
//  - delegate_plan    → plan-mode sub-run (intent = plan), writes plan file
//  - delegate_run     → write sub-run (intent = agent) inside a worktree
//  - delegate_best_of → best-of-N race scoped to the parent budget
//  - delegate_run_status → poll a spawned sub-run
//  - delegate_run_result → fetch summary/artifact of a finished sub-run
//
// No apply/decision/thread/settings surfaces: a delegate cannot adopt a patch,
// approve gates, rotate profiles, or change settings. It only spawns scoped
// work and reports it back.

const http = require('node:http')
const crypto = require('node:crypto')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js')
const { z } = require('zod')

const SERVER_NAME = 'agentdock-delegate'
const SERVER_VERSION = '0.2.0'

const DEFAULT_POLICY = {
  maxSubRuns: 8,        // hard cap on spawned sub-runs per parent run
  maxDepth: 1,           // nesting depth — sub-runs cannot delegate further
  maxBestOfN: 3,         // cap on --n inside delegate_best_of
  parentBudgetUsd: null, // remaining parent budget; sub-runs must stay under it
  sessionSpendUsd: 0,    // already spent by the parent run
}

function toolError(message, code = 'DELEGATE_ERROR') {
  return { isError: true, content: [{ type: 'text', text: `[${code}] ${message}` }] }
}

function okText(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] }
}

function createDelegateMcp(options = {}) {
  const token = options.token || crypto.randomBytes(32).toString('hex')
  const policy = { ...DEFAULT_POLICY, ...(options.policy || {}) }
  const context = options.context || {}
  // spawnSubRun(kind, params) returns { subRunId, ok, error, ...meta } — provided
  // by main.cjs and backed by the same agent:run pipeline (read-only for ask/plan,
  // worktree-scoped for agent). resultOf(subRunId) returns the receipt + artifacts.
  const spawnSubRun = options.spawnSubRun || (async () => ({ ok: false, error: 'Delegation is not configured' }))
  const resultOf = options.resultOf || (() => null)
  const statusOf = options.statusOf || (() => null)
  const sessions = new Map()
  let httpServer = null
  let port = 0
  let started = false
  const activeSubRuns = new Map()
  let spawnCount = 0

  function remainingSubRuns() { return Math.max(0, policy.maxSubRuns - spawnCount) }
  function budgetRemaining() {
    if (policy.parentBudgetUsd == null) return null
    return Math.max(0, policy.parentBudgetUsd - policy.sessionSpendUsd)
  }
  function underBudget(estimatedUsd) {
    const remaining = budgetRemaining()
    if (remaining == null) return true
    return (estimatedUsd || 0) <= remaining
  }

  function buildServer() {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { instructions: 'AgentDock delegation belt. Spawn scoped sub-runs (ask/plan/run/best-of). No apply/decision/thread/settings surfaces. Nesting depth is capped to 1; sub-runs cannot delegate further.' },
    )

    server.tool(
      'delegate_ask',
      'Spawn a read-only sub-run (intent=ask). The sub-run cannot mutate files. Use for "research this", "summarize that". Returns a subRunId immediately; poll with delegate_run_status, fetch output with delegate_run_result.',
      {
        prompt: z.string().min(1),
        provider: z.string().optional(),
        profileId: z.string().optional(),
        model: z.string().optional(),
      },
      async (params) => {
        if (remainingSubRuns() <= 0) return toolError('Sub-run cap reached', 'CAP_EXCEEDED')
        try {
          const result = await spawnSubRun('ask', params)
          if (result?.subRunId) { spawnCount += 1; activeSubRuns.set(result.subRunId, { kind: 'ask', params, startedAt: Date.now() }) }
          return okText(result)
        } catch (error) { return toolError(error && error.message ? error.message : String(error)) }
      },
    )

    server.tool(
      'delegate_plan',
      'Spawn a plan-mode sub-run (intent=plan). Writes a plan file and open questions; no file mutations. Returns subRunId; use delegate_run_result to read the plan.',
      {
        prompt: z.string().min(1),
        provider: z.string().optional(),
        profileId: z.string().optional(),
        model: z.string().optional(),
      },
      async (params) => {
        if (remainingSubRuns() <= 0) return toolError('Sub-run cap reached', 'CAP_EXCEEDED')
        try {
          const result = await spawnSubRun('plan', params)
          if (result?.subRunId) { spawnCount += 1; activeSubRuns.set(result.subRunId, { kind: 'plan', params, startedAt: Date.now() }) }
          return okText(result)
        } catch (error) { return toolError(error && error.message ? error.message : String(error)) }
      },
    )

    server.tool(
      'delegate_run',
      'Spawn a write sub-run (intent=agent) inside an isolated worktree. Use for "fix this file", "implement this helper". Returns subRunId; poll with delegate_run_status, fetch patch+summary with delegate_run_result.',
      {
        prompt: z.string().min(1),
        provider: z.string().optional(),
        profileId: z.string().optional(),
        model: z.string().optional(),
        reason: z.string().optional(),
        isolated: z.boolean().optional(),
      },
      async (params) => {
        if (remainingSubRuns() <= 0) return toolError('Sub-run cap reached', 'CAP_EXCEEDED')
        try {
          const result = await spawnSubRun('agent', { isolated: true, ...params })
          if (result?.subRunId) { spawnCount += 1; activeSubRuns.set(result.subRunId, { kind: 'agent', params, startedAt: Date.now() }) }
          return okText(result)
        } catch (error) { return toolError(error && error.message ? error.message : String(error)) }
      },
    )

    server.tool(
      'delegate_best_of',
      'Spawn a best-of-N race scoped to the parent budget. Each candidate runs in its own worktree; winner patch is NOT auto-adopted (delegates cannot adopt). Returns raceId immediately; poll with delegate_run_status.',
      {
        prompt: z.string().min(1),
        n: z.number().int().min(2).optional(),
        providers: z.array(z.string()).optional(),
        model: z.string().optional(),
      },
      async (params) => {
        if (remainingSubRuns() <= 0) return toolError('Sub-run cap reached', 'CAP_EXCEEDED')
        const n = Math.min(params.n || 2, policy.maxBestOfN)
        if (n < 2) return toolError(`best_of requires n >= 2 (capped at ${policy.maxBestOfN})`, 'CAP_EXCEEDED')
        const estimatedUsd = context.estimatedCostPerCandidate ? context.estimatedCostPerCandidate(n) : null
        if (!underBudget(estimatedUsd)) return toolError('Remaining budget is insufficient for best-of-N', 'BUDGET_EXCEEDED')
        try {
          // 6.4: delegate_best_of calls the race orchestrator with autoAdopt=false
          const result = await spawnSubRun('race', { ...params, n, autoAdopt: false })
          if (result?.subRunId) { spawnCount += 1; activeSubRuns.set(result.subRunId, { kind: 'race', params, startedAt: Date.now() }) }
          return okText(result)
        } catch (error) { return toolError(error && error.message ? error.message : String(error)) }
      },
    )

    server.tool(
      'delegate_run_status',
      'Poll a spawned sub-run by id. Returns { state: running|completed|failed|unknown, ...meta }.',
      { subRunId: z.string().min(1) },
      async ({ subRunId }) => {
        try {
          const status = statusOf(subRunId) || activeSubRuns.get(subRunId) && { state: 'running' }
          if (!status) return okText({ state: 'unknown', subRunId })
          return okText(status)
        } catch (error) { return toolError(error && error.message ? error.message : String(error)) }
      },
    )

    server.tool(
      'delegate_run_result',
      'Fetch the result of a finished sub-run: summary, patch (for write runs), plan (for plan runs), outcome, cost. Returns null if still running.',
      { subRunId: z.string().min(1) },
      async ({ subRunId }) => {
        try {
          const result = resultOf(subRunId)
          if (!result) return okText({ subRunId, result: null })
          return okText({ subRunId, result })
        } catch (error) { return toolError(error && error.message ? error.message : String(error)) }
      },
    )

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
        const transport = new StreamableHTTPServerTransport({
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

  function endpoint() { return `http://127.0.0.1:${port}/mcp` }

  function descriptor() {
    return {
      name: SERVER_NAME,
      url: endpoint(),
      token,
      tokenEnvVar: 'AGENTDOCK_DELEGATE_MCP_TOKEN',
      port,
      required: false,
    }
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

  function describePolicy() {
    return {
      remainingSubRuns: remainingSubRuns(),
      maxSubRuns: policy.maxSubRuns,
      maxDepth: policy.maxDepth,
      budgetRemaining: budgetRemaining(),
    }
  }

  return { start, stop, endpoint, descriptor, isReady, get token() { return token }, describePolicy }
}

module.exports = { createDelegateMcp, SERVER_NAME, SERVER_VERSION, DEFAULT_POLICY }