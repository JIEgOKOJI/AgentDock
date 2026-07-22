const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const COUNCIL_VERSION = 1

function normalizeCouncilConfig(value) {
  if (!value || typeof value !== 'object') return { enabled: false, providers: [] }
  const providers = Array.isArray(value.providers) ? value.providers.filter((p) => typeof p === 'string' && p) : []
  return { enabled: Boolean(value.enabled || value.council), providers }
}

function councilDir(userData, sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  return path.join(userData, 'lanes', safe, 'context', 'council')
}

function ensureCouncilDir(userData, sessionId) {
  const dir = councilDir(userData, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function draftPath(userData, sessionId, provider) {
  return path.join(councilDir(userData, sessionId), `draft-${provider}.md`)
}

function writeDraft(userData, sessionId, provider, content) {
  if (!content) return null
  try {
    ensureCouncilDir(userData, sessionId)
    const filePath = draftPath(userData, sessionId, provider)
    fs.writeFileSync(filePath, content, 'utf8')
    return filePath
  } catch {
    return null
  }
}

function readDraft(userData, sessionId, provider) {
  try {
    return fs.readFileSync(draftPath(userData, sessionId, provider), 'utf8')
  } catch {
    return null
  }
}

function listDrafts(userData, sessionId) {
  const dir = councilDir(userData, sessionId)
  try {
    return fs.readdirSync(dir)
      .filter((file) => /^draft-.*\.md$/.test(file))
      .map((file) => {
        const provider = file.replace(/^draft-/, '').replace(/\.md$/, '')
        return { provider, path: path.join(dir, file), content: readDraft(userData, sessionId, provider) }
      })
  } catch {
    return []
  }
}

function buildMergePrompt(originalPrompt, draftPaths) {
  const lines = []
  lines.push('You are merging multiple planning drafts into a single unified plan.')
  lines.push('')
  lines.push('The original task was:')
  lines.push(originalPrompt)
  lines.push('')
  lines.push('Multiple agents have drafted plans. Their drafts are available at these file paths:')
  lines.push('')
  for (const p of draftPaths) {
    lines.push(`- ${p}`)
  }
  lines.push('')
  lines.push('Read each draft file, then produce ONE unified plan that:')
  lines.push('1. Incorporates the best ideas from all drafts')
  lines.push('2. Resolves any conflicts between drafts')
  lines.push('3. Is comprehensive and actionable')
  lines.push('4. Ends with a "## Open Questions" section if anything remains ambiguous')
  lines.push('')
  lines.push('Do not mention which draft contributed what. Produce a single coherent plan.')
  return lines.join('\n')
}

function councilEventPayload(sessionId, type, data = {}) {
  return { type: `agentdock.council.${type}`, sessionId, ...data, ts: Date.now() }
}

module.exports = {
  COUNCIL_VERSION,
  normalizeCouncilConfig,
  councilDir,
  ensureCouncilDir,
  draftPath,
  writeDraft,
  readDraft,
  listDrafts,
  buildMergePrompt,
  councilEventPayload,
}