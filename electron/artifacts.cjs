const path = require('node:path')
const fs = require('node:fs')

const ARTIFACTS_VERSION = 1

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

function appendEvents(userData, runId, line) {
  if (!line) return
  try {
    const dir = ensureRunDir(userData, runId)
    fs.appendFileSync(path.join(dir, 'events.jsonl'), line.endsWith('\n') ? line : `${line}\n`, 'utf8')
  } catch {}
}

function writePatch(userData, runId, diff) {
  if (!diff) return
  try {
    const dir = ensureRunDir(userData, runId)
    fs.writeFileSync(path.join(dir, 'final', 'patch.diff'), diff, 'utf8')
  } catch {}
}

function writeSummary(userData, runId, summary) {
  if (!summary) return
  try {
    const dir = ensureRunDir(userData, runId)
    fs.writeFileSync(path.join(dir, 'final', 'summary.md'), summary, 'utf8')
  } catch {}
}

function writeReceipt(userData, runId, receipt) {
  if (!receipt || typeof receipt !== 'object') return
  try {
    const dir = ensureRunDir(userData, runId)
    fs.writeFileSync(path.join(dir, 'final', 'receipt.json'), JSON.stringify({ version: ARTIFACTS_VERSION, ...receipt }, null, 2), 'utf8')
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
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
    exitCode: Number.isFinite(value.exitCode) ? value.exitCode : null,
    outcome: typeof value.outcome === 'string' ? value.outcome : 'success',
    filesChanged: Array.isArray(value.filesChanged) ? value.filesChanged.filter((f) => f && typeof f.path === 'string').map((f) => ({ path: String(f.path), additions: Number(f.additions) || 0, deletions: Number(f.deletions) || 0 })) : [],
    usage: value.usage && typeof value.usage === 'object' ? value.usage : null,
    startedAt: Number.isFinite(value.startedAt) ? value.startedAt : Date.now(),
    finishedAt: Number.isFinite(value.finishedAt) ? value.finishedAt : Date.now(),
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
  const allowed = ['events.jsonl', 'final/patch.diff', 'final/summary.md', 'final/receipt.json']
  if (!allowed.includes(relativePath)) return null
  try {
    return fs.readFileSync(path.join(runDir(userData, runId), ...relativePath.split('/')), 'utf8')
  } catch {
    return null
  }
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
  runsDir,
  runDir,
  ensureRunDir,
  appendEvents,
  writePatch,
  writeSummary,
  writeReceipt,
  readReceipt,
  listRuns,
  readArtifact,
  buildDiffFromChanges,
  normalizeReceipt,
}