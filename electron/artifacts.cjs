const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const ARTIFACTS_VERSION = 3
const MANIFEST_VERSION = 1

const ARTIFACT_KINDS = ['run', 'plan', 'council', 'race', 'delegate']

const REQUIRED_FILES_BY_KIND = {
  run: ['final/receipt.json', 'final/patch.diff', 'final/summary.md', 'events.jsonl', 'manifest.json'],
  plan: ['final/receipt.json', 'final/plan.md', 'final/summary.md', 'events.jsonl', 'manifest.json'],
  council: ['final/receipt.json', 'final/summary.md', 'events.jsonl', 'manifest.json'],
  race: ['final/receipt.json', 'arbitration/decision.yaml', 'manifest.json'],
  delegate: ['final/receipt.json', 'final/patch.diff', 'final/summary.md', 'events.jsonl', 'manifest.json'],
}

const CONTENT_TYPES = {
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.md': 'text/markdown',
  '.diff': 'text/x-diff',
  '.yaml': 'application/x-yaml',
  '.log': 'text/plain',
}

function runsDir(userData) {
  return path.join(userData, 'runs')
}

function runDir(userData, runId) {
  return path.join(runsDir(userData), runId)
}

function ensureRunDir(userData, runId) {
  const dir = runDir(userData, runId)
  fs.mkdirSync(path.join(dir, 'final'), { recursive: true })
  return dir
}

function contentTypeFor(filename) {
  const ext = path.extname(filename)
  return CONTENT_TYPES[ext] || 'application/octet-stream'
}

function fileHash(filePath) {
  try {
    const content = fs.readFileSync(filePath)
    return crypto.createHash('sha256').update(content).digest('hex')
  } catch {
    return null
  }
}

function atomicWrite(filePath, content, encoding = 'utf8') {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.agentdock-tmp-${crypto.randomUUID().slice(0, 8)}`)
  fs.writeFileSync(tmp, content, encoding)
  try { fs.fsyncSync(fs.openSync(tmp, 'r')) } catch {}
  fs.renameSync(tmp, filePath)
}

function appendEvents(userData, runId, line) {
  if (!line) return
  try {
    const dir = ensureRunDir(userData, runId)
    fs.appendFileSync(path.join(dir, 'events.jsonl'), line.endsWith('\n') ? line : `${line}\n`, 'utf8')
  } catch {}
}

function writePatch(userData, runId, diff) {
  try {
    const dir = ensureRunDir(userData, runId)
    atomicWrite(path.join(dir, 'final', 'patch.diff'), diff || '')
  } catch {}
}

function writeSummary(userData, runId, summary) {
  try {
    const dir = ensureRunDir(userData, runId)
    atomicWrite(path.join(dir, 'final', 'summary.md'), summary || '')
  } catch {}
}

function writePlanArtifact(userData, runId, planText) {
  try {
    const dir = ensureRunDir(userData, runId)
    atomicWrite(path.join(dir, 'final', 'plan.md'), planText || '')
  } catch {}
}

function writeTelemetry(userData, runId, telemetry) {
  try {
    const dir = ensureRunDir(userData, runId)
    const lines = [
      `# Telemetry — run ${runId}`,
      `generated: ${new Date().toISOString()}`,
      '',
      `provider: ${telemetry?.provider || ''}`,
      `model: ${telemetry?.model || ''}`,
      `intent: ${telemetry?.intent || 'agent'}`,
      `outcome: ${telemetry?.outcome || ''}`,
      `exit_code: ${telemetry?.exitCode ?? 'null'}`,
      `started_at: ${telemetry?.startedAt || ''}`,
      `finished_at: ${telemetry?.finishedAt || ''}`,
      '',
    ]
    if (telemetry?.usage) {
      lines.push('## Token usage')
      lines.push(`input_tokens: ${telemetry.usage.inputTokens || 0}`)
      lines.push(`cached_input_tokens: ${telemetry.usage.cachedInputTokens || 0}`)
      lines.push(`output_tokens: ${telemetry.usage.outputTokens || 0}`)
      lines.push(`reasoning_tokens: ${telemetry.usage.reasoningTokens || 0}`)
      lines.push(`total_tokens: ${telemetry.usage.totalTokens || 0}`)
      if (telemetry.usage.contextWindow) lines.push(`context_window: ${telemetry.usage.contextWindow}`)
      lines.push('')
    }
    if (telemetry?.cost) {
      lines.push('## Cost')
      lines.push(`cost_usd: ${telemetry.cost.cost || 0}`)
      lines.push(`cost_type: ${telemetry.cost.type || 'unknown'}`)
      lines.push(`unverifiable: ${telemetry.cost.unverifiable || false}`)
      lines.push('')
    }
    atomicWrite(path.join(dir, 'final', 'telemetry.yaml'), lines.join('\n'))
  } catch {}
}

