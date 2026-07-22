const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { spawn, execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { globalSkillPrompt, hashSkillDirectory, isInside, listSkills, shareTargetPaths, skillRoot, skillTemplate } = require('./skills.cjs')
const { normalizePermissionMode, permissionLaunchOptions } = require('./permissions.cjs')
const { adapters } = require('./adapters.cjs')
const { createBrowserManager } = require('./browser-manager.cjs')
const { createBrowserAutomation } = require('./browser-automation.cjs')
const { createBrowserMcp, SERVER_NAME: BROWSER_MCP_NAME } = require('./browser-mcp.cjs')
const { browserMcpLaunchOptions, withBrowserAwarenessPrompt } = require('./browser-mcp-config.cjs')
const { normalizeBounds } = require('./browser-url.cjs')
const mcp = require('./mcp-manager.cjs')

const running = new Map()
const SESSION_STORE_VERSION = 1
const SETTINGS_STORE_VERSION = 3
const getCodexHome = () => process.env.CODEX_HOME || path.join(app.getPath('home'), '.codex')
const { readProfiles, writeProfiles, normalizeProfile, profileEnvOverlay, findProfile, readyProfilesForProvider, isProfileExhausted, nextReadyProfile, detectDefaultProfiles, mergeProfiles } = require('./profiles.cjs')
const { ensureLaneDir, normalizeLanes, getLaneState, setLaneState, migrateLegacySession } = require('./lanes.cjs')
const { ensureRunDir, appendEvents, writePatch, writeSummary, writeReceipt, listRuns, readArtifact, buildDiffFromChanges, normalizeReceipt } = require('./artifacts.cjs')
const { writeCheckpoint, readCheckpoint, writeThread, readThread, buildContinuationPacket, continuityEventPayload, laneLabel, buildThreadFromMessages } = require('./continuity.cjs')

const DEFAULT_SETTINGS = { defaultGlobalSkills: [], contextHandoff: true, limitAction: 'fail' }

const browserManager = createBrowserManager()
const browserAutomation = createBrowserAutomation(browserManager)
const browserMcp = createBrowserMcp(browserManager, browserAutomation)
let browserMcpReady = false
let mainWindow = null

function normalizeTokenUsage(value) {
  if (!value || typeof value !== 'object') return undefined
  const number = (field) => Number.isFinite(value[field]) ? Math.max(0, value[field]) : 0
  const contextWindow = Number.isFinite(value.contextWindow) && value.contextWindow > 0 ? value.contextWindow : null
  return {
    inputTokens: number('inputTokens'),
    cachedInputTokens: number('cachedInputTokens'),
    outputTokens: number('outputTokens'),
    reasoningTokens: number('reasoningTokens'),
    totalTokens: number('totalTokens'),
    contextTokens: number('contextTokens'),
    contextWindow,
  }
}

function getSessionStorePath() {
  return path.join(app.getPath('userData'), 'sessions.json')
}

function getSettingsStorePath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function readSettings() {
  try {
    const store = JSON.parse(fs.readFileSync(getSettingsStorePath(), 'utf8'))
    if (store?.version !== SETTINGS_STORE_VERSION) return { ...DEFAULT_SETTINGS }
    return {
      defaultGlobalSkills: Array.isArray(store.defaultGlobalSkills) ? [...new Set(store.defaultGlobalSkills.filter((id) => typeof id === 'string' && id.startsWith('global:')))] : [],
      contextHandoff: typeof store.contextHandoff === 'boolean' ? store.contextHandoff : true,
      limitAction: store.limitAction === 'rotate' || store.limitAction === 'ask' ? store.limitAction : 'fail',
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function writeSettings(settings) {
  const storePath = getSettingsStorePath()
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  fs.writeFileSync(storePath, JSON.stringify({ version: SETTINGS_STORE_VERSION, ...settings }, null, 2), 'utf8')
}

function normalizeGitInfo(value) {
  if (!value || typeof value !== 'object') return undefined
  const branches = Array.isArray(value.branches) ? value.branches.filter((branch) => typeof branch === 'string') : []
  return {
    isRepo: Boolean(value.isRepo),
    currentBranch: typeof value.currentBranch === 'string' ? value.currentBranch : '',
    branches,
  }
}

function normalizeSession(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.workspace !== 'string') return null
  const messages = Array.isArray(value.messages) ? value.messages.filter((message) =>
    message && typeof message.id === 'string' && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string' && !message.pending,
  ).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    ...(typeof message.provider === 'string' ? { provider: message.provider } : {}),
    ...(Array.isArray(message.activities) ? { activities: message.activities.filter((activity) => activity && typeof activity.title === 'string') } : {}),
    ...(Array.isArray(message.files) ? { files: message.files.filter((file) => file && typeof file.path === 'string').map((file) => ({ path: file.path, additions: Number(file.additions) || 0, deletions: Number(file.deletions) || 0, ...(typeof file.diff === 'string' ? { diff: file.diff } : {}) })) } : {}),
  })) : []
  const usage = normalizeTokenUsage(value.usage)
  const git = normalizeGitInfo(value.git)
  const attachments = Array.isArray(value.attachments) ? value.attachments.filter((file) => typeof file === 'string') : []
  return {
    id: value.id,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 100) : 'New session',
    workspace: path.resolve(value.workspace),
    provider: adapters[value.provider] ? value.provider : 'codex',
    model: typeof value.model === 'string' ? value.model : '',
    reasoning: typeof value.reasoning === 'string' ? value.reasoning : '',
    agent: typeof value.agent === 'string' ? value.agent : 'default',
    permissionMode: normalizePermissionMode(value.permissionMode),
    messages,
    ...(typeof value.profileId === 'string' && value.profileId ? { profileId: value.profileId } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(git ? { git } : {}),
    ...(usage ? { usage } : {}),
    lanes: normalizeLanes(value.lanes),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
  }
}

