const path = require('node:path')
const fs = require('node:fs')
const { normalizeTokenUsage } = require('./token-usage.cjs')

const DEFAULT_LANE_STATE = { cliSessionId: '', lastPrompt: '', lastExitCode: null, lastRunFailed: false }

function laneKey(provider, profileId) {
  const profile = profileId || 'default'
  return `${provider}:${profile}`
}

function sanitizeComponent(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
}

function laneDir(userData, sessionId, provider, profileId) {
  const profile = profileId || 'default'
  return path.join(userData, 'lanes', sanitizeComponent(sessionId), `${sanitizeComponent(provider)}-${sanitizeComponent(profile)}`)
}

function laneHomePath(userData, sessionId, provider, profileId) {
  return path.join(laneDir(userData, sessionId, provider, profileId), 'home')
}

function ensureLaneDir(userData, sessionId, provider, profileId) {
  const dir = laneDir(userData, sessionId, provider, profileId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function normalizeLaneState(value) {
  if (!value || typeof value !== 'object') return { ...DEFAULT_LANE_STATE }
  const usage = normalizeTokenUsage(value.usage, { legacy: true })
  return {
    cliSessionId: typeof value.cliSessionId === 'string' && value.cliSessionId ? value.cliSessionId : '',
    lastPrompt: typeof value.lastPrompt === 'string' && value.lastPrompt ? value.lastPrompt : '',
    lastExitCode: Number.isFinite(value.lastExitCode) ? value.lastExitCode : null,
    lastRunFailed: typeof value.lastRunFailed === 'boolean' ? value.lastRunFailed : false,
    ...(usage ? { usage } : {}),
  }
}

function normalizeLanes(value) {
  if (!value || typeof value !== 'object') return {}
  const result = {}
  for (const [key, state] of Object.entries(value)) {
    if (typeof key === 'string' && key.includes(':')) result[key] = normalizeLaneState(state)
  }
  return result
}

function getLaneState(lanes, provider, profileId) {
  return normalizeLaneState(lanes[laneKey(provider, profileId)])
}

function setLaneState(lanes, provider, profileId, partial) {
  const key = laneKey(provider, profileId)
  return { ...lanes, [key]: { ...getLaneState(lanes, provider, profileId), ...partial } }
}

function migrateLegacySession(session) {
  if (!session || session.lanes) return session
  const provider = session.provider || 'codex'
  const profileId = session.profileId || ''
  const legacy = {}
  if (typeof session.cliSessionId === 'string' && session.cliSessionId) legacy.cliSessionId = session.cliSessionId
  if (typeof session.lastPrompt === 'string' && session.lastPrompt) legacy.lastPrompt = session.lastPrompt
  if (Number.isFinite(session.lastExitCode)) legacy.lastExitCode = session.lastExitCode
  if (typeof session.lastRunFailed === 'boolean') legacy.lastRunFailed = session.lastRunFailed
  if (!Object.keys(legacy).length) return session
  const lanes = setLaneState({}, provider, profileId, legacy)
  const { cliSessionId, lastPrompt, lastExitCode, lastRunFailed, ...rest } = session
  return { ...rest, lanes }
}

module.exports = {
  DEFAULT_LANE_STATE,
  laneKey,
  laneDir,
  laneHomePath,
  ensureLaneDir,
  normalizeLanes,
  normalizeLaneState,
  getLaneState,
  setLaneState,
  migrateLegacySession,
}