function writeReceipt(userData, runId, receipt) {
  if (!receipt || typeof receipt !== 'object') return
  try {
    const dir = ensureRunDir(userData, runId)
    atomicWrite(path.join(dir, 'final', 'receipt.json'), JSON.stringify({ version: ARTIFACTS_VERSION, ...receipt }, null, 2))
  } catch {}
}

function normalizeReceipt(value) {
  if (!value || typeof value !== 'object') return null
  return {
    runId: typeof value.runId === 'string' ? value.runId : '',
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : '',
    provider: typeof value.provider === 'string' ? value.provider : '',
    profileId: typeof value.profileId === 'string' ? value.profileId : '',
    mode: typeof value.mode === 'string' ? value.mode : 'run',
    intent: typeof value.intent === 'string' ? value.intent : 'agent',
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
    exitCode: Number.isFinite(value.exitCode) ? value.exitCode : null,
    outcome: typeof value.outcome === 'string' ? value.outcome : 'success',
    filesChanged: Array.isArray(value.filesChanged) ? value.filesChanged.filter((f) => f && typeof f.path === 'string').map((f) => ({ path: String(f.path), additions: Number(f.additions) || 0, deletions: Number(f.deletions) || 0 })) : [],
    usage: value.usage && typeof value.usage === 'object' ? value.usage : null,
    cost: value.cost && typeof value.cost === 'object' ? value.cost : null,
    budget: value.budget && typeof value.budget === 'object' ? value.budget : null,
    warnings: Array.isArray(value.warnings) ? value.warnings : [],
    startedAt: Number.isFinite(value.startedAt) ? value.startedAt : Date.now(),
    finishedAt: Number.isFinite(value.finishedAt) ? value.finishedAt : Date.now(),
    ...(value.baseTreeHash ? { baseTreeHash: String(value.baseTreeHash) } : {}),
    ...(value.cleanupWarning ? { cleanupWarning: String(value.cleanupWarning) } : {}),
    ...(value.recoverablePath ? { recoverablePath: String(value.recoverablePath) } : {}),
    ...(value.parentRunId ? { parentRunId: String(value.parentRunId) } : {}),
    ...(value.kind ? { kind: String(value.kind) } : {}),
    ...(value.planHash ? { planHash: String(value.planHash) } : {}),
  }
}

function readReceipt(userData, runId) {
  try {
    return normalizeReceipt(JSON.parse(fs.readFileSync(path.join(runDir(userData, runId), 'final', 'receipt.json'), 'utf8')))
  } catch {
    return null
  }
}

function listRuns(userData, sessionId) {
  const root = runsDir(userData)
  const entries = []
  try {
    for (const entry of fs.readdirSync(root)) {
      const dir = path.join(root, entry)
      const stat = fs.statSync(dir)
      if (!stat.isDirectory()) continue
      const receipt = readReceipt(userData, entry)
      if (!receipt) continue
      if (sessionId && receipt.sessionId !== sessionId) continue
      entries.push(receipt)
    }
  } catch {}
  return entries.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
}