function readSessions() {
  try {
    const store = JSON.parse(fs.readFileSync(getSessionStorePath(), 'utf8'))
    if (store?.version !== SESSION_STORE_VERSION || !Array.isArray(store.sessions)) return []
    return store.sessions.map((session) => normalizeSession(migrateLegacySession(session))).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

function writeSessions(sessions) {
  const storePath = getSessionStorePath()
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  fs.writeFileSync(storePath, JSON.stringify({ version: SESSION_STORE_VERSION, sessions }, null, 2), 'utf8')
}

const fallbackModels = {
  codex: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoning: 'low' }],
  claude: [
    { id: 'sonnet', label: 'Sonnet (latest)', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoning: 'high' },
    { id: 'opus', label: 'Opus (latest)', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoning: 'high' },
    { id: 'haiku', label: 'Haiku (latest)', reasoning: ['low', 'medium', 'high'], defaultReasoning: 'medium' },
  ],
  opencode: [],
}

function execCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 12000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout = '', stderr = '') => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function execCaptureWithRetry(command, args, options = {}, accept = (result) => result.ok) {
  const retryDelays = [0, 400, 1200]
  let result
  for (const retryDelay of retryDelays) {
    if (retryDelay) await wait(retryDelay)
    result = await execCapture(command, args, options)
    if (accept(result)) return result
  }
  return result
}

async function readWorkspaceChanges(cwd, includeDiff = false) {
  const repository = await execCapture('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
  if (!repository.ok || !/^true$/i.test(repository.stdout.trim())) return new Map()
  let tracked = await execCapture('git', ['diff', '--numstat', 'HEAD', '--'], { cwd })
  const hasHead = tracked.ok
  if (!hasHead) tracked = await execCapture('git', ['diff', '--numstat', '--'], { cwd })
  const changes = new Map()
  for (const line of tracked.stdout.split(/\r?\n/).filter(Boolean)) {
    const [added, deleted, ...fileParts] = line.split('\t')
    const file = fileParts.join('\t')
    if (file) {
      let diff = ''
      if (includeDiff) {
        const result = await execCapture('git', ['diff', '--no-color', '--unified=3', ...(hasHead ? ['HEAD'] : []), '--', file], { cwd })
        diff = result.ok ? result.stdout.slice(0, 250000) : ''
      }
      changes.set(file, { path: file, additions: Number(added) || 0, deletions: Number(deleted) || 0, diff })
    }
  }
  const untracked = await execCapture('git', ['ls-files', '--others', '--exclude-standard'], { cwd })
  for (const file of untracked.stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const content = fs.readFileSync(path.join(cwd, file), 'utf8')
      const contentLines = content ? content.split(/\r?\n/) : []
      const diff = includeDiff ? [`--- /dev/null`, `+++ b/${file.replace(/\\/g, '/')}`, `@@ -0,0 +1,${contentLines.length} @@`, ...contentLines.map((line) => `+${line}`)].join('\n').slice(0, 250000) : ''
      changes.set(file, { path: file, additions: contentLines.length, deletions: 0, diff })
    } catch { changes.set(file, { path: file, additions: 0, deletions: 0, diff: '' }) }
  }
  return changes
}

function workspaceChangeDelta(before, after) {
  const result = []
  for (const [file, current] of after) {
    const previous = before.get(file) || { additions: 0, deletions: 0 }
    const additions = Math.abs(current.additions - previous.additions)
    const deletions = Math.abs(current.deletions - previous.deletions)
    if (additions || deletions || !before.has(file)) result.push({ path: file, additions, deletions, ...(current.diff ? { diff: current.diff } : {}) })
  }
  return result.sort((left, right) => left.path.localeCompare(right.path))
}

function stripAnsi(value) {
  return value.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
}

async function getVersion(command) {
  const result = await execCaptureWithRetry(command, ['--version'], {}, (candidate) => candidate.ok && Boolean(stripAnsi(candidate.stdout).trim()))
  return result.ok ? stripAnsi(result.stdout).trim().split(/\r?\n/)[0] : null
}

