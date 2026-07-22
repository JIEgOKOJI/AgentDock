const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const PLAN_VERSION = 2

const OPEN_QUESTIONS_SCHEMA_VERSION = 1

function planDir(userData, sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  return path.join(userData, 'lanes', safe, 'context')
}

function planContractPath(userData, sessionId) {
  return path.join(planDir(userData, sessionId), 'PLAN.md')
}

function ensurePlanDir(userData, sessionId) {
  const dir = planDir(userData, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function planPrefix(intent) {
  if (intent === 'plan') return 'Plan, do not implement. Produce a detailed plan with clear steps. End your response with a "## Open Questions" section if anything is ambiguous.\n\n'
  if (intent === 'ask') return 'Answer the question. Do not modify any files.\n\n'
  return ''
}

function parseOpenQuestions(text) {
  if (!text || typeof text !== 'string') return []
  const match = text.match(/^##\s+Open\s+Questions\s*$/im)
  if (!match) return []
  const block = text.slice(match.index + match[0].length).trim()
  const questions = []
  const seen = new Set()
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^#{1,6}\s/.test(trimmed)) break
    const item = trimmed.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '')
    if (!item || seen.has(item)) continue
    seen.add(item)
    const lower = item.toLowerCase()
    let kind = 'text'
    if (/\b(yes|no|true|false)\b/.test(lower) && item.length < 80) kind = 'single'
    else if (/\bor\b/i.test(item) && item.split(/\bor\b/i).length >= 3) kind = 'single'
    else if (item.includes(',') && item.split(',').length >= 3) kind = 'multi'
    const stableId = crypto.createHash('sha256').update(item).digest('hex').slice(0, 12)
    questions.push({ id: stableId, kind, text: item.slice(0, 500), required: true, options: kind === 'single' ? extractOptions(item) : kind === 'multi' ? extractOptions(item) : [] })
    if (questions.length >= 20) break
  }
  return questions
}

function extractOptions(text) {
  const orParts = text.split(/\bor\b/i)
  if (orParts.length >= 2) return orParts.map((p) => p.trim()).filter(Boolean).slice(0, 10)
  const commaParts = text.split(',')
  if (commaParts.length >= 3) return commaParts.map((p) => p.trim()).filter(Boolean).slice(0, 10)
  return []
}

function normalizeOpenQuestion(value) {
  if (!value || typeof value !== 'object') return null
  const text = typeof value.text === 'string' ? value.text : ''
  if (!text) return null
  const kind = ['single', 'multi', 'text'].includes(value.kind) ? value.kind : 'text'
  const stableId = typeof value.id === 'string' && value.id ? value.id : crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)
  const answerValue = typeof value.value === 'string' ? value.value : typeof value.answer === 'string' ? value.answer : ''
  return {
    id: stableId,
    kind,
    text: text.slice(0, 500),
    required: Boolean(value.required) !== false,
    options: Array.isArray(value.options) ? value.options.filter((o) => typeof o === 'string').map((o) => o.slice(0, 200)).slice(0, 10) : [],
    ...(answerValue ? { value: answerValue } : {}),
  }
}

function normalizeOpenQuestions(value) {
  if (!Array.isArray(value)) return []
  return value.map(normalizeOpenQuestion).filter(Boolean)
}

function classifyPlanReadiness(text, openQuestions) {
  if (!text || typeof text !== 'string') return 'unverified'
  if (openQuestions && openQuestions.length) {
    const hasUnanswered = openQuestions.some((q) => q.required && !(q.answer || q.value))
    if (hasUnanswered) return 'needs_answers'
  }
  const lower = text.toLowerCase()
  if (/\b(tbd|todo|FIXME|uncertain|unclear|not sure|needs? clarification)\b/i.test(lower) && !/no\s+(open\s+)?questions?/i.test(lower)) return 'needs_answers'
  return 'ready'
}

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16)
}

function answersHash(planText, answers) {
  const answerStr = Array.isArray(answers) ? answers.map((a) => `${a.text || ''}=${a.value || a.answer || ''}`).join('\n') : ''
  return crypto.createHash('sha256').update(String(planText || '') + '\n---ANSWERS---\n' + answerStr).digest('hex').slice(0, 16)
}

function writePlanContract(userData, sessionId, planText, answers = []) {
  if (!planText) return null
  try {
    ensurePlanDir(userData, sessionId)
    const trimmedPlan = String(planText).trim()
    const hash = contentHash(trimmedPlan)
    const normalizedAnswers = normalizeOpenQuestions(answers)
    const aHash = answersHash(trimmedPlan, normalizedAnswers)
    const answerBlock = normalizedAnswers.length
      ? `\n\n## Provided Answers\n\n${normalizedAnswers.map((a) => `- **${a.text}**: ${String(a.value || '').slice(0, 500)}`).join('\n')}\n`
      : ''
    const content = `# Plan Contract\n\n> hash: ${hash}\n> answers_hash: ${aHash}\n> session: ${sessionId}\n> created: ${new Date().toISOString()}\n> schema_version: ${OPEN_QUESTIONS_SCHEMA_VERSION}\n\n${trimmedPlan}${answerBlock}`
    const filePath = planContractPath(userData, sessionId)
    fs.writeFileSync(filePath, content, 'utf8')
    return { hash, answersHash: aHash, path: filePath }
  } catch {
    return null
  }
}

function readPlanContract(userData, sessionId) {
  try {
    const filePath = planContractPath(userData, sessionId)
    const content = fs.readFileSync(filePath, 'utf8')
    const hashMatch = content.match(/^>\s*hash:\s*(\S+)/m)
    const answersHashMatch = content.match(/^>\s*answers_hash:\s*(\S+)/m)
    const lines = content.split(/\r?\n/)
    let planStart = 0
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('> ')) continue
      if (lines[i].trim() === '' && i > 0 && lines[i - 1].startsWith('> ')) { planStart = i + 1; break }
      if (lines[i].startsWith('# ')) continue
      if (!lines[i].startsWith('>') && lines[i].trim()) { planStart = i; break }
    }
    const planText = lines.slice(planStart).join('\n').replace(/^\s+/, '')
    const planOnly = planText.split('\n\n## Provided Answers')[0].trim()
    return { hash: hashMatch ? hashMatch[1] : '', answersHash: answersHashMatch ? answersHashMatch[1] : '', path: filePath, content: planOnly, raw: content }
  } catch {
    return null
  }
}

function verifyPlanHash(userData, sessionId, expectedHash) {
  const contract = readPlanContract(userData, sessionId)
  if (!contract) return false
  const recomputed = contentHash(contract.content)
  return recomputed === expectedHash
}

function verifyPlanContentHash(userData, sessionId) {
  const contract = readPlanContract(userData, sessionId)
  if (!contract) return { ok: false, reason: 'no_contract' }
  const recomputed = contentHash(contract.content)
  return { ok: recomputed === contract.hash, recomputed, stored: contract.hash }
}

module.exports = {
  PLAN_VERSION,
  OPEN_QUESTIONS_SCHEMA_VERSION,
  planDir,
  planContractPath,
  ensurePlanDir,
  planPrefix,
  parseOpenQuestions,
  normalizeOpenQuestion,
  normalizeOpenQuestions,
  extractOptions,
  classifyPlanReadiness,
  contentHash,
  answersHash,
  writePlanContract,
  readPlanContract,
  verifyPlanHash,
  verifyPlanContentHash,
}