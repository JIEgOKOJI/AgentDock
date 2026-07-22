const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const REPAIR_VERSION = 1

const MAX_ATTEMPTS = 10
const STALL_THRESHOLD = 3

function normalizeRepairConfig(value) {
  if (!value || typeof value !== 'object') return { attempts: 1, untilClean: false }
  const attempts = Number.isFinite(value.attempts) ? Math.max(1, Math.min(MAX_ATTEMPTS, Math.floor(value.attempts))) : 1
  const untilClean = Boolean(value.untilClean)
  return { attempts, untilClean }
}

function buildRepairPrompt(previousPrompt, gateOutput, attemptNumber) {
  const lines = []
  lines.push(`Previous attempt #${attemptNumber - 1} failed gate verification.`)
  lines.push(``)
  lines.push(`The original task was:`)
  lines.push(previousPrompt)
  lines.push(``)
  lines.push(`The verification gate produced this output:`)
  lines.push(``)
  lines.push('```')
  lines.push(String(gateOutput || '').slice(0, 3000))
  lines.push('```')
  lines.push(``)
  lines.push(`Fix the issue so the verification passes. Attempt ${attemptNumber}.`)
  return lines.join('\n')
}

function detectStall(gateOutputs) {
  if (!Array.isArray(gateOutputs) || gateOutputs.length < STALL_THRESHOLD) return false
  const recent = gateOutputs.slice(-STALL_THRESHOLD)
  const normalized = recent.map((output) => String(output || '').trim().replace(/\s+/g, ' ').slice(0, 500))
  const first = normalized[0]
  return normalized.every((item) => item === first)
}

function stallFingerprint(gateOutput, patchHash) {
  const normalizedGate = String(gateOutput || '').trim().replace(/\s+/g, ' ').slice(0, 500)
  return `${normalizedGate}::${String(patchHash || '').slice(0, 16)}`
}

function detectStallByFingerprint(fingerprints) {
  if (!Array.isArray(fingerprints) || fingerprints.length < STALL_THRESHOLD) return false
  const recent = fingerprints.slice(-STALL_THRESHOLD)
  const first = recent[0]
  return recent.every((item) => item === first)
}

function shouldContinue({ attempt, attempts, untilClean, lastGatePassed, lastGateOutput, gateOutputs, cancelled, stallFingerprints, budgetExhausted, protectedTriggered, spawnError }) {
  if (cancelled) return { continue: false, reason: 'cancelled' }
  if (lastGatePassed) return { continue: false, reason: 'success' }
  if (spawnError) return { continue: false, reason: 'spawn_error' }
  if (protectedTriggered) return { continue: false, reason: 'protected_approval_needed' }
  if (budgetExhausted) return { continue: false, reason: 'budget_exhausted' }
  if (untilClean) {
    if (stallFingerprints && detectStallByFingerprint(stallFingerprints)) return { continue: false, reason: 'stall' }
    if (detectStall([...gateOutputs, lastGateOutput])) return { continue: false, reason: 'stall' }
    if (attempt >= MAX_ATTEMPTS) return { continue: false, reason: 'max_attempts' }
    return { continue: true, reason: 'retry' }
  }
  if (attempt >= attempts) return { continue: false, reason: 'max_attempts' }
  return { continue: true, reason: 'retry' }
}

function repairDir(userData, runId) {
  return path.join(userData, 'runs', runId, 'repair')
}

function ensureRepairDir(userData, runId) {
  const dir = repairDir(userData, runId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeAttemptLog(userData, runId, attempts) {
  try {
    ensureRepairDir(userData, runId)
    const lines = attempts.map((a, i) => `--- Attempt ${i + 1} ---\nexit: ${a.exitCode}\ngate: ${a.gateOverall || 'n/a'}\npassed: ${a.gatePassed}\n${a.gateOutput?.slice(0, 2000) || ''}`)
    fs.writeFileSync(path.join(repairDir(userData, runId), 'attempts.log'), lines.join('\n\n'), 'utf8')
  } catch {}
}

function ensureAttemptDir(userData, runId, attemptNumber) {
  const dir = path.join(repairDir(userData, runId), String(attemptNumber))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeAttemptArtifact(userData, runId, attemptNumber, filename, content) {
  if (!content) return
  try {
    const dir = ensureAttemptDir(userData, runId, attemptNumber)
    fs.writeFileSync(path.join(dir, filename), content, 'utf8')
  } catch {}
}

function repairEventPayload(runId, attempt, overall, reason) {
  return {
    type: 'agentdock.repair.attempt',
    runId,
    attempt,
    overall: overall || 'pass',
    reason: reason || 'gate_passed',
    ts: Date.now(),
  }
}

module.exports = {
  REPAIR_VERSION,
  MAX_ATTEMPTS,
  STALL_THRESHOLD,
  normalizeRepairConfig,
  buildRepairPrompt,
  detectStall,
  stallFingerprint,
  detectStallByFingerprint,
  shouldContinue,
  repairDir,
  ensureRepairDir,
  writeAttemptLog,
  ensureAttemptDir,
  writeAttemptArtifact,
  repairEventPayload,
}