function getCodexModels() {
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let buffer = ''
    let finished = false
    const finish = (models = fallbackModels.codex) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      child.kill()
      resolve(models)
    }
    const timer = setTimeout(() => finish(), 8000)
    child.on('error', () => finish())
    child.stdin.on('error', () => finish())
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        try {
          const message = JSON.parse(line)
          if (message.id === 1) {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`)
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'model/list', params: { limit: 100, includeHidden: false } })}\n`)
          }
          if (message.id === 2 && Array.isArray(message.result?.data)) {
            finish(message.result.data.map((item) => ({
              id: item.model,
              label: item.displayName || item.model,
              description: item.description || '',
              reasoning: item.supportedReasoningEfforts?.map((effort) => effort.reasoningEffort) || [],
              defaultReasoning: item.defaultReasoningEffort || '',
            })))
          }
        } catch {}
      }
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'agentdock', title: 'AgentDock', version: app.getVersion() }, capabilities: { experimentalApi: true } } })}\n`)
  })
}

async function getOpenCodeModels() {
  // Run the basic query first so OpenCode can finish any first-run initialization
  // before a second process reads the same provider/configuration state.
  const hasOutput = (result) => result.ok && Boolean(stripAnsi(result.stdout).trim())
  const basic = await execCaptureWithRetry('opencode', ['models'], {}, hasOutput)
  const verbose = await execCaptureWithRetry('opencode', ['models', '--verbose'], {}, hasOutput)
  const metadataById = new Map()
  const output = stripAnsi(verbose.stdout)
  for (const match of output.matchAll(/^([^\r\n{][^\r\n]*)\r?\n(\{[\s\S]*?^\})/gm)) {
    try {
      const metadata = JSON.parse(match[2])
      const reasoning = Object.keys(metadata.variants || {})
      const id = match[1].trim()
      metadataById.set(id, {
        id,
        label: metadata.name || id,
        description: metadata.family || '',
        contextWindow: Number(metadata.limit?.context) || undefined,
        reasoning,
        defaultReasoning: reasoning.includes('medium') ? 'medium' : reasoning[0] || '',
      })
    } catch {}
  }
  const ids = stripAnsi(basic.stdout).split(/\r?\n/).map((id) => id.trim()).filter(Boolean)
  if (ids.length) return ids.map((id) => metadataById.get(id) || { id, label: id, reasoning: [], defaultReasoning: '' })
  if (metadataById.size) return [...metadataById.values()]
  return fallbackModels.opencode
}

async function getClaudeRateLimits(env = process.env) {
  const result = await execCapture('claude', ['--print', '--output-format', 'json', '/usage'], { timeout: 20000, env })
  const unavailable = (error) => ({ available: false, planType: null, limitName: null, primary: null, secondary: null, error })
  if (!result.ok) return unavailable(stripAnsi(result.stderr).trim() || 'Claude usage is unavailable')
  try {
    const text = JSON.parse(result.stdout).result || ''
    const windows = [...text.matchAll(/^(.+?):\s*(\d+)% used\s*·\s*(.+)$/gmi)].map((match) => {
      const label = match[1].trim()
      return {
        label,
        usedPercent: Number(match[2]),
        windowDurationMins: /^Current session$/i.test(label) ? 300 : /^Current week/i.test(label) ? 10080 : null,
        resetsAt: null,
        resetText: match[3].trim(),
      }
    })
    if (!windows.length) return unavailable('Claude did not return subscription limits')
    return { available: true, planType: null, limitName: null, primary: windows[0] || null, secondary: windows[1] || null, windows }
  } catch {
    return unavailable('Could not parse Claude usage output')
  }
}

function getCodexRateLimits(env = process.env) {
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env })
    let buffer = ''
    let finished = false
    const finish = (value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      child.kill()
      resolve(value)
    }
    const unavailable = (error) => ({ available: false, planType: null, limitName: null, primary: null, secondary: null, error })
    const timer = setTimeout(() => finish(unavailable('Timed out while reading Codex limits')), 8000)
    child.on('error', (error) => finish(unavailable(error.message)))
    child.stdin.on('error', (error) => finish(unavailable(error.message)))
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        try {
          const message = JSON.parse(line)
          if (message.id === 1) {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`)
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} })}\n`)
          }
          if (message.id === 2) {
            const snapshot = message.result?.rateLimits
            if (!snapshot) return finish(unavailable('Codex did not return usage limits'))
            finish({
              available: true,
              planType: snapshot.planType || null,
              limitName: snapshot.limitName || null,
              primary: snapshot.primary || null,
              secondary: snapshot.secondary || null,
            })
          }
        } catch {}
      }
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'agentdock', title: 'AgentDock', version: app.getVersion() }, capabilities: { experimentalApi: true } } })}\n`)
  })
}

async function getClaudeModels() {
  const aliasesToResolve = ['sonnet', 'opus', 'haiku', 'fable']
  const hasJsonResult = (result) => {
    if (!result.ok || !result.stdout.trim()) return false
    try { return Boolean(JSON.parse(result.stdout).result) } catch { return false }
  }
  // Claude may initialize credentials/configuration on the overview request. Do not
  // race that work with several alias-resolution processes during application start.
  const overviewResult = await execCaptureWithRetry('claude', ['--print', '--output-format', 'json', '/model'], {}, hasJsonResult)
  if (!overviewResult.ok) return fallbackModels.claude
  const aliasResults = await Promise.all(aliasesToResolve.map((alias) =>
    execCaptureWithRetry('claude', ['--print', '--output-format', 'json', `/model ${alias}`], {}, hasJsonResult),
  ))
  const results = [overviewResult, ...aliasResults]
  try {
    const overview = JSON.parse(results[0].stdout).result || ''
    const available = overview.match(/Available:\s*(.+?)(?:\.|$)/)?.[1]?.split(',').map((item) => item.trim()).filter((item) => item && !/^or\s+/i.test(item)) || aliasesToResolve
    const labels = new Map()
    const current = overview.match(/Current model:\s*(.+?)\s*\(default\)/)?.[1]
    if (current) labels.set('default', `${current} (default)`)
    aliasesToResolve.forEach((alias, index) => {
      try {
        const message = JSON.parse(results[index + 1].stdout).result || ''
        const resolved = message.match(/Set model to (.+?) for this session/i)?.[1] || message.match(/^([A-Z][A-Za-z]+\s+\d+(?:\.\d+)?)/)?.[1]
        if (resolved) labels.set(alias, resolved)
      } catch {}
    })
    return available.map((id) => ({
      id,
      label: labels.get(id) || id.replace(/^./, (letter) => letter.toUpperCase()),
      reasoning: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoning: 'high',
    }))
  } catch {
    return fallbackModels.claude
  }
}

async function getOpenCodeAgents() {
  const result = await execCapture('opencode', ['agent', 'list'])
  if (!result.ok) return ['default']
  const agents = [...stripAnsi(result.stdout).matchAll(/^([^\s].*?)\s+\((?:primary|subagent)\)\s*$/gm)].map((match) => match[1].trim())
  return ['default', ...new Set(agents)]
}

async function loadSystemInfo() {
  const entries = await Promise.all(Object.entries(adapters).map(async ([id, adapter]) => {
    const detected = await commandExists(adapter.executable)
    if (!detected.installed) return [id, { ...detected, version: null, models: [], agents: ['default'] }]
    const [version, models, agents] = await Promise.all([
      getVersion(adapter.executable),
      id === 'codex' ? getCodexModels() : id === 'opencode' ? getOpenCodeModels() : getClaudeModels(),
      id === 'opencode' ? getOpenCodeAgents() : Promise.resolve(['default']),
    ])
    return [id, { ...detected, version, models, agents }]
  }))
  return { platform: process.platform, providers: Object.fromEntries(entries), home: app.getPath('home'), cwd: process.cwd() }
}

