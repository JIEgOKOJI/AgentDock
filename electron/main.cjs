const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { spawn, execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { globalSkillPrompt, hashSkillDirectory, isInside, listSkills, shareTargetPaths, skillRoot, skillTemplate } = require('./skills.cjs')
const { normalizePermissionMode, permissionLaunchOptions, readOnlyPermissionOptions, isReadOnlyIntent, effectivePermissionOptions } = require('./permissions.cjs')
const { adapters } = require('./adapters.cjs')
const { createBrowserManager } = require('./browser-manager.cjs')
const { createBrowserAutomation } = require('./browser-automation.cjs')
const { createBrowserMcp, SERVER_NAME: BROWSER_MCP_NAME } = require('./browser-mcp.cjs')
const { browserMcpLaunchOptions, withBrowserAwarenessPrompt } = require('./browser-mcp-config.cjs')
const { createDelegateMcp, SERVER_NAME: DELEGATE_MCP_NAME } = require('./delegate-mcp.cjs')
const { normalizeDelegateConfig, buildPolicy, combinedMcpLaunchOptions, withDelegateAwarenessPrompt } = require('./delegate-mcp-config.cjs')
const { injectMcpServers } = require('./mcp-injection.cjs')
const { normalizeBounds } = require('./browser-url.cjs')
const mcp = require('./mcp-manager.cjs')
const { ORCHESTRATOR_VERSION, generateRunId, prepareEnvelope, executeAttempt, captureChanges, verifyGates, verifyBaseCompatible, adoptPatch, computeOutcome, cleanupEnvelope, runWithRepairLoop, workspaceChangeDelta: orchestratorDelta } = require('./run-orchestrator.cjs')

const running = new Map()
const activeContextInvocations = new Map()
const SESSION_STORE_VERSION = 1
const SETTINGS_STORE_VERSION = 3
const getCodexHome = () => process.env.CODEX_HOME || path.join(app.getPath('home'), '.codex')
const { readProfiles, writeProfiles, normalizeProfile, profileEnvOverlay, findProfile, readyProfilesForProvider, isProfileExhausted, isTypedVendorLimitSignal, isProfileReady, nextReadyProfile, nextReadyProfileByLimits, detectDefaultProfiles, mergeProfiles } = require('./profiles.cjs')
const { ensureLaneDir, normalizeLanes, getLaneState, setLaneState, migrateLegacySession } = require('./lanes.cjs')
const { ensureRunDir, appendEvents, writePatch, writeSummary, writePlanArtifact, writeTelemetry, writeReceipt, readReceipt, listRuns, readArtifact, readArtifactByManifest, listArtifacts, writeManifest, readManifest, verifyManifestHashes, recoverEventsJsonl, startupRecovery, buildDiffFromChanges, normalizeReceipt, workspaceFingerprint, atomicWrite } = require('./artifacts.cjs')
const { writeCheckpoint, readCheckpoint, writeThread, readThread, buildContinuationPacket, continuityEventPayload, laneLabel, buildThreadFromMessages, readDeliveredId, writeDeliveredId } = require('./continuity.cjs')
const { planPrefix, parseOpenQuestions, classifyPlanReadiness, writePlanContract, readPlanContract, verifyPlanHash, contentHash, verifyPlanContentHash, normalizeOpenQuestions } = require('./plan.cjs')
const { normalizeGatesConfig, checkProtectedPaths, runGateCommand, writeGateResult, evaluateGates } = require('./gates.cjs')
const { normalizeRepairConfig, buildRepairPrompt, detectStall, shouldContinue, writeAttemptLog, repairEventPayload, MAX_ATTEMPTS, stallFingerprint, writeAttemptArtifact } = require('./repair.cjs')
const { estimateRunCost, normalizeBudget, checkBudget, hasBudgetHeadroom, appendSpendEntry, sessionSpend, readSpendLedger, readAllSpendLedgers, totalSpend, reserveBudget, releaseReservation, settleReservation, totalReserved, clearReservations, pricingSnapshot } = require('./budget.cjs')
const { createWorktree, captureWorktreeDiff, applyPatch, removeWorktree, isGitRepo, getBaseTreeHash, createNonGitEnvelope } = require('./worktree.cjs')
const { createContextItem, createContextInvocation, reconcileInvocation, aggregateSessionSummary, buildLegacySummary, buildEmptySummary, contextSnapshot, COMPONENT_CATEGORIES } = require('./context-usage.cjs')
const { normalizeRaceConfig, writeCandidateArtifact, normalizeCandidate, scoreCandidate, arbitrate, buildReviewPrompt, parseReviewResponse, writeArbitrationResult, writeReviewArtifact, raceEventPayload, selectProvidersForRace, selectReviewersForCandidate, ensureRaceDir, providerFamily, distinctReviewFamilies } = require('./race.cjs')
const { normalizeCouncilConfig, writeDraft, readDraft, listDrafts, buildMergePrompt, councilEventPayload, ensureCouncilDir, contentHash: councilContentHash, mergeOpenQuestions, selectCouncilProviders } = require('./council.cjs')

const DEFAULT_SETTINGS = { defaultGlobalSkills: [], contextHandoff: true, limitAction: 'fail', pipelineTemplates: {} }

// Pipeline role templates the user may override; custom has no default template.
const PIPELINE_TEMPLATE_ROLES = ['formulate', 'plan', 'review', 'implement', 'verify']

function sanitizePipelineTemplates(value) {
  const result = {}
  if (value && typeof value === 'object') {
    for (const role of PIPELINE_TEMPLATE_ROLES) {
      if (typeof value[role] === 'string' && value[role].trim()) result[role] = value[role]
    }
  }
  return result
}

const browserManager = createBrowserManager()
const browserAutomation = createBrowserAutomation(browserManager)
const browserMcp = createBrowserMcp(browserManager, browserAutomation)
let browserMcpReady = false
let mainWindow = null

function contextManifestPath(userData, runId) {
  return path.join(runDir(userData, runId), 'context.json')
}

function writeContextManifest(userData, runId, invocation) {
  if (!invocation) return
  try {
    atomicWrite(contextManifestPath(userData, runId), JSON.stringify({ version: 1, ...contextSnapshot(invocation) }, null, 2))
  } catch {}
}

function readContextManifest(userData, runId) {
  try {
    return JSON.parse(fs.readFileSync(contextManifestPath(userData, runId), 'utf8'))
  } catch {
    return null
  }
}

function normalizeTokenUsage(value) {
  return normalizeTokenUsageShared(value, { legacy: true })
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
      pipelineTemplates: sanitizePipelineTemplates(store.pipelineTemplates),
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

const { extractTokenUsage: extractTokenUsageShared, addTokenUsage: addTokenUsageShared, normalizeTokenUsage: normalizeTokenUsageShared, emptyTokenUsage: emptyTokenUsageShared, fallbackContextWindow } = require('./token-usage.cjs')
const { normalizeUsageRecord } = require('./token-usage-stats.cjs')

const fallbackModels = {
  codex: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoning: 'low', contextWindow: fallbackContextWindow('codex', 'gpt-5.6-sol') || undefined, contextWindowSource: 'fallback' }],
  claude: [
    { id: 'sonnet', label: 'Sonnet (latest)', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoning: 'high', contextWindow: fallbackContextWindow('claude', 'sonnet') || undefined, contextWindowSource: 'fallback' },
    { id: 'opus', label: 'Opus (latest)', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoning: 'high', contextWindow: fallbackContextWindow('claude', 'opus') || undefined, contextWindowSource: 'fallback' },
    { id: 'haiku', label: 'Haiku (latest)', reasoning: ['low', 'medium', 'high'], defaultReasoning: 'medium', contextWindow: fallbackContextWindow('claude', 'haiku') || undefined, contextWindowSource: 'fallback' },
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
            finish(message.result.data.map((item) => {
              // Prefer context limit from model/list metadata when exposed; fall
              // back to the vetted per-model table otherwise. Source is tracked
              // so the runtime event can still supersede this at display time.
              const metaWindow = Number(item.contextWindow ?? item.context_window ?? item.maxContextTokens ?? item.max_context_tokens)
              const hasMeta = Number.isFinite(metaWindow) && metaWindow > 0
              const fallback = fallbackContextWindow('codex', item.model)
              const contextWindow = hasMeta ? metaWindow : (fallback || undefined)
              const contextWindowSource = hasMeta ? 'model-meta' : (fallback ? 'fallback' : 'unknown')
              return {
                id: item.model,
                label: item.displayName || item.model,
                description: item.description || '',
                contextWindow,
                contextWindowSource,
                reasoning: item.supportedReasoningEfforts?.map((effort) => effort.reasoningEffort) || [],
                defaultReasoning: item.defaultReasoningEffort || '',
              }
            }))
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
      const contextWindow = Number(metadata.limit?.context) || undefined
      metadataById.set(id, {
        id,
        label: metadata.name || id,
        description: metadata.family || '',
        contextWindow,
        contextWindowSource: contextWindow ? 'model-meta' : 'unknown',
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
    return available.map((id) => {
      const fallback = fallbackContextWindow('claude', id)
      return {
        id,
        label: labels.get(id) || id.replace(/^./, (letter) => letter.toUpperCase()),
        // Claude CLI does not expose context windows per alias; use the vetted
        // per-model fallback. A runtime modelUsage.contextWindow event, when
        // available, supersedes this at display time.
        contextWindow: fallback || undefined,
        contextWindowSource: fallback ? 'fallback' : 'unknown',
        reasoning: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoning: 'high',
      }
    })
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
  const add = (name, provider, enabled = true, detail = '', builtin = false) => {
    if (!name) return
    const current = servers.get(name) || { name, providers: [], enabled: false, detail: '', builtin }
    if (!current.providers.includes(provider)) current.providers.push(provider)
    current.enabled ||= enabled
    current.detail ||= detail
    current.builtin ||= builtin
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
  const browserDetail = browserMcpReady ? 'Embedded browser MCP — injected into every agent run' : 'Embedded browser MCP — starting up'
  add(BROWSER_MCP_NAME, 'codex', browserMcpReady, browserDetail, true)
  add(BROWSER_MCP_NAME, 'claude', browserMcpReady, browserDetail, true)
  add(BROWSER_MCP_NAME, 'opencode', browserMcpReady, browserDetail, true)
  // Delegation Belt (#12) — injected on demand when a run opts into delegation.
  // Not being active at idle is normal, so the UI shows it as "on-demand", not unavailable.
  const delegateReady = delegateServers.size > 0
  const delegateDetail = delegateReady
    ? 'Delegation belt MCP — active in the current run'
    : 'Delegation belt MCP — injected when “Allow delegation” is enabled in the Orchestration panel'
  add(DELEGATE_MCP_NAME, 'codex', delegateReady, delegateDetail, true)
  add(DELEGATE_MCP_NAME, 'claude', delegateReady, delegateDetail, true)
  add(DELEGATE_MCP_NAME, 'opencode', delegateReady, delegateDetail, true)
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
  if (request.pipelineTemplates && typeof request.pipelineTemplates === 'object') settings.pipelineTemplates = sanitizePipelineTemplates(request.pipelineTemplates)
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

ipcMain.handle('usage:stats', () => {
  const userData = app.getPath('userData')
  const home = app.getPath('home')
  const profiles = mergeProfiles(readProfiles(userData, home), detectDefaultProfiles(home))
  const entries = readAllSpendLedgers(userData)
  const records = entries.map(normalizeUsageRecord).filter(Boolean)
  const profileLabels = Object.fromEntries(profiles.map((p) => [p.id, p.name]))
  return { records, profileLabels }
})

ipcMain.handle('context:summary', (_event, sessionId) => {
  if (typeof sessionId !== 'string' || !sessionId) return buildEmptySummary()
  const userData = app.getPath('userData')
  const runs = listRuns(userData, sessionId)
  const manifests = []
  for (const receipt of runs) {
    const manifest = readContextManifest(userData, receipt.runId)
    if (manifest) manifests.push(manifest)
  }
  // Active runs that have not finished yet contribute an in-memory snapshot.
  for (const invocation of activeContextInvocations.values()) {
    if (invocation.sessionId === sessionId) manifests.push(contextSnapshot(invocation))
  }
  if (!manifests.length) {
    const session = readSessions().find((s) => s.id === sessionId)
    if (session) return buildLegacySummary(session.messages, session.provider, session.model)
    return buildEmptySummary()
  }
  const originalMessages = []
  const session = readSessions().find((s) => s.id === sessionId)
  if (session) {
    originalMessages.push(...session.messages.filter((m) => m.role === 'user' && m.id !== 'hello').map((m) => m.content))
  }
  return aggregateSessionSummary(manifests, originalMessages)
})

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

ipcMain.handle('runs:list-artifacts', (_event, request = {}) => {
  if (!request?.runId) return []
  return listArtifacts(app.getPath('userData'), request.runId)
})

ipcMain.handle('runs:manifest', (_event, request = {}) => {
  if (!request?.runId) return null
  return readManifest(app.getPath('userData'), request.runId)
})

ipcMain.handle('runs:verify-manifest', (_event, request = {}) => {
  if (!request?.runId) return { ok: false, reason: 'no_runId' }
  return verifyManifestHashes(app.getPath('userData'), request.runId)
})

// Delegation Belt (#12): read-only status/result IPC for the UI. Sub-runs are
// spawned by the agent via the agentdock-delegate MCP server; the UI polls these
// to surface delegation activity in the Artifacts tab.
ipcMain.handle('delegate:status', (_event, request = {}) => {
  const subRunId = request?.subRunId
  if (!subRunId) return null
  const record = delegateRuns.get(subRunId)
  if (!record) return null
  return { state: record.status, kind: record.kind, provider: record.provider, startedAt: record.startedAt, finishedAt: record.finishedAt }
})

ipcMain.handle('delegate:result', (_event, request = {}) => {
  const subRunId = request?.subRunId
  if (!subRunId) return null
  const record = delegateRuns.get(subRunId)
  if (!record || record.status === 'running') return null
  return record.result || null
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
  // 6.5: Track last delivered message id per target lane
  const delivered = readDeliveredId(userData, sessionId, toProvider, toProfileId)
  const lastDeliveredId = delivered?.lastMessageId || null
  const threadContent = buildThreadFromMessages(messages, sessionId)
  const threadFilePath = writeThread(userData, sessionId, threadContent)
  if (!threadFilePath) return null
  const packet = buildContinuationPacket({
    fromLane, toLane, checkpoint, threadPath: threadFilePath,
    deltaSummary: '', sessionId, messages, lastDeliveredId,
  })
  const packetPath = path.join(path.dirname(threadFilePath), `continuation-${Date.now()}.md`)
  try { fs.writeFileSync(packetPath, packet, 'utf8') } catch { return null }
  // 6.5: Update delivered id after packet is written
  const lastMessage = messages.length ? messages[messages.length - 1] : null
  if (lastMessage?.id) writeDeliveredId(userData, sessionId, toProvider, toProfileId, { lastMessageId: lastMessage.id, ts: Date.now() })
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

ipcMain.handle('plan:read', (_event, request = {}) => {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
  if (!sessionId) return null
  const contract = readPlanContract(app.getPath('userData'), sessionId)
  if (!contract) return null
  const openQuestions = parseOpenQuestions(contract.content)
  const answersMatch = contract.raw.match(/## Provided Answers\n\n([\s\S]*?)(?:\n\n|$)/)
  if (answersMatch) {
    for (const line of answersMatch[1].split(/\r?\n/)) {
      const lineMatch = line.match(/^-\s+\*\*(.+?)\*\*:\s*(.*)$/)
      if (!lineMatch) continue
      const question = openQuestions.find((q) => q.text === lineMatch[1])
      if (question) question.value = lineMatch[2]
    }
  }
  const readiness = classifyPlanReadiness(contract.content, openQuestions)
  return { ...contract, openQuestions, readiness }
})

ipcMain.handle('plan:verify-hash', (_event, request = {}) => {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
  const hash = typeof request?.hash === 'string' ? request.hash : ''
  if (!sessionId || !hash) return false
  return verifyPlanHash(app.getPath('userData'), sessionId, hash)
})

ipcMain.handle('plan:adopt', (_event, request = {}) => {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
  if (!sessionId) return null
  const planText = typeof request?.planText === 'string' ? request.planText : ''
  const answers = Array.isArray(request?.answers) ? request.answers.filter((a) => a && typeof a.text === 'string') : []
  if (!planText) return null
  const result = writePlanContract(app.getPath('userData'), sessionId, planText, answers)
  if (!result) return null
  return { hash: result.hash, path: result.path, readiness: classifyPlanReadiness(planText, parseOpenQuestions(planText)) }
})

// 7.3: Approval inbox / manual candidate adoption — reuses the same safe
// adopt pipeline as isolated runs (base-hash check, git apply --check).
ipcMain.handle('runs:adopt-patch', async (_event, request = {}) => {
  const runId = typeof request?.runId === 'string' ? request.runId : ''
  const patch = typeof request?.patch === 'string' ? request.patch : ''
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
  const baseTreeHash = typeof request?.baseTreeHash === 'string' ? request.baseTreeHash : null
  if (!runId || !patch || !sessionId) return { ok: false, error: 'missing_fields' }
  const session = readSessions().find((item) => item.id === sessionId)
  if (!session) return { ok: false, error: 'session_not_found' }
  const workspace = path.resolve(session.workspace)
  const userData = app.getPath('userData')
  const result = await adoptPatch({ workspace, patch, baseTreeHash, emit: null, appendArtifact: null, runId })
  if (result.ok) {
    const receipt = readReceipt(userData, runId)
    if (receipt) {
      writeReceipt(userData, runId, normalizeReceipt({
        ...receipt,
        outcome: 'success',
        warnings: (receipt.warnings || []).filter((w) => !/needs.human|needs.approval/i.test(w)),
      }))
    }
  }
  return result
})

ipcMain.handle('runs:reject-approval', (_event, request = {}) => {
  const runId = typeof request?.runId === 'string' ? request.runId : ''
  if (!runId) return { ok: false, error: 'missing_runId' }
  const userData = app.getPath('userData')
  const receipt = readReceipt(userData, runId)
  if (!receipt) return { ok: false, error: 'receipt_not_found' }
  writeReceipt(userData, runId, normalizeReceipt({
    ...receipt,
    outcome: 'blocked',
    warnings: [...(receipt.warnings || []), 'Rejected by user — patch not adopted'],
  }))
  return { ok: true }
})

ipcMain.handle('budget:spend', (_event, request = {}) => {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
  if (!sessionId) return { total: 0, entries: [] }
  const entries = readSpendLedger(app.getPath('userData'), sessionId)
  return { total: totalSpend(entries), entries: entries.slice(-50) }
})

ipcMain.handle('context:snapshot', (_event, runId) => {
  if (typeof runId !== 'string' || !runId) return null
  const invocation = activeContextInvocations.get(runId)
  if (invocation) return contextSnapshot(invocation)
  const manifest = readContextManifest(app.getPath('userData'), runId)
  return manifest || null
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

ipcMain.handle('sessions:delete', (_event, sessionId) => {
  if (typeof sessionId !== 'string' || !sessionId) return false
  const sessions = readSessions()
  const remaining = sessions.filter((session) => session.id !== sessionId)
  if (remaining.length === sessions.length) return false
  writeSessions(remaining)
  return true
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

// Token-usage extraction is delegated to the shared module (token-usage.cjs) so
// the renderer and main process share one parser. The local wrapper preserves
// the (provider, raw) signature used by telemetry/cost call sites and forwards
// the model id when known so the context-window fallback table can apply.
function extractTokenUsage(provider, raw, model) {
  return extractTokenUsageShared(provider, raw, { model: model || '' })
}

function normalizeContextComponent(component) {
  if (!component || typeof component !== 'object') return null
  return createContextItem({
    category: typeof component.category === 'string' ? component.category : 'unknown',
    source: typeof component.source === 'string' ? component.source : 'unknown',
    text: typeof component.text === 'string' ? component.text : '',
    status: ['reported', 'estimated', 'unknown'].includes(component.status) ? component.status : undefined,
    tokens: Number.isFinite(component.tokens) ? component.tokens : null,
  })
}

function addUnknownSystemState(invocation, note) {
  invocation.components.push(createContextItem({
    category: COMPONENT_CATEGORIES.providerSystemState,
    source: 'provider-cli',
    runId: invocation.runId,
    agent: invocation.agent,
    text: note || 'Provider-internal system instructions and CLI state are not visible to AgentDock.',
    status: 'unknown',
  }))
  return invocation
}

// Delegation Belt (#12): per-run registry of sub-runs spawned by the agent via
// the agentdock-delegate MCP server. Sub-runs are scoped to their parent run:
// they cannot apply patches, approve gates, rotate profiles, or change settings.
// Each sub-run reuses the artifacts infra (own runId) and attributes spend to the
// parent session. Nesting depth is capped to 1 — sub-runs cannot delegate.
const delegateRuns = new Map()
const delegateServers = new Map()

function delegateRunRecord(runId, kind, parentId, sessionId, provider, profileId, status, result) {
  return {
    runId,
    kind,
    parentId,
    sessionId,
    provider,
    profileId,
    status,
    result,
    startedAt: Date.now(),
    finishedAt: null,
  }
}

// Sub-run runner for the Delegation Belt (#12). Spawned by the agent via the
// agentdock-delegate MCP server. Reuses the same adapters/artifacts infra as a
// top-level run but is scoped: ask/plan are read-only, agent runs inside an
// isolated worktree, race reuses the race pipeline without autoAdopt. Sub-runs
// do NOT inject the delegate MCP (nesting depth capped to 1) — they keep the
// browser MCP only. Spend is attributed to the parent session for budget
// enforcement.
//
// 6.4: spawnSubRun returns subRunId immediately; execution continues async.
// Status/result recoverable from artifacts after restart.
async function runDelegateSubRun({ kind, params, parentRunId, sessionId, parentProvider, parentProfileId, workspace, userData, home, availableSkills, emit, policy }) {
  const provider = params.provider || parentProvider
  const adapter = adapters[provider]
  if (!adapter) return { subRunId: null, ok: false, error: `Unknown provider: ${provider}` }
  // 6.4: Restrict provider/profile to parent policy
  if (policy?.allowedProviders?.length && !policy.allowedProviders.includes(provider)) {
    return { subRunId: null, ok: false, error: `Provider ${provider} not allowed by parent policy` }
  }
  const profiles = mergeProfiles(readProfiles(userData, home), detectDefaultProfiles(home))
  const profile = findProfile(profiles, params.profileId || parentProfileId) || null
  // 6.4: Enforced read-only for ask/plan
  const intent = kind === 'ask' ? 'ask' : kind === 'plan' ? 'plan' : 'agent'
  const permissionMode = isReadOnlyIntent(intent) ? 'ask' : (params.permissionMode || 'auto')
  const permissions = permissionLaunchOptions(provider, permissionMode, { ...process.env, ...(profile ? profileEnvOverlay(profile) : {}) })
  const browserDescriptor = browserMcpReady ? browserMcp.descriptor() : null
  const subRunId = crypto.randomUUID()
  // 6.4: Register immediately as 'queued' and return subRunId
  delegateRuns.set(subRunId, delegateRunRecord(subRunId, kind, parentRunId, sessionId, provider, profile ? profile.id : '', 'queued', null))
  ensureRunDir(userData, subRunId)
  if (emit) emit('delegate.subrun_started', { parentRunId, subRunId, kind, provider, intent })
  // 6.4: Execute asynchronously — do not await
  executeDelegateSubRun({ kind, params, parentRunId, sessionId, provider, profile, subRunId, permissions, browserDescriptor, workspace, userData, home, availableSkills, emit, intent })
  return { subRunId, ok: true, status: 'queued' }
}

async function executeDelegateSubRun({ kind, params, parentRunId, sessionId, provider, profile, subRunId, permissions, browserDescriptor, workspace, userData, home, availableSkills, emit, intent }) {
  const adapter = adapters[provider]
  const profileEnv = profile ? profileEnvOverlay(profile) : {}
  const browserOptions = browserMcpLaunchOptions(provider, browserDescriptor, subRunId, permissions.env)
  const mergedEnv = { ...permissions.env, ...browserOptions.env, ...profileEnv, NO_COLOR: '1', FORCE_COLOR: '0' }
  const mergedArgs = [...permissions.args, ...browserOptions.args]
  let worktreeInfo = null
  if (kind === 'agent') {
    // 6.4: Fail-closed — worktree error does NOT fall back to live workspace
    try {
      worktreeInfo = await createWorktree(userData, sessionId || 'delegate', subRunId, workspace)
    } catch (error) {
      worktreeInfo = { ok: false, error: error.message, path: null }
    }
    if (!worktreeInfo.ok) {
      const record = delegateRuns.get(subRunId)
      if (record) { record.status = 'failed'; record.finishedAt = Date.now(); record.result = { outcome: 'blocked', error: `Worktree failed: ${worktreeInfo.error}` } }
      writeReceipt(userData, subRunId, normalizeReceipt({ runId: subRunId, sessionId, provider, profileId: profile ? profile.id : '', mode: 'delegate', intent, prompt: params.prompt, exitCode: -1, outcome: 'blocked', parentRunId, warnings: [`Worktree failed: ${worktreeInfo.error}`] }))
      if (emit) emit('delegate.subrun_completed', { parentRunId, subRunId, kind, outcome: 'blocked', exitCode: -1 })
      return
    }
  }
  const effectiveCwd = worktreeInfo?.ok && worktreeInfo.path ? worktreeInfo.path : workspace
  const basePrompt = globalSkillPrompt(params.prompt, availableSkills, readSettings().defaultGlobalSkills)
  const intentPrefix = planPrefix(intent)
  const prompt = withBrowserAwarenessPrompt(intentPrefix + basePrompt)
  // 6.4: Update status to 'running'
  const record = delegateRuns.get(subRunId)
  if (record) record.status = 'running'
  const child = spawn(adapter.executable, adapter.buildArgs({ workspace: effectiveCwd, model: params.model || '', reasoning: params.reasoning || '', agent: params.agent || 'default', prompt, attachments: params.attachments || [], permissionArgs: mergedArgs }), {
    cwd: effectiveCwd, env: mergedEnv, windowsHide: true, shell: false,
  })
  child.stdin.end()
  running.set(subRunId, { child, cleanup: browserOptions.cleanup, envelope: worktreeInfo?.ok ? { isolated: true, worktreeInfo, workspace } : null })
  let rawOutput = ''
  child.stdout.on('data', (chunk) => { rawOutput += chunk.toString() })
  child.stderr.on('data', (chunk) => { rawOutput += chunk.toString() })
  child.on('error', (error) => { rawOutput += error.message })
  child.on('close', async (code) => {
    running.delete(subRunId)
    try { await browserOptions.cleanup() } catch {}
    let patch = ''
    if (worktreeInfo?.ok && worktreeInfo.path) {
      try { patch = await captureWorktreeDiff(worktreeInfo.path) } catch {}
      try { await removeWorktree(workspace, worktreeInfo.path) } catch {}
    }
    const summary = extractRunSummary(provider, rawOutput)
    if (summary) writeSummary(userData, subRunId, summary)
    if (patch) writePatch(userData, subRunId, patch)
    const exitCode = Number.isFinite(code) ? code : -1
    const outcome = exitCode === 0 ? 'success' : 'blocked'
    const usage = extractTokenUsage(provider, rawOutput, params.model)
    const costEstimate = estimateRunCost(provider, params.model, usage)
    if (sessionId) {
      try {
        appendSpendEntry(userData, sessionId, {
          runId: subRunId, provider, profileId: profile ? profile.id : '', model: params.model,
          cost: costEstimate.cost, costType: costEstimate.type, unverifiable: costEstimate.unverifiable,
          usage: usage || {}, parentRunId,
        })
      } catch {}
    }
    writeReceipt(userData, subRunId, normalizeReceipt({
      runId: subRunId, sessionId, provider, profileId: profile ? profile.id : '', mode: 'delegate', intent,
      prompt: params.prompt, exitCode, outcome, parentRunId,
      filesChanged: [], startedAt: delegateRuns.get(subRunId)?.startedAt || Date.now(), finishedAt: Date.now(),
    }))
    writeManifest(userData, subRunId, { kind: 'delegate' })
    const record = delegateRuns.get(subRunId)
    if (record) { record.status = exitCode === 0 ? 'completed' : 'failed'; record.finishedAt = Date.now(); record.result = { summary, patch, outcome, exitCode } }
    if (emit) emit('delegate.subrun_completed', { parentRunId, subRunId, kind, outcome, exitCode })
  })
}

// 6.4: Recover delegate run status from artifacts (after restart)
function recoverDelegateRunStatus(subRunId, userData) {
  const receipt = readReceipt(userData, subRunId)
  if (!receipt) return null
  const status = receipt.outcome === 'success' ? 'completed' : receipt.outcome === 'blocked' ? 'failed' : 'completed'
  return { state: status, kind: receipt.mode, provider: receipt.provider, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt, result: { outcome: receipt.outcome, exitCode: receipt.exitCode } }
}

ipcMain.handle('agent:run', async (event, request) => {
  const adapter = adapters[request.provider]
  if (!adapter) throw new Error(`Unknown provider: ${request.provider}`)
  const workspace = path.resolve(request.workspace || process.cwd())
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error('Workspace does not exist')
  const mode = request.mode === 'resume' || request.mode === 'restart' || request.mode === 'retry' ? request.mode : 'run'
  const intent = request.intent === 'plan' || request.intent === 'ask' ? request.intent : 'agent'
  const repairConfig = normalizeRepairConfig(request.repair)
  const delegateConfig = normalizeDelegateConfig(request.delegate)
  const readOnly = isReadOnlyIntent(intent)
  const isolated = Boolean(request.isolated) && !readOnly && mode === 'run'
  const budgetConfig = normalizeBudget(request.maxUsd)
  const gatesConfig = normalizeGatesConfig(request.gates)
  const availableSkills = listSkills(workspace, app.getPath('home'), getCodexHome())

  const home = app.getPath('home')
  const userData = app.getPath('userData')
  const profiles = mergeProfiles(readProfiles(userData, home), detectDefaultProfiles(home))
  const profile = findProfile(profiles, request.profileId)
  if (request.profileId && !profile) throw new Error('Selected credential profile is not available')
  const profileEnv = profile ? profileEnvOverlay(profile) : {}

  const sessionId = request.sessionId || ''
  const profileRef = profile ? profile.id : ''
  if (sessionId) ensureLaneDir(userData, sessionId, request.provider, profileRef)

  // 5.5: Budget preflight — zero budget blocks any run with potential cost
  if (budgetConfig.enabled && budgetConfig.zero) {
    const costModel = estimateRunCost(request.provider, request.model, null)
    if (costModel.unverifiable || costModel.cost > 0) {
      const runId = generateRunId()
      ensureRunDir(userData, runId)
      writeReceipt(userData, runId, normalizeReceipt({
        runId, sessionId, provider: request.provider, profileId: profileRef, mode, intent,
        prompt: request.prompt || '', exitCode: -1, outcome: 'blocked',
        filesChanged: [], startedAt: Date.now(), finishedAt: Date.now(),
        budget: { maxUsd: 0, reason: 'zero_budget_blocks_paid_runs' },
        warnings: ['Budget set to $0 — run blocked because provider may incur cost'],
      }))
      return { runId, blocked: true, reason: 'zero_budget' }
    }
  }
  if (budgetConfig.enabled && !budgetConfig.omitted) {
    const spend = sessionId ? sessionSpend(userData, sessionId) : 0
    const headroom = hasBudgetHeadroom(spend, budgetConfig)
    if (!headroom.allowed) {
      const runId = generateRunId()
      ensureRunDir(userData, runId)
      writeReceipt(userData, runId, normalizeReceipt({
        runId, sessionId, provider: request.provider, profileId: profileRef, mode, intent,
        prompt: request.prompt || '', exitCode: -1, outcome: 'exhausted_overshoot',
        filesChanged: [], startedAt: Date.now(), finishedAt: Date.now(),
        budget: { maxUsd: budgetConfig.maxUsd, spend, reason: headroom.reason || 'budget_exhausted' },
      }))
      return { runId, blocked: true, reason: 'budget_exhausted' }
    }
  }

  // 5.1: Generate runId BEFORE any run setup
  const runId = generateRunId()
  const changesBeforeRun = readOnly ? null : await readWorkspaceChanges(workspace)
  const fingerprintBefore = readOnly ? await workspaceFingerprint(workspace) : null

  // 5.2: Prepare envelope — fail-closed for isolated
  const envelope = await prepareEnvelope({ isolated, intent, userData, sessionId, runId, workspace })
  if (envelope.failClosed) {
    ensureRunDir(userData, runId)
    writeReceipt(userData, runId, normalizeReceipt({
      runId, sessionId, provider: request.provider, profileId: profileRef, mode, intent,
      prompt: request.prompt || '', exitCode: -1, outcome: 'blocked',
      filesChanged: [], startedAt: Date.now(), finishedAt: Date.now(),
      warnings: [`Isolated envelope setup failed: ${envelope.error}`],
    }))
    return { runId, blocked: true, reason: 'envelope_failed' }
  }
  const runCwd = envelope.cwd || workspace

  // 5.3: Enforce read-only permissions for ask/plan
  const permissions = effectivePermissionOptions(request.provider, intent, request.permissionMode, { ...process.env, ...profileEnv })
  const descriptor = browserMcpReady ? browserMcp.descriptor() : null
  let browserOptions
  let delegateMcp = null
  let delegateDescriptor = null
  // 5.3: No delegate for plan/ask
  if (delegateConfig.enabled && mode === 'run' && !readOnly && !request.parentRunId) {
    try {
      const sessionSpendUsd = sessionId ? sessionSpend(userData, sessionId) : 0
      const policy = buildPolicy(delegateConfig, { maxUsd: budgetConfig.maxUsd, sessionSpendUsd })
      const emitDelegate = (type, data = {}) => {
        if (!event.sender.isDestroyed()) event.sender.send('agent:event', { runId, type: 'stdout', data: JSON.stringify({ type: `agentdock.${type}`, runId, ...data }) })
      }
      delegateMcp = createDelegateMcp({
        policy,
        context: { estimatedCostPerCandidate: () => null },
        spawnSubRun: async (kind, params) => runDelegateSubRun({
          kind, params, parentRunId: runId, sessionId, parentProvider: request.provider, parentProfileId: profileRef,
          workspace, userData, home, availableSkills, emit: emitDelegate, policy: { allowedProviders: [request.provider] },
        }),
        statusOf: (subRunId) => {
          const record = delegateRuns.get(subRunId)
          if (record) return { state: record.status, kind: record.kind, provider: record.provider, startedAt: record.startedAt, finishedAt: record.finishedAt }
          // 6.4: Recover from artifacts after restart
          return recoverDelegateRunStatus(subRunId, userData)
        },
        resultOf: (subRunId) => {
          const record = delegateRuns.get(subRunId)
          if (record && record.status !== 'running' && record.status !== 'queued') return record.result || null
          // 6.4: Recover from artifacts
          const recovered = recoverDelegateRunStatus(subRunId, userData)
          if (!recovered || recovered.state === 'running' || recovered.state === 'queued') return null
          return recovered.result || null
        },
      })
      await delegateMcp.start()
      delegateDescriptor = delegateMcp.descriptor()
      delegateServers.set(runId, delegateMcp)
    } catch (error) {
      console.error('[agentdock] Failed to start delegate MCP:', error && error.message ? error.message : error)
      delegateMcp = null
      delegateDescriptor = null
    }
  }
  const baseRequest = { ...request, workspace: runCwd, permissionArgs: permissions.args }
  ensureRunDir(userData, runId)
  const startedAt = Date.now()
  const emit = (type, data = '') => {
    if (!event.sender.isDestroyed()) event.sender.send('agent:event', { runId, type, data })
  }
  const appendArtifact = (type, data) => {
    appendEvents(userData, runId, JSON.stringify({ ts: Date.now(), type, data }))
  }

  // 5.5: Budget reservation
  let reservationId = null
  if (budgetConfig.enabled && !budgetConfig.omitted && sessionId) {
    const estimatedCost = estimateRunCost(request.provider, request.model, null)
    const reserveAmount = estimatedCost.unverifiable ? 0.01 : estimatedCost.cost
    const reservation = reserveBudget(sessionId, reserveAmount, { runId, provider: request.provider })
    reservationId = reservation.id
  }

  // Build context manifest. Unknown provider-internal state is represented as
  // an explicit unknown component; everything else is known/estimated.
  const runType = request.pipelineStep ? 'pipeline' : 'run'
  const contextInvocation = createContextInvocation({
    runId,
    parentRunId: request.parentRunId || null,
    provider: request.provider,
    model: request.model,
    runType,
    pipelineStep: request.pipelineStep || null,
    startedAt,
  })
  contextInvocation.sessionId = sessionId
  if (Array.isArray(request.contextComponents)) {
    for (const component of request.contextComponents) {
      const normalized = normalizeContextComponent(component)
      if (normalized) {
        normalized.runId = runId
        normalized.agent = request.agent || 'default'
        contextInvocation.components.push(normalized)
      }
    }
  }
  if (request.continuationPacket) {
    contextInvocation.components.push(createContextItem({
      category: COMPONENT_CATEGORIES.continuationPacket,
      source: 'lane-continuity',
      runId,
      agent: request.agent || 'default',
      text: typeof request.continuationPacket === 'string' ? request.continuationPacket : '',
    }))
  }
  if (mode !== 'resume') {
    const intentPrefix = planPrefix(intent)
    if (intentPrefix) contextInvocation.components.push(createContextItem({ category: COMPONENT_CATEGORIES.intentPrefix, source: `intent-${intent}`, runId, agent: request.agent || 'default', text: intentPrefix }))
    const defaultGlobalSkills = readSettings().defaultGlobalSkills
    if (defaultGlobalSkills.length) {
      contextInvocation.components.push(createContextItem({ category: COMPONENT_CATEGORIES.globalSkill, source: 'default-global-skills', runId, agent: request.agent || 'default', text: defaultGlobalSkills.join(', ') }))
    }
    contextInvocation.components.push(createContextItem({ category: COMPONENT_CATEGORIES.browserAwareness, source: 'agentdock-browser', runId, agent: request.agent || 'default', text: 'Browser awareness prompt injected via agentdock-browser MCP.' }))
    if (delegateConfig.enabled && delegateDescriptor) {
      contextInvocation.components.push(createContextItem({ category: COMPONENT_CATEGORIES.delegateAwareness, source: 'agentdock-delegate', runId, agent: request.agent || 'default', text: 'Delegation awareness prompt injected via agentdock-delegate MCP.' }))
    }
  } else {
    contextInvocation.components.push(createContextItem({ category: COMPONENT_CATEGORIES.resumeInstruction, source: 'resume', runId, agent: request.agent || 'default', text: request.lastPrompt || request.prompt || 'Continue from where we left off.' }))
  }
  addUnknownSystemState(contextInvocation, 'Provider-internal system prompts and CLI internal state are not visible to AgentDock.')
  activeContextInvocations.set(runId, contextInvocation)
  writeContextManifest(userData, runId, contextInvocation)

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
      cwd: runCwd,
      env: mergedEnv,
      windowsHide: true,
      shell: false,
    })
  } else {
    const basePrompt = globalSkillPrompt(request.prompt, availableSkills, readSettings().defaultGlobalSkills)
    const intentPrefix = planPrefix(intent)
    const promptBase = withBrowserAwarenessPrompt(intentPrefix + basePrompt)
    const prompt = delegateConfig.enabled ? withDelegateAwarenessPrompt(promptBase) : promptBase
    browserOptions = delegateConfig.enabled && delegateDescriptor
      ? combinedMcpLaunchOptions(request.provider, descriptor, delegateDescriptor, runId, permissions.env)
      : browserMcpLaunchOptions(request.provider, descriptor, runId, permissions.env)
    const mergedEnv = { ...permissions.env, ...browserOptions.env, ...profileEnv, NO_COLOR: '1', FORCE_COLOR: '0' }
    const mergedArgs = [...permissions.args, ...browserOptions.args]
    child = spawn(adapter.executable, adapter.buildArgs({ ...baseRequest, prompt, permissionArgs: mergedArgs }), {
      cwd: runCwd,
      env: mergedEnv,
      windowsHide: true,
      shell: false,
    })
  }
  child.stdin.end()
  const controller = { child, cleanup: browserOptions.cleanup, delegateMcp, envelope: { ...envelope, workspace }, cancelled: false, contextInvocation }
  running.set(runId, controller)
  let rawOutput = ''
  child.stdout.on('data', (chunk) => { const text = chunk.toString(); emit('stdout', text); appendArtifact('stdout', text); rawOutput += text })
  child.stderr.on('data', (chunk) => { const text = chunk.toString(); emit('stderr', text); appendArtifact('stderr', text); rawOutput += text })
  child.on('error', (error) => { emit('error', error.message); appendArtifact('error', error.message); rawOutput += error.message })

  child.on('close', async (code) => {
    running.delete(runId)
    try { await browserOptions.cleanup() } catch {}
    if (delegateMcp) { try { await delegateMcp.stop() } catch {} ; delegateServers.delete(runId) }
    const exitCode = Number.isFinite(code) ? code : -1

    // 5.3: Read-only intent — verify no workspace mutation
    if (readOnly && fingerprintBefore) {
      const fingerprintAfter = await workspaceFingerprint(workspace)
      if (fingerprintAfter.hash !== fingerprintBefore.hash) {
        const violationEvent = JSON.stringify({ type: 'agentdock.readonly.violation', runId, intent, before: fingerprintBefore.hash, after: fingerprintAfter.hash })
        emit('stdout', `\n${violationEvent}\n`)
        appendArtifact('stdout', `\n${violationEvent}\n`)
        writeReceipt(userData, runId, normalizeReceipt({
          runId, sessionId, provider: request.provider, profileId: profileRef, mode, intent,
          prompt: request.prompt || '', exitCode, outcome: 'blocked',
          filesChanged: [], startedAt, finishedAt: Date.now(),
          warnings: ['Read-only intent violated workspace — mutation detected'],
        }))
        emit('exit', String(exitCode))
        return
      }
    }

    // 5.2: Capture patch from worktree (includes untracked files now)
    let changes
    let worktreeDiff = ''
    let adopted = false
    let adoptionConflict = false
    if (envelope.isolated && envelope.worktreeInfo?.ok && envelope.worktreeInfo.path) {
      try { worktreeDiff = await captureWorktreeDiff(envelope.worktreeInfo.path) } catch {}
      changes = []
    } else {
      changes = changesBeforeRun ? workspaceChangeDelta(changesBeforeRun, await readWorkspaceChanges(workspace, true)) : []
    }
    if (changes.length) {
      const changeEvent = JSON.stringify({ type: 'agentdock.file_changes', changes })
      emit('stdout', `\n${changeEvent}\n`)
      appendArtifact('stdout', `\n${changeEvent}\n`)
    }
    const patch = envelope.isolated ? worktreeDiff : buildDiffFromChanges(changes)
    writePatch(userData, runId, patch)

    // 5.2: Gates run BEFORE adopt — including in worktree
    let gateResult = null
    let protectedTriggered = false
    if (!readOnly && (gatesConfig.testCommand || gatesConfig.protectedPaths.length)) {
      const protectedResult = gatesConfig.protectedPaths.length
        ? checkProtectedPaths(changes, gatesConfig.protectedPaths)
        : { triggered: false, matchedPaths: [] }
      protectedTriggered = protectedResult.triggered
      let testResult = null
      const gateCwd = envelope.isolated && envelope.worktreeInfo?.ok ? envelope.worktreeInfo.path : workspace
      if (gatesConfig.testCommand && !protectedResult.triggered) {
        emit('stdout', `\n${JSON.stringify({ type: 'agentdock.gates.running', runId, command: gatesConfig.testCommand })}\n`)
        testResult = await runGateCommand(gatesConfig.testCommand, gateCwd)
      }
      const evaluation = evaluateGates({ testResult, protectedResult })
      gateResult = {
        runId,
        testCommand: gatesConfig.testCommand,
        testPassed: evaluation.testPassed,
        testExitCode: testResult?.exitCode ?? null,
        testStdout: testResult?.stdout?.slice(0, 5000) || '',
        testStderr: testResult?.stderr?.slice(0, 5000) || '',
        protectedPaths: protectedResult,
        needsApproval: evaluation.needsApproval,
        overall: evaluation.overall,
      }
      writeGateResult(userData, runId, gateResult)
      const gateEvent = JSON.stringify({ type: 'agentdock.gates.result', runId, overall: gateResult.overall, needsApproval: gateResult.needsApproval, testPassed: gateResult.testPassed, protectedTriggered })
      emit('stdout', `\n${gateEvent}\n`)
      appendArtifact('stdout', `\n${gateEvent}\n`)
    }

    // 5.2: Adopt ONLY after gates pass and no protected-path trigger
    if (envelope.isolated && worktreeDiff && !readOnly) {
      const canAdopt = !gateResult || (gateResult.overall === 'pass' && !gateResult.needsApproval)
      if (canAdopt) {
        const adoptResult = await adoptPatch({ workspace, patch: worktreeDiff, baseTreeHash: envelope.baseTreeHash, emit, appendArtifact, runId })
        adopted = adoptResult.adopted
        adoptionConflict = Boolean(adoptResult.baseConflict)
        if (adopted) {
          changes = changesBeforeRun ? workspaceChangeDelta(changesBeforeRun, await readWorkspaceChanges(workspace, true)) : []
        }
      }
    }

    // 5.4: Repair loop — real for/while loop
    let repairAttempts = []
    let repairStalled = false
    let finalOutcome = computeOutcome({ exitCode, gateResult, intent, isolated: envelope.isolated, protectedTriggered, spawnError: null })
    if (gateResult && gateResult.overall === 'test_failed' && (repairConfig.attempts > 1 || repairConfig.untilClean) && !readOnly) {
      const stallFingerprints = []
      const gateOutputs = []
      const maxAttempts = repairConfig.untilClean ? MAX_ATTEMPTS : Math.max(1, repairConfig.attempts)
      for (let attemptNum = 2; attemptNum <= maxAttempts; attemptNum++) {
        if (controller.cancelled) { finalOutcome = 'cancelled'; break }
        const lastGateOutput = gateResult?.testStderr || gateResult?.testStdout || ''
        gateOutputs.push(lastGateOutput)
        const patchHash = contentHash(patch)
        stallFingerprints.push(stallFingerprint(lastGateOutput, patchHash))
        const continueDecision = shouldContinue({
          attempt: attemptNum - 1, attempts: maxAttempts, untilClean: repairConfig.untilClean,
          lastGatePassed: false, lastGateOutput, gateOutputs, cancelled: controller.cancelled,
          stallFingerprints, protectedTriggered: false, spawnError: false,
        })
        if (!continueDecision.continue) {
          repairStalled = continueDecision.reason === 'stall'
          break
        }
        const repairPromptText = buildRepairPrompt(request.prompt || request.lastPrompt || '', lastGateOutput, attemptNum)
        const repairEvent = JSON.stringify(repairEventPayload(runId, attemptNum, gateResult.overall, 'gate_failed_retry'))
        emit('stdout', `\n${repairEvent}\n`)
        appendArtifact('stdout', `\n${repairEvent}\n`)
        const repairBasePrompt = globalSkillPrompt(repairPromptText, availableSkills, readSettings().defaultGlobalSkills)
        const repairPrompt = withBrowserAwarenessPrompt(repairBasePrompt)
        const repairBrowserOptions = browserMcpLaunchOptions(request.provider, descriptor, runId, permissions.env)
        const repairMergedEnv = { ...permissions.env, ...repairBrowserOptions.env, ...profileEnv, NO_COLOR: '1', FORCE_COLOR: '0' }
        const repairMergedArgs = [...permissions.args, ...repairBrowserOptions.args]
        const repairChild = spawn(adapter.executable, adapter.buildArgs({ ...baseRequest, prompt: repairPrompt, permissionArgs: repairMergedArgs }), {
          cwd: runCwd, env: repairMergedEnv, windowsHide: true, shell: false,
        })
        repairChild.stdin.end()
        running.set(runId, { ...controller, child: repairChild })
        let repairRaw = ''
        await new Promise((resolve) => {
          repairChild.stdout.on('data', (chunk) => { const text = chunk.toString(); emit('stdout', text); appendArtifact('stdout', text); repairRaw += text })
          repairChild.stderr.on('data', (chunk) => { const text = chunk.toString(); emit('stderr', text); appendArtifact('stderr', text); repairRaw += text })
          repairChild.on('error', (error) => { emit('error', error.message); appendArtifact('error', error.message); repairRaw += error.message })
          repairChild.on('close', () => resolve())
        })
        running.delete(runId)
        try { await repairBrowserOptions.cleanup() } catch {}
        writeAttemptArtifact(userData, runId, attemptNum, 'events.jsonl', repairRaw)
        const repairChanges = changesBeforeRun ? workspaceChangeDelta(changesBeforeRun, await readWorkspaceChanges(workspace, true)) : []
        const repairPatch = envelope.isolated ? await captureWorktreeDiff(envelope.worktreeInfo.path).catch(() => '') : buildDiffFromChanges(repairChanges)
        writeAttemptArtifact(userData, runId, attemptNum, 'patch.diff', repairPatch)
        let repairGateResult = null
        if (gatesConfig.testCommand) {
          const gateCwd = envelope.isolated && envelope.worktreeInfo?.ok ? envelope.worktreeInfo.path : workspace
          const repairTestResult = await runGateCommand(gatesConfig.testCommand, gateCwd)
          const repairEvaluation = evaluateGates({ testResult: repairTestResult, protectedResult: { triggered: false, matchedPaths: [] } })
          repairGateResult = {
            runId, testCommand: gatesConfig.testCommand,
            testPassed: repairEvaluation.testPassed, testExitCode: repairTestResult?.exitCode ?? null,
            testStdout: repairTestResult?.stdout?.slice(0, 5000) || '',
            testStderr: repairTestResult?.stderr?.slice(0, 5000) || '',
            protectedPaths: { triggered: false, matchedPaths: [] },
            needsApproval: repairEvaluation.needsApproval, overall: repairEvaluation.overall,
          }
          writeGateResult(userData, runId, repairGateResult)
          const rGateEvent = JSON.stringify({ type: 'agentdock.gates.result', runId, overall: repairGateResult.overall, needsApproval: repairGateResult.needsApproval, testPassed: repairGateResult.testPassed, protectedTriggered: false })
          emit('stdout', `\n${rGateEvent}\n`)
          appendArtifact('stdout', `\n${rGateEvent}\n`)
        }
        repairAttempts.push({ exitCode: 0, gateOverall: repairGateResult?.overall, gatePassed: repairGateResult?.testPassed, gateOutput: repairGateResult?.testStderr || repairGateResult?.testStdout || '', attemptNumber: attemptNum })
        if (repairGateResult?.testPassed) {
          finalOutcome = 'success'
          if (envelope.isolated && repairPatch) {
            const adoptResult = await adoptPatch({ workspace, patch: repairPatch, baseTreeHash: envelope.baseTreeHash, emit, appendArtifact, runId })
            adopted = adoptResult.adopted
            adoptionConflict = Boolean(adoptResult.baseConflict)
          }
          break
        }
        gateResult = repairGateResult || gateResult
      }
      writeAttemptLog(userData, runId, [{ exitCode, gateOverall: gateResult?.overall, gatePassed: gateResult?.testPassed, gateOutput: gateResult?.testStderr || gateResult?.testStdout || '', attemptNumber: 1 }, ...repairAttempts])
    }

    const summary = extractRunSummary(request.provider, rawOutput)
    if (summary) writeSummary(userData, runId, summary)
    let planResult = null
    if (intent === 'plan' && summary && sessionId) {
      const openQuestions = parseOpenQuestions(summary)
      const readiness = classifyPlanReadiness(summary, openQuestions)
      planResult = writePlanContract(userData, sessionId, summary, [])
      writePlanArtifact(userData, runId, summary)
      const planEvent = JSON.stringify({ type: 'agentdock.plan.result', runId, sessionId, readiness, openQuestions, hash: planResult?.hash || '', planPath: planResult?.path || '' })
      emit('stdout', `\n${planEvent}\n`)
      appendArtifact('stdout', `\n${planEvent}\n`)
    }

    // 5.5: Budget settlement — receipt AFTER budget settle
    let costEvidence = null
    let budgetInfo = null
    if (sessionId) {
      try {
        const runUsage = extractTokenUsage(request.provider, rawOutput, request.model)
        const costEstimate = estimateRunCost(request.provider, request.model, runUsage)
        costEvidence = costEstimate
        appendSpendEntry(userData, sessionId, {
          runId, provider: request.provider, profileId: profileRef, model: request.model,
          cost: costEstimate.cost, costType: costEstimate.type, unverifiable: costEstimate.unverifiable,
          usage: runUsage || {},
        })
        if (reservationId) settleReservation(sessionId, reservationId, costEstimate.cost)
        if (budgetConfig.enabled && !budgetConfig.omitted) {
          const spend = sessionSpend(userData, sessionId)
          const budgetCheck = checkBudget(spend, budgetConfig)
          budgetInfo = { maxUsd: budgetConfig.maxUsd, spend: Math.round(spend * 1_000_000) / 1_000_000, remaining: budgetCheck.remaining, exceeded: budgetCheck.exceeded }
          const budgetEvent = JSON.stringify({ type: 'agentdock.budget.update', runId, sessionId, spend: budgetInfo.spend, maxUsd: budgetConfig.maxUsd, remaining: budgetCheck.remaining, exceeded: budgetCheck.exceeded })
          emit('stdout', `\n${budgetEvent}\n`)
          appendArtifact('stdout', `\n${budgetEvent}\n`)
          if (budgetCheck.exceeded && finalOutcome === 'success') {
            finalOutcome = 'exhausted_overshoot'
          }
          if (costEstimate.unverifiable && !budgetConfig.omitted) {
            finalOutcome = 'cost_unverifiable'
          }
        }
      } catch {}
    }

    // 5.2: Cleanup envelope
    let cleanupWarning = null
    if (envelope.isolated) {
      const cleanupResult = await cleanupEnvelope({ isolated: envelope.isolated, worktreeInfo: envelope.worktreeInfo, workspace, intent })
      cleanupWarning = cleanupResult.warning
    }

    // Finalize context manifest with provider usage and reconciliation.
    const runUsage = extractTokenUsage(request.provider, rawOutput, request.model)
    reconcileInvocation(contextInvocation, runUsage)
    writeContextManifest(userData, runId, contextInvocation)
    activeContextInvocations.delete(runId)

    // 5.1: Single terminal receipt
    const warnings = []
    if (cleanupWarning) warnings.push(cleanupWarning)
    if (adoptionConflict) warnings.push('Adoption conflict — base tree changed, patch preserved but not applied')
    if (repairStalled) warnings.push('Repair loop stalled — same gate failure and patch hash repeated')
    writeReceipt(userData, runId, normalizeReceipt({
      runId, sessionId, provider: request.provider, profileId: profileRef, mode,
      intent,
      prompt: request.prompt || request.lastPrompt || '',
      exitCode, outcome: finalOutcome,
      filesChanged: changes.map((c) => ({ path: c.path, additions: c.additions, deletions: c.deletions })),
      startedAt, finishedAt: Date.now(),
      ...(envelope.baseTreeHash ? { baseTreeHash: envelope.baseTreeHash } : {}),
      ...(cleanupWarning ? { cleanupWarning } : {}),
      ...(costEvidence ? { cost: costEvidence } : {}),
      ...(budgetInfo ? { budget: budgetInfo } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(planResult?.hash ? { planHash: planResult.hash } : {}),
    }))
    // 6.1: Write telemetry.yaml and manifest.json for terminal artifacts
    writeTelemetry(userData, runId, { provider: request.provider, model: request.model, intent, outcome: finalOutcome, exitCode, startedAt, finishedAt: Date.now(), usage: runUsage, cost: costEvidence })
    writeManifest(userData, runId, { kind: intent === 'plan' ? 'plan' : 'run', extraFiles: [{ path: 'context.json', size: 0, contentType: 'application/json' }] })
    const outcomeEvent = JSON.stringify({ type: 'agentdock.run.outcome', runId, outcome: finalOutcome, exitCode, provider: request.provider, profileId: profileRef })
    emit('stdout', `\n${outcomeEvent}\n`)
    appendArtifact('stdout', `\n${outcomeEvent}\n`)
    emit('exit', String(exitCode))
    if (sessionId) {
      try {
        const sessions = readSessions()
        const session = sessions.find((item) => item.id === sessionId)
        if (session) {
          const laneUsage = runUsage ? normalizeTokenUsageShared(runUsage) : undefined
          const updatedLanes = setLaneState(session.lanes || {}, request.provider, profileRef, {
            lastExitCode: exitCode,
            lastRunFailed: exitCode !== 0,
            ...(laneUsage ? { usage: laneUsage } : {}),
          })
          writeSessions(sessions.map((item) => item.id === sessionId ? { ...item, lanes: updatedLanes, updatedAt: Date.now() } : item))
        }
      } catch {}
    }
    // 6.5: Rotation only by recognized typed vendor-limit signal, not by non-zero exit code
    if (exitCode !== 0 && profile && readSettings().limitAction === 'rotate') {
      try {
        const providerLimits = request.provider === 'codex' ? await getCodexRateLimits({ ...process.env, ...profileEnv }) : request.provider === 'claude' ? await getClaudeRateLimits({ ...process.env, ...profileEnv }) : null
        // 6.5: Only rotate on typed vendor-limit signal
        if (providerLimits && isTypedVendorLimitSignal(providerLimits, exitCode)) {
          const allProfiles = mergeProfiles(readProfiles(app.getPath('userData'), app.getPath('home')), detectDefaultProfiles(app.getPath('home')))
          const candidate = nextReadyProfile(allProfiles, request.provider, profile.id)
          if (candidate) {
            emit('stdout', `\n${JSON.stringify({ type: 'agentdock.route.profile.rotated', from: profile.id, to: candidate.id, reason: 'quota_exhausted', signal: 'typed_vendor_limit' })}\n`)
            appendArtifact('stdout', `\n${JSON.stringify({ type: 'agentdock.route.profile.rotated', from: profile.id, to: candidate.id, reason: 'quota_exhausted', signal: 'typed_vendor_limit' })}\n`)
          }
        }
      } catch {}
    }
  })
  return { runId }
})

async function runCouncilDraft({ provider, request, workspace, userData, home, availableSkills, sessionId, emit, councilId }) {
  const adapter = adapters[provider]
  if (!adapter) return { provider, ok: false, summary: 'Adapter not found', path: null }
  const profiles = mergeProfiles(readProfiles(userData, home), detectDefaultProfiles(home))
  const profile = findProfile(profiles, request.profileId) || null
  const profileEnv = profile ? profileEnvOverlay(profile) : {}
  const permissions = permissionLaunchOptions(provider, request.permissionMode, { ...process.env, ...profileEnv })
  const descriptor = browserMcpReady ? browserMcp.descriptor() : null
  const draftRunId = crypto.randomUUID()
  const browserOptions = browserMcpLaunchOptions(provider, descriptor, draftRunId, permissions.env)
  const mergedEnv = { ...permissions.env, ...browserOptions.env, ...profileEnv, NO_COLOR: '1', FORCE_COLOR: '0' }
  const mergedArgs = [...permissions.args, ...browserOptions.args]
  const planPrefixText = planPrefix('plan')
  const basePrompt = globalSkillPrompt(request.prompt, availableSkills, readSettings().defaultGlobalSkills)
  const prompt = withBrowserAwarenessPrompt(planPrefixText + basePrompt)
  return new Promise((resolve) => {
    const child = spawn(adapter.executable, adapter.buildArgs({ workspace, model: '', reasoning: '', agent: 'default', prompt, attachments: request.attachments || [], permissionArgs: mergedArgs }), {
      cwd: workspace, env: mergedEnv, windowsHide: true, shell: false,
    })
    child.stdin.end()
    running.set(draftRunId, { child, cleanup: browserOptions.cleanup })
    let rawOutput = ''
    child.stdout.on('data', (chunk) => { rawOutput += chunk.toString() })
    child.stderr.on('data', (chunk) => { rawOutput += chunk.toString() })
    child.on('close', async (code) => {
      running.delete(draftRunId)
      try { await browserOptions.cleanup() } catch {}
      const summary = extractRunSummary(provider, rawOutput)
      const draftResult = writeDraft(userData, sessionId, provider, summary)
      const draftPath = draftResult?.path || null
      const draftHash = draftResult?.hash || ''
      // 6.3: Write draft receipt as self-contained child run
      writeReceipt(userData, draftRunId, normalizeReceipt({
        runId: draftRunId, sessionId, provider, mode: 'council', intent: 'plan',
        prompt: request.prompt || '', exitCode: code, outcome: code === 0 ? 'success' : 'blocked',
        filesChanged: [], startedAt: Date.now(), finishedAt: Date.now(), parentRunId: councilId,
        ...(draftHash ? { draftHash } : {}),
      }))
      emit('draft_completed', { councilId, provider, ok: code === 0, path: draftPath, hash: draftHash })
      resolve({ provider, ok: code === 0, summary, path: draftPath, hash: draftHash, runId: draftRunId })
    })
  })
}

ipcMain.handle('agent:council', async (event, request) => {
  const workspace = path.resolve(request.workspace || process.cwd())
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error('Workspace does not exist')
  const councilConfig = normalizeCouncilConfig(request.council)
  if (!councilConfig.enabled) throw new Error('Council mode is not enabled')
  const home = app.getPath('home')
  const userData = app.getPath('userData')
  const sessionId = request.sessionId || ''
  if (!sessionId) throw new Error('Session ID is required for council planning')
  const availableSkills = listSkills(workspace, home, getCodexHome())
  const councilId = crypto.randomUUID()
  ensureCouncilDir(userData, sessionId)
  ensureRunDir(userData, councilId)
  // 6.3: Preflight — check CLI availability for all council providers
  const installedProviders = []
  for (const [id, adapter] of Object.entries(adapters)) {
    const detected = await commandExists(adapter.executable)
    if (detected.installed) installedProviders.push(id)
  }
  // 6.3: Show partial council instead of silent substitution
  const selection = selectCouncilProviders(councilConfig.providers, installedProviders)
  if (!selection.providers) {
    writeReceipt(userData, councilId, normalizeReceipt({ runId: councilId, sessionId, mode: 'council', intent: 'plan', outcome: 'blocked', exitCode: -1, warnings: [`Council requires at least 2 available providers, got ${installedProviders.length}`] }))
    if (!event.sender.isDestroyed()) event.sender.send('agent:event', { runId: councilId, type: 'stdout', data: JSON.stringify(councilEventPayload(sessionId, 'failed', { councilId, reason: 'insufficient_providers', missing: selection.missing })) })
    return { councilId, drafts: [], mergedPlan: null, openQuestions: [], readiness: 'unverified', reason: 'insufficient_providers' }
  }
  const councilProviders = selection.providers
  if (selection.missing.length) {
    if (!event.sender.isDestroyed()) event.sender.send('agent:event', { runId: councilId, type: 'stdout', data: JSON.stringify(councilEventPayload(sessionId, 'partial_council', { councilId, available: councilProviders, missing: selection.missing })) })
  }
  const emit = (type, data = {}) => {
    if (!event.sender.isDestroyed()) event.sender.send('agent:event', { runId: councilId, type: 'stdout', data: JSON.stringify(councilEventPayload(sessionId, type, { councilId, ...data })) })
  }
  emit('started', { providers: councilProviders, partial: selection.missing.length > 0 })
  const draftPromises = councilProviders.map((provider) =>
    runCouncilDraft({ provider, request, workspace, userData, home, availableSkills, sessionId, emit, councilId })
  )
  const drafts = await Promise.all(draftPromises)
  emit('all_drafts_completed', { count: drafts.filter((d) => d.ok).length })
  const successfulDrafts = drafts.filter((d) => d.ok && d.path)
  if (!successfulDrafts.length) {
    writeReceipt(userData, councilId, normalizeReceipt({ runId: councilId, sessionId, mode: 'council', intent: 'plan', outcome: 'blocked', exitCode: -1, warnings: ['No successful drafts'] }))
    emit('failed', { reason: 'no_successful_drafts' })
    return { councilId, drafts, mergedPlan: null, openQuestions: [], readiness: 'unverified' }
  }
  const mergeProvider = councilProviders[0]
  const mergeAdapter = adapters[mergeProvider]
  if (!mergeAdapter) {
    writeReceipt(userData, councilId, normalizeReceipt({ runId: councilId, sessionId, mode: 'council', intent: 'plan', outcome: 'blocked', exitCode: -1, warnings: ['No merge adapter'] }))
    emit('failed', { reason: 'no_merge_adapter' })
    return { councilId, drafts, mergedPlan: null, openQuestions: [], readiness: 'unverified' }
  }
  // 6.3: Merge-run gets only absolute references to immutable draft artifacts + hashes
  const draftPaths = successfulDrafts.map((d) => d.path)
  const draftHashes = successfulDrafts.map((d) => ({ provider: d.provider, hash: d.hash, path: d.path }))
  const mergePrompt = buildMergePrompt(request.prompt, draftPaths)
  const mergePermissions = permissionLaunchOptions(mergeProvider, request.permissionMode, { ...process.env })
  const mergeDescriptor = browserMcpReady ? browserMcp.descriptor() : null
  const mergeRunId = crypto.randomUUID()
  const mergeBrowserOptions = browserMcpLaunchOptions(mergeProvider, mergeDescriptor, mergeRunId, mergePermissions.env)
  const mergeEnv = { ...mergePermissions.env, ...mergeBrowserOptions.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  const mergeArgs = [...mergePermissions.args, ...mergeBrowserOptions.args]
  const mergedPlan = await new Promise((resolve) => {
    const mergeChild = spawn(mergeAdapter.executable, mergeAdapter.buildArgs({ workspace, model: '', reasoning: '', agent: 'default', prompt: mergePrompt, attachments: [], permissionArgs: mergeArgs }), {
      cwd: workspace, env: mergeEnv, windowsHide: true, shell: false,
    })
    mergeChild.stdin.end()
    running.set(mergeRunId, { child: mergeChild, cleanup: mergeBrowserOptions.cleanup })
    let mergeRaw = ''
    mergeChild.stdout.on('data', (chunk) => { mergeRaw += chunk.toString() })
    mergeChild.stderr.on('data', (chunk) => { mergeRaw += chunk.toString() })
    mergeChild.on('close', async () => {
      running.delete(mergeRunId)
      try { await mergeBrowserOptions.cleanup() } catch {}
      resolve(extractRunSummary(mergeProvider, mergeRaw))
    })
  })
  // 6.3: Merge failure does not overwrite last accepted plan revision
  if (!mergedPlan) {
    const existingContract = readPlanContract(userData, sessionId)
    writeReceipt(userData, councilId, normalizeReceipt({ runId: councilId, sessionId, mode: 'council', intent: 'plan', outcome: 'blocked', exitCode: -1, warnings: ['Merge produced no output'], ...(existingContract ? { preservedPlanHash: existingContract.hash } : {}) }))
    emit('merge_failed', { reason: 'no_output', preservedPlan: Boolean(existingContract) })
    emit('exit', { councilId })
    return { councilId, drafts, mergedPlan: null, openQuestions: [], readiness: 'unverified', preservedPlan: Boolean(existingContract) }
  }
  // 6.3: Open Questions merged with deduplication by stable id
  const draftOpenQuestions = successfulDrafts.map((d) => parseOpenQuestions(d.summary || ''))
  const mergedDraftQuestions = mergeOpenQuestions(draftOpenQuestions)
  const openQuestions = parseOpenQuestions(mergedPlan)
  const allOpenQuestions = mergeOpenQuestions([mergedDraftQuestions, openQuestions])
  const readiness = classifyPlanReadiness(mergedPlan, allOpenQuestions)
  const planContract = writePlanContract(userData, sessionId, mergedPlan, [])
  emit('merge_completed', { readiness, openQuestionCount: allOpenQuestions.length, hash: planContract?.hash || '', draftHashes })
  emit('exit', { councilId })
  writeReceipt(userData, councilId, normalizeReceipt({ runId: councilId, sessionId, mode: 'council', intent: 'plan', outcome: 'success', exitCode: 0, ...(planContract ? { planHash: planContract.hash } : {}) }))
  writeManifest(userData, councilId, { kind: 'council' })
  return { councilId, drafts, mergedPlan, openQuestions: allOpenQuestions, readiness, hash: planContract?.hash || '', planPath: planContract?.path || '' }
})

async function runRaceCandidate({ event, raceId, candidateId, provider, profileId, request, workspace, userData, home, availableSkills, emit, gatesConfig }) {
  const adapter = adapters[provider]
  if (!adapter) return normalizeCandidate({ candidateId, provider, exitCode: -1, patch: '', summary: 'Adapter not found', failClosed: true, spawnError: 'adapter_not_found' })
  // 6.2: Preflight — check CLI availability
  const detected = await commandExists(adapter.executable)
  if (!detected.installed) return normalizeCandidate({ candidateId, provider, exitCode: -1, patch: '', summary: `CLI not installed: ${adapter.executable}`, failClosed: true, spawnError: 'cli_not_installed' })
  const profiles = mergeProfiles(readProfiles(userData, home), detectDefaultProfiles(home))
  const profile = findProfile(profiles, profileId) || null
  const profileEnv = profile ? profileEnvOverlay(profile) : {}
  const permissions = permissionLaunchOptions(provider, request.permissionMode, { ...process.env, ...profileEnv })
  const descriptor = browserMcpReady ? browserMcp.descriptor() : null
  const candidateRunId = crypto.randomUUID()
  const browserOptions = browserMcpLaunchOptions(provider, descriptor, candidateRunId, permissions.env)
  const mergedEnv = { ...permissions.env, ...browserOptions.env, ...profileEnv, NO_COLOR: '1', FORCE_COLOR: '0' }
  const mergedArgs = [...permissions.args, ...browserOptions.args]
  // 6.2: Fail-closed envelope — candidate MUST run in worktree
  const wtResult = await createWorktree(userData, request.sessionId || 'race', candidateRunId, workspace)
  if (!wtResult.ok) return normalizeCandidate({ candidateId, provider, exitCode: -1, patch: '', summary: `Worktree failed: ${wtResult.error}`, failClosed: true, spawnError: 'worktree_failed' })
  const runCwd = wtResult.path
  const baseTreeHash = wtResult.baseTreeHash || null
  const basePrompt = globalSkillPrompt(request.prompt, availableSkills, readSettings().defaultGlobalSkills)
  const prompt = withBrowserAwarenessPrompt(basePrompt)
  ensureRunDir(userData, candidateRunId)
  return new Promise((resolve) => {
    const child = spawn(adapter.executable, adapter.buildArgs({ workspace: runCwd, model: request.model, reasoning: request.reasoning, agent: request.agent || 'default', prompt, attachments: request.attachments || [], permissionArgs: mergedArgs }), {
      cwd: runCwd, env: mergedEnv, windowsHide: true, shell: false,
    })
    child.stdin.end()
    running.set(candidateRunId, { child, cleanup: browserOptions.cleanup, envelope: { isolated: true, worktreeInfo: wtResult, workspace } })
    let rawOutput = ''
    child.stdout.on('data', (chunk) => { const text = chunk.toString(); rawOutput += text; emit('candidate_stdout', { candidateId, text }) })
    child.stderr.on('data', (chunk) => { const text = chunk.toString(); rawOutput += text; emit('candidate_stderr', { candidateId, text }) })
    child.on('error', (error) => { rawOutput += error.message })
    child.on('close', async (code) => {
      running.delete(candidateRunId)
      try { await browserOptions.cleanup() } catch {}
      let patch = ''
      if (wtResult.ok && wtResult.path) {
        try { patch = await captureWorktreeDiff(wtResult.path) } catch {}
      }
      const summary = extractRunSummary(provider, rawOutput)
      const exitCode = Number.isFinite(code) ? code : -1
      // 6.2: Deterministic gates for candidate (inside worktree)
      let gateResult = null
      if (gatesConfig?.testCommand && exitCode === 0 && patch) {
        const testResult = await runGateCommand(gatesConfig.testCommand, runCwd)
        const evaluation = evaluateGates({ testResult, protectedResult: { triggered: false, matchedPaths: [] } })
        gateResult = {
          runId: candidateRunId, testCommand: gatesConfig.testCommand,
          testPassed: evaluation.testPassed, testExitCode: testResult?.exitCode ?? null,
          testStdout: testResult?.stdout?.slice(0, 5000) || '',
          testStderr: testResult?.stderr?.slice(0, 5000) || '',
          protectedPaths: { triggered: false, matchedPaths: [] },
          needsApproval: evaluation.needsApproval, overall: evaluation.overall,
        }
      }
      try { await removeWorktree(workspace, wtResult.path, wtResult.branch) } catch {}
      const candidate = normalizeCandidate({ candidateId, provider, profileId, runId: candidateRunId, baseTreeHash, exitCode, patch, summary, filesChanged: [], gateResult, reviews: [] })
      writeCandidateArtifact(userData, raceId, candidateId, 'patch.diff', patch)
      writeCandidateArtifact(userData, raceId, candidateId, 'summary.md', summary)
      if (gateResult) writeCandidateArtifact(userData, raceId, candidateId, 'gate-result.yaml', `overall: ${gateResult.overall}\ntest_passed: ${gateResult.testPassed}\nexit_code: ${gateResult.testExitCode}`)
      writeReceipt(userData, candidateRunId, normalizeReceipt({
        runId: candidateRunId, sessionId: request.sessionId || '', provider, profileId: profile ? profile.id : '', mode: 'race', intent: 'agent',
        prompt: request.prompt || '', exitCode, outcome: exitCode === 0 ? 'success' : 'blocked',
        filesChanged: [], startedAt: Date.now(), finishedAt: Date.now(), baseTreeHash, parentRunId: raceId,
      }))
      resolve(candidate)
    })
  })
}

ipcMain.handle('agent:race', async (event, request) => {
  const workspace = path.resolve(request.workspace || process.cwd())
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error('Workspace does not exist')
  const raceConfig = normalizeRaceConfig(request.race)
  if (raceConfig.n < 2) throw new Error('Race requires at least 2 candidates')
  const home = app.getPath('home')
  const userData = app.getPath('userData')
  const availableSkills = listSkills(workspace, home, getCodexHome())
  const raceId = crypto.randomUUID()
  ensureRaceDir(userData, raceId)
  ensureRunDir(userData, raceId)
  const gatesConfig = normalizeGatesConfig(request.gates)
  // 6.2: Preflight — check CLI availability for all providers
  const installedProviders = []
  for (const [id, adapter] of Object.entries(adapters)) {
    const detected = await commandExists(adapter.executable)
    if (detected.installed) installedProviders.push(id)
  }
  // 6.2: Fail-closed provider selection — no silent duplication
  const raceProviders = selectProvidersForRace(raceConfig.n, raceConfig.providers, installedProviders)
  if (!raceProviders) {
    const available = installedProviders.filter((p) => !raceConfig.providers.length || raceConfig.providers.includes(p))
    writeReceipt(userData, raceId, normalizeReceipt({ runId: raceId, outcome: 'blocked', exitCode: -1, warnings: [`Not enough providers: requested ${raceConfig.n}, available ${available.length}`] }))
    if (!event.sender.isDestroyed()) event.sender.send('agent:event', { runId: raceId, type: 'stdout', data: JSON.stringify(raceEventPayload(raceId, 'failed', { reason: 'insufficient_providers', requested: raceConfig.n, available: available.length })) })
    return { raceId, winner: null, reason: 'insufficient_providers', candidates: [] }
  }
  const emit = (type, data = {}) => {
    if (!event.sender.isDestroyed()) event.sender.send('agent:event', { runId: raceId, type: 'stdout', data: JSON.stringify(raceEventPayload(raceId, type, data)) })
  }
  emit('started', { n: raceConfig.n, providers: raceProviders })
  const candidateIds = raceProviders.map((_, i) => `candidate-${i + 1}-${crypto.randomUUID().slice(0, 8)}`)
  const candidatePromises = raceProviders.map((provider, i) =>
    runRaceCandidate({ event, raceId, candidateId: candidateIds[i], provider, profileId: request.profileId, request, workspace, userData, home, availableSkills, emit, gatesConfig })
  )
  const candidates = await Promise.all(candidatePromises)
  emit('candidates_completed', { count: candidates.length, eligible: candidates.filter((c) => !c.failClosed && c.exitCode === 0).length })
  // 6.2: Cross-family review — require minimum 2 distinct families
  if (raceConfig.review) {
    for (const candidate of candidates) {
      if (candidate.failClosed || candidate.exitCode !== 0 || !candidate.patch) continue
      const reviewers = selectReviewersForCandidate(candidate.provider, installedProviders, raceConfig.providers, raceConfig.reviewers)
      if (!reviewers.length) {
        emit('review_skipped', { candidateId: candidate.candidateId, reason: 'no_reviewers_available' })
        continue
      }
      for (const reviewProvider of reviewers) {
        const reviewAdapter = adapters[reviewProvider]
        if (!reviewAdapter) continue
        const reviewPrompt = buildReviewPrompt(candidate.patch, candidate.summary, request.prompt)
        const reviewProfiles = mergeProfiles(readProfiles(userData, home), detectDefaultProfiles(home))
        const reviewProfile = findProfile(reviewProfiles, null) || null
        const reviewProfileEnv = reviewProfile ? profileEnvOverlay(reviewProfile) : {}
        const reviewPermissions = permissionLaunchOptions(reviewProvider, 'ask', { ...process.env, ...reviewProfileEnv })
        const reviewDescriptor = browserMcpReady ? browserMcp.descriptor() : null
        const reviewRunId = crypto.randomUUID()
        const reviewBrowserOptions = browserMcpLaunchOptions(reviewProvider, reviewDescriptor, reviewRunId, reviewPermissions.env)
        const reviewEnv = { ...reviewPermissions.env, ...reviewBrowserOptions.env, ...reviewProfileEnv, NO_COLOR: '1', FORCE_COLOR: '0' }
        const reviewArgs = [...reviewPermissions.args, ...reviewBrowserOptions.args]
        const reviewResult = await new Promise((resolve) => {
          const reviewChild = spawn(reviewAdapter.executable, reviewAdapter.buildArgs({ workspace, model: '', reasoning: '', agent: 'default', prompt: reviewPrompt, attachments: [], permissionArgs: reviewArgs }), {
            cwd: workspace, env: reviewEnv, windowsHide: true, shell: false,
          })
          reviewChild.stdin.end()
          let reviewRaw = ''
          reviewChild.stdout.on('data', (chunk) => { reviewRaw += chunk.toString() })
          reviewChild.stderr.on('data', (chunk) => { reviewRaw += chunk.toString() })
          reviewChild.on('close', () => {
            const reviewSummary = extractRunSummary(reviewProvider, reviewRaw)
            resolve(parseReviewResponse(reviewSummary, reviewProvider))
          })
        })
        candidate.reviews = candidate.reviews || []
        candidate.reviews.push(reviewResult)
        writeReviewArtifact(userData, raceId, candidate.candidateId, reviewProvider, reviewResult)
        emit('review_completed', { candidateId: candidate.candidateId, reviewer: reviewProvider, verdict: reviewResult.verdict })
      }
    }
  }
  for (const candidate of candidates) candidate.score = scoreCandidate(candidate)
  // 6.2: Arbitration with minScore, no-winner, tie-break
  const arbitration = arbitrate(candidates, { minScore: raceConfig.minScore, reviewers: raceConfig.reviewers, review: raceConfig.review })
  writeArbitrationResult(userData, raceId, arbitration)
  // 6.2: Adopt through safe pipeline — never directly from race handler
  if (raceConfig.autoAdopt && arbitration.winner?.patch) {
    const adoptResult = await adoptPatch({ workspace, patch: arbitration.winner.patch, baseTreeHash: null, emit, appendArtifact: null, runId: raceId })
    emit('adopted', { winner: arbitration.winner.candidateId, provider: arbitration.winner.provider, ok: adoptResult.ok, error: adoptResult.error || '' })
  }
  emit('completed', { winner: arbitration.winner?.candidateId || 'none', reason: arbitration.reason })
  emit('exit', { raceId })
  writeReceipt(userData, raceId, normalizeReceipt({ runId: raceId, sessionId: request.sessionId || '', mode: 'race', intent: 'agent', outcome: arbitration.winner ? 'success' : 'blocked', exitCode: 0, warnings: arbitration.winner ? [] : ['No winner selected'] }))
  writeManifest(userData, raceId, { kind: 'race' })
  return { raceId, winner: arbitration.winner, scores: arbitration.scores, candidates, reason: arbitration.reason }
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
  if (entry.cancelled !== undefined) entry.cancelled = true
  killProcessTree(entry.child)
  running.delete(runId)
  try { if (entry.cleanup) await entry.cleanup() } catch {}
  if (entry.delegateMcp) { try { await entry.delegateMcp.stop() } catch {} ; delegateServers.delete(runId) }
  if (entry.envelope?.isolated) {
    try { await cleanupEnvelope({ isolated: entry.envelope.isolated, worktreeInfo: entry.envelope.worktreeInfo, workspace: entry.envelope.workspace, intent: 'agent' }) } catch {}
  }
  return true
})

app.whenReady().then(async () => {
  createWindow()
  // 6.1: Startup recovery — mark interrupted runs and recover orphan worktrees
  try {
    const recovered = startupRecovery(app.getPath('userData'))
    if (recovered.length) console.log(`[agentdock] Recovered ${recovered.length} interrupted run(s)`)
  } catch (error) {
    console.error('[agentdock] Startup recovery failed:', error && error.message ? error.message : error)
  }
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
  if (browserMcpReady || browserManager.isVisible() || delegateServers.size > 0) {
    event.preventDefault()
    try { browserAutomation.detach() } catch {}
    try { await browserManager.destroy() } catch {}
    try { await browserMcp.stop() } catch {}
    for (const [, server] of delegateServers) { try { await server.stop() } catch {} }
    delegateServers.clear()
    browserMcpReady = false
    app.quit()
  }
})