function readArtifact(userData, runId, relativePath) {
  const runDirectory = runDir(userData, runId)
  const resolved = path.resolve(runDirectory, relativePath)
  if (!resolved.startsWith(runDirectory + path.sep) && resolved !== runDirectory) return null
  if (resolved.includes('..')) return null
  try {
    const stat = fs.lstatSync(resolved)
    if (stat.isSymbolicLink()) return null
    if (!stat.isFile()) return null
    return fs.readFileSync(resolved, 'utf8')
  } catch {
    return null
  }
}

function readArtifactByManifest(userData, runId, relativePath) {
  const manifest = readManifest(userData, runId)
  if (!manifest) return readArtifact(userData, runId, relativePath)
  const normalized = relativePath.replace(/\\/g, '/')
  const entry = manifest.files?.find((f) => f.path === normalized)
  if (!entry) return null
  return readArtifact(userData, runId, relativePath)
}

function listArtifacts(userData, runId) {
  const runDirectory = runDir(userData, runId)
  const manifest = readManifest(userData, runId)
  if (manifest?.files?.length) {
    return manifest.files.map((f) => ({ path: f.path, size: f.size, contentType: f.contentType, hash: f.hash }))
  }
  const results = []
  function walk(dir, relPrefix = '') {
    try {
      for (const entry of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, entry)
        const rel = relPrefix ? `${relPrefix}/${entry}` : entry
        const stat = fs.statSync(fullPath)
        if (stat.isDirectory()) walk(fullPath, rel)
        else if (stat.isFile()) results.push({ path: rel, size: stat.size, contentType: contentTypeFor(entry), hash: fileHash(fullPath) })
      }
    } catch {}
  }
  walk(runDirectory)
  return results
}