async function loadMcpServers() {
  const servers = new Map()
  const add = (name, provider, enabled = true, detail = '') => {
    if (!name) return
    const current = servers.get(name) || { name, providers: [], enabled: false, detail: '' }
    if (!current.providers.includes(provider)) current.providers.push(provider)
    current.enabled ||= enabled
    current.detail ||= detail
    servers.set(name, current)
  }

  const [codex, claude, opencode] = await Promise.all([
    execCapture('codex', ['mcp', 'list', '--json']),
    execCapture('claude', ['mcp', 'list']),
    execCapture('opencode', ['mcp', 'list']),
  ])
  if (codex.ok) {
    try {
      for (const item of JSON.parse(codex.stdout)) add(item.name, 'codex', item.enabled !== false, item.transport?.type || 'MCP server')
    } catch {}
  }
  for (const line of stripAnsi(claude.stdout).split(/\r?\n/)) {
    const match = line.match(/^([^:]+):.*(?:Connected|Pending|Failed|Disconnected)/i)
    if (match) add(match[1].trim(), 'claude', /Connected/i.test(line), 'Claude Code')
  }
  for (const line of stripAnsi(opencode.stdout).split(/\r?\n/)) {
    const match = line.match(/[●○!]?\s*([^\s].*?)\s+(?:connected|enabled|disabled|failed)$/i)
    if (match) add(match[1].trim(), 'opencode', /connected|enabled/i.test(line), 'OpenCode')
  }
  // Managed embedded browser MCP — automatically injected into every agent run.
  add(BROWSER_MCP_NAME, 'codex', browserMcpReady, browserMcpReady ? 'AgentDock embedded browser (auto-injected)' : 'AgentDock embedded browser (starting)')
  add(BROWSER_MCP_NAME, 'claude', browserMcpReady, browserMcpReady ? 'AgentDock embedded browser (auto-injected)' : 'AgentDock embedded browser (starting)')
  add(BROWSER_MCP_NAME, 'opencode', browserMcpReady, browserMcpReady ? 'AgentDock embedded browser (auto-injected)' : 'AgentDock embedded browser (starting)')
  return [...servers.values()]
}

function commandExists(command) {
  return new Promise((resolve) => {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which'
    execFile(locator, [command], { windowsHide: true }, (error, stdout) => {
      resolve({ installed: !error, path: error ? null : stdout.trim().split(/\r?\n/)[0] })
    })
  })
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#090b10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? false : {
      color: '#090b10', symbolColor: '#8f96a3', height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow = window
  browserManager.attach(window)

  const syncBrowserBounds = () => {
    if (!browserManager.isVisible()) return
    window.webContents.send('browser:request-bounds')
  }
  window.on('resize', syncBrowserBounds)

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.VITE_DEV_SERVER_URL) window.loadURL(process.env.VITE_DEV_SERVER_URL)
  else window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

ipcMain.handle('system:info', loadSystemInfo)

ipcMain.handle('mcp:list', loadMcpServers)

ipcMain.handle('mcp:managed-list', (_event, request = {}) => mcp.listServers(app.getPath('userData'), request.workspace))

ipcMain.handle('mcp:managed-upsert', (_event, request = {}) => mcp.upsertServer(app.getPath('userData'), request))

ipcMain.handle('mcp:managed-remove', (_event, id) => mcp.removeServer(app.getPath('userData'), id))

ipcMain.handle('mcp:managed-toggle', (_event, request = {}) => mcp.setServerEnabled(app.getPath('userData'), request.id, request.enabled))

ipcMain.handle('mcp:managed-import', async (_event, request = {}) => {
  const home = app.getPath('home')
  const codexHome = getCodexHome()
  return mcp.importIntoStore(app.getPath('userData'), home, codexHome, request.workspace)
})

ipcMain.handle('mcp:managed-sync', async (_event, request = {}) => {
  const home = app.getPath('home')
  const codexHome = getCodexHome()
  return mcp.syncAll(app.getPath('userData'), home, codexHome, { providers: request.providers, workspace: request.workspace })
})

ipcMain.handle('mcp:managed-check', async (_event, serverInput) => {
  const normalized = mcp.normalizeServer(serverInput)
  if (!normalized) return { ok: false, detail: 'Invalid server definition' }
  return mcp.checkServerHealth(normalized)
})

ipcMain.handle('mcp:managed-export', (_event, request = {}) => mcp.exportServers(app.getPath('userData'), request.ids))

ipcMain.handle('mcp:managed-import-payload', async (_event, request = {}) => {
  if (request.path) {
    try {
      const content = fs.readFileSync(request.path, 'utf8')
      const payload = JSON.parse(content)
      return mcp.importExport(app.getPath('userData'), payload)
    } catch (error) {
      throw new Error(`Could not read export file: ${error.message}`)
    }
  }
  return mcp.importExport(app.getPath('userData'), request.payload)
})

ipcMain.handle('mcp:managed-export-save', async (_event, request = {}) => {
  const payload = mcp.exportServers(app.getPath('userData'), request.ids)
  const result = await dialog.showSaveDialog({
    title: 'Export MCP server configurations',
    defaultPath: 'agentdock-mcp-servers.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8')
  return { canceled: false, path: result.filePath }
})

ipcMain.handle('mcp:managed-conflicts', async (_event, request = {}) => {
  const home = app.getPath('home')
  const codexHome = getCodexHome()
  return mcp.detectConflicts(app.getPath('userData'), home, codexHome, request.workspace)
})

// --- Browser IPC ---
ipcMain.handle('browser:get-state', () => browserManager.getState())
ipcMain.handle('browser:open', async (_event, url) => browserManager.open(url))
ipcMain.handle('browser:show', async () => browserManager.showView())
ipcMain.handle('browser:hide', async () => browserManager.hideView())
ipcMain.handle('browser:navigate', async (_event, url) => browserManager.navigate(url))
ipcMain.handle('browser:back', async () => browserManager.back())
ipcMain.handle('browser:forward', async () => browserManager.forward())
ipcMain.handle('browser:reload', async () => browserManager.reload())
ipcMain.handle('browser:stop', async () => browserManager.stop())
ipcMain.handle('browser:set-bounds', async (_event, rawBounds) => {
  if (!mainWindow) return
  const windowBounds = mainWindow.getBounds()
  const normalized = normalizeBounds(rawBounds, { width: windowBounds.width, height: windowBounds.height })
  if (normalized.ok) browserManager.setBounds(normalized.bounds)
})
ipcMain.handle('browser:open-external', async () => {
  const state = browserManager.getState()
  if (state && /^https?:/.test(state.url)) await shell.openExternal(state.url)
})
ipcMain.handle('browser:cancel-agent-action', async () => {
  browserAutomation.cancel()
  browserManager.notifyAction({ actor: 'user', status: 'completed', startedAt: Date.now(), summary: 'Agent action cancelled by user' })
  return true
})

function forwardBrowserState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser:state', state)
}
function forwardBrowserAction(action) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser:action', action)
}
browserManager.onState(forwardBrowserState)
browserManager.onAction(forwardBrowserAction)

