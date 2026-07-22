const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const COUNCIL_VERSION = 2

function normalizeCouncilConfig(value) {
  if (!value || typeof value !== 'object') return { enabled: false, providers: [], budget: null, timeout: null }
  const providers = Array.isArray(value.providers) ? value.providers.filter((p) => typeof p === 'string' && p) : []
  return {
    enabled: Boolean(value.enabled || value.council),
    providers,
    budget: Number.isFinite(value.budget) ? value.budget : null,
    timeout: Number.isFinite(value.timeout) ? value.timeout : null,
  }
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

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16)
}

function writeDraft(userData, sessionId, provider, content) {
  if (!content) return null
  try {
    ensureCouncilDir(userData, sessionId)
    const filePath = draftPath(userData, sessionId, provider)
    fs.writeFileSync(filePath, content, 'utf8')
    const hash = contentHash(content)
    return { path: filePath, hash, provider, content }
  } catch {
    return null
  }
}

function readDraft(userData, sessionId, provider) {
  try {
    const filePath = draftPath(userData, sessionId, provider)
    const content = fs.readFileSync(filePath, 'utf8')
    return { path: filePath, hash: contentHash(content), provider, content }
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
        return readDraft(userData, sessionId, provider)
      })
      .filter(Boolean)
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

function mergeOpenQuestions(draftQuestions) {
  if (!Array.isArray(draftQuestions)) return []
  const merged = new Map()
  for (const questions of draftQuestions) {
    if (!Array.isArray(questions)) continue
    for (const q of questions) {
      if (!q || typeof q.text !== 'string') continue
      const stableId = q.id || crypto.createHash('sha256').update(q.text).digest('hex').slice(0, 12)
      if (!merged.has(stableId)) {
        merged.set(stableId, { id: stableId, kind: q.kind || 'text', text: q.text, required: q.required !== false, options: q.options || [] })
      } else {
        const existing = merged.get(stableId)
        if (existing.kind === 'text' && q.kind && q.kind !== 'text') existing.kind = q.kind
        if (q.options?.length && (!existing.options || existing.options.length < q.options.length)) existing.options = q.options
      }
    }
  }
  return [...merged.values()]
}

function councilEventPayload(sessionId, type, data = {}) {
  return { type: `agentdock.council.${type}`, sessionId, ...data, ts: Date.now() }
}

function selectCouncilProviders(configuredProviders, installedProviders) {
  const available = installedProviders.filter((p) => !configuredProviders.length || configuredProviders.includes(p))
  if (available.length < 2) return { providers: null, partial: [], missing: configuredProviders.filter((p) => !available.includes(p)) }
  return { providers: available, partial: available, missing: [] }
}

module.exports = {
  COUNCIL_VERSION,
  normalizeCouncilConfig,
  councilDir,
  ensureCouncilDir,
  draftPath,
  contentHash,
  writeDraft,
  readDraft,
  listDrafts,
  buildMergePrompt,
  mergeOpenQuestions,
  councilEventPayload,
  selectCouncilProviders,
}