function writeManifest(userData, runId, { kind = 'run', extraFiles = [] } = {}) {
  try {
    const dir = ensureRunDir(userData, runId)
    const files = listArtifacts(userData, runId).filter((f) => f.path !== 'manifest.json')
    for (const extra of extraFiles) {
      if (extra && !files.find((f) => f.path === extra.path)) {
        files.push({ path: extra.path, size: extra.size || 0, contentType: extra.contentType || contentTypeFor(extra.path), hash: extra.hash || null })
      }
    }
    const manifest = {
      version: MANIFEST_VERSION,
      runId,
      kind,
      generated: new Date().toISOString(),
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    }
    atomicWrite(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    return manifest
  } catch {
    return null
  }
}

function readManifest(userData, runId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir(userData, runId), 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

function verifyManifestHashes(userData, runId) {
  const manifest = readManifest(userData, runId)
  if (!manifest?.files) return { ok: false, reason: 'no_manifest' }
  const runDirectory = runDir(userData, runId)
  const mismatches = []
  for (const entry of manifest.files) {
    const fullPath = path.join(runDirectory, entry.path.split('/').join(path.sep))
    const resolved = path.resolve(fullPath)
    if (!resolved.startsWith(runDirectory + path.sep) && resolved !== runDirectory) { mismatches.push({ path: entry.path, reason: 'path_escape' }); continue }
    if (!fs.existsSync(resolved)) { mismatches.push({ path: entry.path, reason: 'missing' }); continue }
    const hash = fileHash(resolved)
    if (entry.hash && hash !== entry.hash) mismatches.push({ path: entry.path, reason: 'hash_mismatch', expected: entry.hash, actual: hash })
  }
  return { ok: mismatches.length === 0, mismatches }
}

function recoverEventsJsonl(userData, runId) {
  try {
    const filePath = path.join(runDir(userData, runId), 'events.jsonl')
    if (!fs.existsSync(filePath)) return { ok: true, recovered: false }
    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content.split(/\r?\n/)
    const lastComplete = lines.findIndex((line, i) => i === lines.length - 1 && line === '')
    let completeLines
    if (lines[lines.length - 1] === '') {
      completeLines = lines.slice(0, -1)
    } else {
      const lastValid = lines.reduce((last, line, i) => {
        if (!line) return last
        try { JSON.parse(line); return i } catch { return last }
      }, -1)
      completeLines = lines.slice(0, lastValid + 1)
    }
    const recovered = completeLines.filter(Boolean)
    const validRecovered = recovered.filter((line) => { try { JSON.parse(line); return true } catch { return false } })
    if (validRecovered.length !== recovered.length || (lines.length > 0 && lines[lines.length - 1] !== '' && validRecovered.length < lines.filter(Boolean).length)) {
      atomicWrite(filePath, validRecovered.map((l) => l).join('\n') + (validRecovered.length ? '\n' : ''))
      return { ok: true, recovered: true, lines: validRecovered.length }
    }
    return { ok: true, recovered: false }
  } catch {
    return { ok: false, error: 'recovery_failed' }
  }
}

function startupRecovery(userData) {
  const root = runsDir(userData)
  const recovered = []
  try {
    for (const entry of fs.readdirSync(root)) {
      const dir = path.join(root, entry)
      const stat = fs.statSync(dir)
      if (!stat.isDirectory()) continue
      const receipt = readReceipt(userData, entry)
      if (!receipt) {
        recoverEventsJsonl(userData, entry)
        const manifest = readManifest(userData, entry)
        if (!manifest) {
          writeReceipt(userData, entry, normalizeReceipt({ runId: entry, outcome: 'interrupted', exitCode: -1, startedAt: stat.birthtimeMs || stat.mtimeMs, finishedAt: Date.now(), warnings: ['Run interrupted before receipt was written'] }))
          recovered.push({ runId: entry, status: 'interrupted', reason: 'no_receipt' })
        }
        continue
      }
      if (receipt.outcome === 'success' || receipt.outcome === 'blocked' || receipt.outcome === 'needs_human' || receipt.outcome === 'exhausted_overshoot' || receipt.outcome === 'cost_unverifiable' || receipt.outcome === 'cancelled') continue
      recoverEventsJsonl(userData, entry)
      writeReceipt(userData, entry, normalizeReceipt({ ...receipt, outcome: 'interrupted', warnings: [...(receipt.warnings || []), 'Run interrupted by process exit'] }))
      recovered.push({ runId: entry, status: 'interrupted', reason: 'non_terminal_outcome' })
    }
  } catch {}
  return recovered
}

function workspaceFingerprint(cwd) {
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process')
    execFile('git', ['status', '--porcelain=v1', '-z'], { cwd, windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout = '') => {
      if (error) {
        resolve({ isGit: false, hash: crypto.createHash('sha256').update('').digest('hex').slice(0, 16) })
        return
      }
      resolve({ isGit: true, hash: crypto.createHash('sha256').update(stdout).digest('hex').slice(0, 16) })
    })
  })
}

function buildDiffFromChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) return ''
  const parts = []
  for (const change of changes) {
    if (change.diff) parts.push(change.diff)
    else if (change.path) parts.push(`--- a/${change.path}\n+++ b/${change.path}\n`)
  }
  return parts.join('\n')
}

module.exports = {
  ARTIFACTS_VERSION,
  MANIFEST_VERSION,
  ARTIFACT_KINDS,
  REQUIRED_FILES_BY_KIND,
  runsDir,
  runDir,
  ensureRunDir,
  contentTypeFor,
  fileHash,
  atomicWrite,
  appendEvents,
  writePatch,
  writeSummary,
  writePlanArtifact,
  writeTelemetry,
  writeReceipt,
  normalizeReceipt,
  readReceipt,
  listRuns,
  readArtifact,
  readArtifactByManifest,
  listArtifacts,
  writeManifest,
  readManifest,
  verifyManifestHashes,
  recoverEventsJsonl,
  startupRecovery,
  workspaceFingerprint,
  buildDiffFromChanges,
}