ipcMain.handle('skills:list', (_event, workspace) => {
  const resolvedWorkspace = path.resolve(workspace || process.cwd())
  if (!fs.existsSync(resolvedWorkspace) || !fs.statSync(resolvedWorkspace).isDirectory()) throw new Error('Workspace does not exist')
  return listSkills(resolvedWorkspace, app.getPath('home'), getCodexHome())
})

ipcMain.handle('skills:defaults', () => readSettings().defaultGlobalSkills)

ipcMain.handle('skills:set-default', (_event, request = {}) => {
  const workspace = path.resolve(request.workspace || process.cwd())
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error('Workspace does not exist')
  const skill = listSkills(workspace, app.getPath('home'), getCodexHome()).find((item) => item.id === request.id && item.scope === 'global')
  if (!skill) throw new Error('Global skill was not found')
  const settings = readSettings()
  const defaults = new Set(settings.defaultGlobalSkills)
  if (request.enabled) defaults.add(skill.id)
  else defaults.delete(skill.id)
  settings.defaultGlobalSkills = [...defaults].sort()
  writeSettings(settings)
  return settings.defaultGlobalSkills
})

ipcMain.handle('settings:get', () => readSettings())

ipcMain.handle('settings:patch', (_event, request = {}) => {
  const settings = readSettings()
  if (typeof request.contextHandoff === 'boolean') settings.contextHandoff = request.contextHandoff
  if (request.limitAction === 'fail' || request.limitAction === 'ask' || request.limitAction === 'rotate') settings.limitAction = request.limitAction
  writeSettings(settings)
  return settings
})

ipcMain.handle('profiles:list', () => {
  const home = app.getPath('home')
  const stored = readProfiles(app.getPath('userData'), home)
  const detected = detectDefaultProfiles(home)
  return mergeProfiles(stored, detected)
})

ipcMain.handle('profiles:upsert', (_event, request = {}) => {
  if (!request || typeof request.id !== 'string' || typeof request.provider !== 'string') throw new Error('Profile id and provider are required')
  if (!['codex', 'claude', 'opencode'].includes(request.provider)) throw new Error(`Unknown provider: ${request.provider}`)
  const home = app.getPath('home')
  const profiles = readProfiles(app.getPath('userData'), home)
  const index = profiles.findIndex((profile) => profile.id === request.id)
  const now = Date.now()
  const seed = index >= 0 ? profiles[index] : { id: request.id, provider: request.provider, createdAt: now }
  const candidate = normalizeProfile({
    ...seed,
    name: typeof request.name === 'string' ? request.name : seed.name,
    provider: request.provider,
    configDir: typeof request.configDir === 'string' ? request.configDir : seed.configDir,
    enabled: typeof request.enabled === 'boolean' ? request.enabled : seed.enabled ?? true,
    updatedAt: now,
  }, home)
  if (!candidate) throw new Error('Invalid profile definition')
  if (index >= 0) profiles[index] = candidate
  else profiles.push(candidate)
  writeProfiles(app.getPath('userData'), profiles)
  return candidate
})

ipcMain.handle('profiles:remove', (_event, id) => {
  const profiles = readProfiles(app.getPath('userData'), app.getPath('home'))
  const next = profiles.filter((profile) => profile.id !== id)
  writeProfiles(app.getPath('userData'), next)
  return profiles.length !== next.length
})

ipcMain.handle('profiles:toggle', (_event, request = {}) => {
  const home = app.getPath('home')
  const profiles = readProfiles(app.getPath('userData'), home)
  const target = profiles.find((profile) => profile.id === request.id)
  if (!target) return null
  target.enabled = Boolean(request.enabled)
  target.updatedAt = Date.now()
  writeProfiles(app.getPath('userData'), profiles)
  return target
})

ipcMain.handle('skills:create', async (_event, request = {}) => {
  const workspace = path.resolve(request.workspace || process.cwd())
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error('Workspace does not exist')
  const root = skillRoot(request.scope, workspace, app.getPath('home'))
  fs.mkdirSync(root, { recursive: true })
  const result = await dialog.showSaveDialog({
    title: `Create ${request.scope === 'global' ? 'Global' : 'Project'} Skill`,
    buttonLabel: 'Create',
    defaultPath: path.join(root, 'new-skill.md'),
    filters: [{ name: 'Skill name', extensions: ['md'] }],
    properties: ['showOverwriteConfirmation'],
  })
  if (result.canceled || !result.filePath) return null
  if (!isInside(root, result.filePath)) throw new Error('Skills must be created inside the selected skill scope')
  const name = path.basename(result.filePath, path.extname(result.filePath)).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!name) throw new Error('Enter a valid skill name')
  const skillPath = path.join(root, name, 'SKILL.md')
  if (fs.existsSync(skillPath)) throw new Error(`Skill already exists: ${name}`)
  fs.mkdirSync(path.dirname(skillPath), { recursive: true })
  fs.writeFileSync(skillPath, skillTemplate(name), { encoding: 'utf8', flag: 'wx' })
  const error = await shell.openPath(skillPath)
  if (error) throw new Error(error)
  return skillPath
})

ipcMain.handle('skills:open', async (_event, request = {}) => {
  const workspace = path.resolve(request.workspace || process.cwd())
  const allowed = listSkills(workspace, app.getPath('home'), getCodexHome()).some((skill) => skill.copies.some((copy) => path.resolve(copy.path) === path.resolve(request.path || '')))
  if (!allowed) throw new Error('Skill is outside the active global or project scopes')
  const error = await shell.openPath(path.resolve(request.path))
  if (error) throw new Error(error)
  return true
})

ipcMain.handle('skills:share', async (_event, request = {}) => {
  const workspace = path.resolve(request.workspace || process.cwd())
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error('Workspace does not exist')
  const home = app.getPath('home')
  const skill = listSkills(workspace, home, getCodexHome()).find((item) => item.id === request.id)
  if (!skill) throw new Error('Skill was not found')
  const sourceCopy = skill.copies.find((copy) => path.resolve(copy.path) === path.resolve(request.path || skill.path))
  if (!sourceCopy) throw new Error('Skill source is outside the active scopes')
  const sourceDirectory = path.dirname(sourceCopy.path)
  const sourceHash = hashSkillDirectory(sourceDirectory)
  const samePath = (left, right) => {
    const a = path.resolve(left)
    const b = path.resolve(right)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  }
  const targets = shareTargetPaths({ ...skill, path: sourceCopy.path }, workspace, home).filter((target) => !samePath(target, sourceDirectory))
  const divergent = targets.filter((target) => fs.existsSync(target) && hashSkillDirectory(target) !== sourceHash)
  if (divergent.length) {
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      title: 'Sync skill copies?',
      message: `${skill.name} has ${divergent.length} different ${divergent.length === 1 ? 'copy' : 'copies'}.`,
      detail: `AgentDock will back up and replace:\n${divergent.join('\n')}`,
      buttons: ['Sync and back up', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (confirmation.response !== 0) return { canceled: true, updated: 0, backups: [] }
  }
  const backupRoot = path.join(app.getPath('userData'), 'skill-backups', `${Date.now()}-${crypto.randomUUID()}`)
  const backups = []
  let updated = 0
  for (const target of targets) {
    if (fs.existsSync(target) && hashSkillDirectory(target) === sourceHash) continue
    if (fs.existsSync(target)) {
      const backup = path.join(backupRoot, `${backups.length + 1}-${path.basename(path.dirname(path.dirname(target)))}-${skill.name}`)
      fs.mkdirSync(path.dirname(backup), { recursive: true })
      fs.cpSync(target, backup, { recursive: true, errorOnExist: true })
      backups.push(backup)
    }
    const temporary = path.join(path.dirname(target), `.${skill.name}.agentdock-${crypto.randomUUID()}`)
    fs.mkdirSync(path.dirname(temporary), { recursive: true })
    fs.cpSync(sourceDirectory, temporary, { recursive: true, errorOnExist: true })
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
    fs.renameSync(temporary, target)
    updated += 1
  }
  return { canceled: false, updated, backups }
})

ipcMain.handle('provider:limits', async (_event, request) => {
  const provider = typeof request === 'string' ? request : request?.provider
  const profileId = typeof request === 'string' ? null : request?.profileId
  const profile = profileId ? findProfile(mergeProfiles(readProfiles(app.getPath('userData'), app.getPath('home')), detectDefaultProfiles(app.getPath('home'))), profileId) : null
  const profileEnv = profile ? profileEnvOverlay(profile) : {}
  const env = { ...process.env, ...profileEnv }
  if (provider === 'codex') return getCodexRateLimits(env)
  if (provider === 'claude') return getClaudeRateLimits(env)
  return { available: false, planType: null, limitName: null, primary: null, secondary: null }
})

ipcMain.handle('sessions:list', () => readSessions())

ipcMain.handle('lanes:state', (_event, request = {}) => {
  const sessionId = typeof request === 'string' ? request : request?.sessionId
  if (!sessionId) return {}
  const session = readSessions().find((item) => item.id === sessionId)
  if (!session) return {}
  const provider = typeof request === 'object' && request.provider ? request.provider : session.provider
  const profileId = typeof request === 'object' && request.profileId ? request.profileId : session.profileId || ''
  return getLaneState(session.lanes || {}, provider, profileId)
})

ipcMain.handle('runs:list', (_event, sessionId) => listRuns(app.getPath('userData'), typeof sessionId === 'string' ? sessionId : undefined))

ipcMain.handle('runs:read-artifact', (_event, request = {}) => {
  if (!request?.runId || !request?.path) return null
  return readArtifact(app.getPath('userData'), request.runId, request.path)
})

ipcMain.handle('continuity:prepare', (_event, request = {}) => {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
  if (!sessionId) return null
  const fromProvider = typeof request?.fromProvider === 'string' ? request.fromProvider : ''
  const fromProfileId = typeof request?.fromProfileId === 'string' ? request.fromProfileId : ''
  const toProvider = typeof request?.toProvider === 'string' ? request.toProvider : ''
  const toProfileId = typeof request?.toProfileId === 'string' ? request.toProfileId : ''
  if (!fromProvider || !toProvider) return null
  const fromLane = laneLabel(fromProvider, fromProfileId)
  const toLane = laneLabel(toProvider, toProfileId)
  if (fromLane === toLane) return null
  const userData = app.getPath('userData')
  const checkpoint = readCheckpoint(userData, sessionId, fromProvider, fromProfileId)
  const messages = Array.isArray(request?.messages) ? request.messages : []
  const threadContent = buildThreadFromMessages(messages, sessionId)
  const threadFilePath = writeThread(userData, sessionId, threadContent)
  if (!threadFilePath) return null
  const packet = buildContinuationPacket({
    fromLane, toLane, checkpoint, threadPath: threadFilePath,
    deltaSummary: '', sessionId,
  })
  const packetPath = path.join(path.dirname(threadFilePath), `continuation-${Date.now()}.md`)
  try { fs.writeFileSync(packetPath, packet, 'utf8') } catch { return null }
  return { packetPath, threadFilePath, event: continuityEventPayload(fromLane, toLane, threadFilePath, 'lane_switch') }
})

ipcMain.handle('continuity:checkpoint', (_event, request = {}) => {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
  if (!sessionId) return false
  const provider = typeof request?.provider === 'string' ? request.provider : ''
  const profileId = typeof request?.profileId === 'string' ? request.profileId : ''
  const content = typeof request?.content === 'string' ? request.content : ''
  if (!provider || !content) return false
  writeCheckpoint(app.getPath('userData'), sessionId, provider, profileId, content)
  return true
})

ipcMain.handle('sessions:create', (_event, request = {}) => {
  const workspace = path.resolve(request.workspace || app.getPath('home'))
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error('Workspace does not exist')
  const now = Date.now()
  const session = normalizeSession({
    ...request,
    id: crypto.randomUUID(),
    workspace,
    title: request.title || 'New session',
    createdAt: now,
    updatedAt: now,
  })
  const sessions = [session, ...readSessions()]
  writeSessions(sessions)
  return session
})

ipcMain.handle('sessions:update', (_event, request) => {
  const sessions = readSessions()
  const index = sessions.findIndex((session) => session.id === request?.id)
  if (index < 0) throw new Error('Session was not found')
  const updated = normalizeSession({
    ...sessions[index],
    ...request,
    id: sessions[index].id,
    workspace: sessions[index].workspace,
    createdAt: sessions[index].createdAt,
    updatedAt: Date.now(),
  })
  sessions[index] = updated
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  writeSessions(sessions)
  return updated
})

ipcMain.handle('workspace:choose', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('attachments:choose', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('attachments:choose-workspace', async (_event, workspace) => {
  const result = await dialog.showOpenDialog({
    defaultPath: workspace,
    properties: ['openFile', 'openDirectory', 'multiSelections'],
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('git:info', async (_event, workspace) => {
  const cwd = path.resolve(workspace || process.cwd())
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return { isRepo: false, currentBranch: '', branches: [] }
  }
  const run = async (args, defaultValue = '') => {
    const { ok, stdout, stderr } = await execCapture('git', args, { cwd })
    return ok ? stripAnsi(stdout).trim() : defaultValue
  }
  const gitDir = await run(['rev-parse', '--git-dir'])
  if (!gitDir) return { isRepo: false, currentBranch: '', branches: [] }
  const currentBranch = await run(['branch', '--show-current'], 'HEAD')
  const rawBranches = stripAnsi(await run(['branch', '-a']))
  const branches = rawBranches
    .split(/\r?\n/)
    .map((line) => line.replace(/^\*?\s+/, '').replace(/^remotes\//, ''))
    .filter((line) => line && !line.includes(' -> ') && !line.startsWith('HEAD'))
  return { isRepo: true, currentBranch, branches: [...new Set(branches)] }
})

ipcMain.handle('git:checkout', async (_event, { workspace, branch }) => {
  const cwd = path.resolve(workspace || process.cwd())
  const { ok } = await execCapture('git', ['checkout', branch], { cwd })
  return ok
})

ipcMain.handle('git:create-branch', async (_event, { workspace, branch }) => {
  const cwd = path.resolve(workspace || process.cwd())
  const { ok } = await execCapture('git', ['checkout', '-b', branch], { cwd })
  return ok
})

ipcMain.handle('provider:configure', async (_event, provider) => {
  const targets = {
    codex: path.join(app.getPath('home'), '.codex', 'config.toml'),
    claude: path.join(app.getPath('home'), '.claude'),
    opencode: path.join(app.getPath('home'), '.config', 'opencode'),
  }
  const target = targets[provider]
  if (!target) throw new Error(`Unknown provider: ${provider}`)
  const existing = fs.existsSync(target) ? target : path.dirname(target)
  const error = await shell.openPath(existing)
  if (error) throw new Error(error)
  return true
})

function extractRunSummary(provider, raw) {
  const answers = []
  for (const line of String(raw || '').split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line)
      if (provider === 'codex') {
        const item = event.item || {}
        if (item.type === 'agent_message' && item.text) answers.push(item.text)
        if (event.type === 'message' && event.message?.content) answers.push(event.message.content)
      } else if (provider === 'claude') {
        const content = event.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) answers.push(block.text)
          }
        }
        if (event.type === 'result' && event.result) answers.push(event.result)
      } else {
        const part = event.part || event
        if (part.type === 'text' && part.text) answers.push(part.text)
        if (!part.type && (event.text || event.content)) answers.push(event.text || event.content)
      }
    } catch {}
  }
  return answers.length ? answers[answers.length - 1].trim().slice(0, 5000) : ''
}

ipcMain.handle('agent:run', async (event, request) => {
  const adapter = adapters[request.provider]
  if (!adapter) throw new Error(`Unknown provider: ${request.provider}`)
  const workspace = path.resolve(request.workspace || process.cwd())
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error('Workspace does not exist')
  const mode = request.mode === 'resume' || request.mode === 'restart' || request.mode === 'retry' ? request.mode : 'run'
  const changesBeforeRun = await readWorkspaceChanges(workspace)
  const availableSkills = listSkills(workspace, app.getPath('home'), getCodexHome())

  const home = app.getPath('home')
  const userData = app.getPath('userData')
  const profiles = mergeProfiles(readProfiles(userData, home), detectDefaultProfiles(home))
  const profile = findProfile(profiles, request.profileId)
  if (request.profileId && !profile) throw new Error('Selected credential profile is not available')
  const profileEnv = profile ? profileEnvOverlay(profile) : {}

  const sessionId = request.sessionId || ''
  const profileRef = profile ? profile.id : ''
  // Keep AgentDock's lane data durable without replacing the CLI's native home.
  // HOME/USERPROFILE also contain provider credentials and configuration. Pointing
  // them at a newly-created lane made the default account appear logged out (most
  // visibly OpenCode, whose auth.json lives below ~/.local/share/opencode).
  if (sessionId) ensureLaneDir(userData, sessionId, request.provider, profileRef)

  const permissions = permissionLaunchOptions(request.provider, request.permissionMode, { ...process.env, ...profileEnv })
  const descriptor = browserMcpReady ? browserMcp.descriptor() : null
  const runId = crypto.randomUUID()
  let browserOptions
  const baseRequest = { ...request, workspace, permissionArgs: permissions.args }
  let child

  if (mode === 'resume') {
    browserOptions = browserMcpLaunchOptions(request.provider, descriptor, runId, permissions.env)
    const mergedEnv = { ...permissions.env, ...browserOptions.env, ...profileEnv, NO_COLOR: '1', FORCE_COLOR: '0' }
    const resumePermissionArgs = request.provider === 'codex' ? browserOptions.args : [...permissions.args, ...browserOptions.args]
    const resumeLastPrompt = withBrowserAwarenessPrompt(request.lastPrompt || request.prompt || 'Continue from where we left off.')
    const resumeRequest = {
      ...baseRequest,
      cliSessionId: request.cliSessionId,
      lastPrompt: resumeLastPrompt,
      attachments: request.attachments || [],
      permissionArgs: resumePermissionArgs,
      permissionMode: request.permissionMode,
    }
    child = spawn(adapter.executable, adapter.buildResumeArgs(resumeRequest), {
      cwd: workspace,
      env: mergedEnv,
      windowsHide: true,
      shell: false,
    })
  } else {
    const basePrompt = globalSkillPrompt(request.prompt, availableSkills, readSettings().defaultGlobalSkills)
    const prompt = withBrowserAwarenessPrompt(basePrompt)
    browserOptions = browserMcpLaunchOptions(request.provider, descriptor, runId, permissions.env)
    const mergedEnv = { ...permissions.env, ...browserOptions.env, ...profileEnv, NO_COLOR: '1', FORCE_COLOR: '0' }
    const mergedArgs = [...permissions.args, ...browserOptions.args]
    child = spawn(adapter.executable, adapter.buildArgs({ ...baseRequest, prompt, permissionArgs: mergedArgs }), {
      cwd: workspace,
      env: mergedEnv,
      windowsHide: true,
      shell: false,
    })
  }
  child.stdin.end()
  running.set(runId, { child, cleanup: browserOptions.cleanup })
  ensureRunDir(userData, runId)
  const startedAt = Date.now()
  let rawOutput = ''

  const emit = (type, data = '') => {
    if (!event.sender.isDestroyed()) event.sender.send('agent:event', { runId, type, data })
  }
  const appendArtifact = (type, data) => {
    rawOutput += data
    appendEvents(userData, runId, JSON.stringify({ ts: Date.now(), type, data }))
  }
  child.stdout.on('data', (chunk) => { const text = chunk.toString(); emit('stdout', text); appendArtifact('stdout', text) })
  child.stderr.on('data', (chunk) => { const text = chunk.toString(); emit('stderr', text); appendArtifact('stderr', text) })
  child.on('error', (error) => { emit('error', error.message); appendArtifact('error', error.message) })
  child.on('close', async (code) => {
    running.delete(runId)
    try { await browserOptions.cleanup() } catch {}
    const changes = workspaceChangeDelta(changesBeforeRun, await readWorkspaceChanges(workspace, true))
    if (changes.length) {
      emit('stdout', `\n${JSON.stringify({ type: 'agentdock.file_changes', changes })}\n`)
      appendArtifact('stdout', `\n${JSON.stringify({ type: 'agentdock.file_changes', changes })}\n`)
    }
    writePatch(userData, runId, buildDiffFromChanges(changes))
    const summary = extractRunSummary(request.provider, rawOutput)
    if (summary) writeSummary(userData, runId, summary)
    const exitCode = Number.isFinite(code) ? code : -1
    const outcome = exitCode === 0 ? 'success' : 'blocked'
    writeReceipt(userData, runId, normalizeReceipt({
      runId, sessionId, provider: request.provider, profileId: profileRef, mode,
      prompt: request.prompt || request.lastPrompt || '',
      exitCode, outcome,
      filesChanged: changes.map((c) => ({ path: c.path, additions: c.additions, deletions: c.deletions })),
      startedAt, finishedAt: Date.now(),
    }))
    const outcomeEvent = JSON.stringify({ type: 'agentdock.run.outcome', runId, outcome, exitCode, provider: request.provider, profileId: profileRef })
    emit('stdout', `\n${outcomeEvent}\n`)
    appendArtifact('stdout', `\n${outcomeEvent}\n`)
    emit('exit', String(exitCode))
    if (sessionId) {
      try {
        const sessions = readSessions()
        const session = sessions.find((item) => item.id === sessionId)
        if (session) {
          const updatedLanes = setLaneState(session.lanes || {}, request.provider, profileRef, {
            lastExitCode: exitCode,
            lastRunFailed: exitCode !== 0,
          })
          writeSessions(sessions.map((item) => item.id === sessionId ? { ...item, lanes: updatedLanes, updatedAt: Date.now() } : item))
        }
      } catch {}
    }
    if (exitCode !== 0 && profile && readSettings().limitAction === 'rotate') {
      try {
        const providerLimits = request.provider === 'codex' ? await getCodexRateLimits({ ...process.env, ...profileEnv }) : request.provider === 'claude' ? await getClaudeRateLimits({ ...process.env, ...profileEnv }) : null
        if (providerLimits && isProfileExhausted(providerLimits)) {
          const allProfiles = mergeProfiles(readProfiles(app.getPath('userData'), app.getPath('home')), detectDefaultProfiles(app.getPath('home')))
          const candidate = nextReadyProfile(allProfiles, request.provider, profile.id)
          if (candidate) emit('stdout', `\n${JSON.stringify({ type: 'agentdock.profile_rotated', from: profile.id, to: candidate.id, reason: 'quota_exhausted' })}\n`)
        }
      } catch {}
    }
  })
  return { runId }
})

const killProcessTree = (child) => {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true })
    } catch {}
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try { child.kill('SIGKILL') } catch {}
    }
  }
}

ipcMain.handle('agent:stop', async (_event, runId) => {
  const entry = running.get(runId)
  if (!entry) return false
  killProcessTree(entry.child)
  running.delete(runId)
  try { if (entry.cleanup) await entry.cleanup() } catch {}
  return true
})

app.whenReady().then(async () => {
  createWindow()
  try {
    await browserMcp.start()
    browserMcpReady = true
  } catch (error) {
    console.error('[agentdock] Failed to start browser MCP:', error && error.message ? error.message : error)
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (event) => {
  if (browserMcpReady || browserManager.isVisible()) {
    event.preventDefault()
    try { browserAutomation.detach() } catch {}
    try { await browserManager.destroy() } catch {}
    try { await browserMcp.stop() } catch {}
    browserMcpReady = false
    app.quit()
  }
})
