const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const PLAN_VERSION = 1

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
    questions.push({ id: crypto.randomUUID().slice(0, 8), kind, text: item.slice(0, 500) })
    if (questions.length >= 20) break
  }
  return questions
}

function classifyPlanReadiness(text, openQuestions) {
  if (!text || typeof text !== 'string') return 'unverified'
  if (openQuestions && openQuestions.length) return 'needs_answers'
  const lower = text.toLowerCase()
  if (/\b(tbd|todo|FIXME|uncertain|unclear|not sure|needs? clarification)\b/i.test(lower) && !/no\s+(open\s+)?questions?/i.test(lower)) return 'needs_answers'
  return 'ready'
}

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16)
}

function writePlanContract(userData, sessionId, planText, answers = []) {
  if (!planText) return null
  try {
    ensurePlanDir(userData, sessionId)
    const hash = contentHash(planText)
    const answerBlock = answers.length
      ? `\n\n## Provided Answers\n\n${answers.map((a) => `- **${a.text}**: ${String(a.value).slice(0, 500)}`).join('\n')}\n`
      : ''
    const content = `# Plan Contract\n\n> hash: ${hash}\n> session: ${sessionId}\n> created: ${new Date().toISOString()}\n\n${planText}${answerBlock}`
    const filePath = planContractPath(userData, sessionId)
    fs.writeFileSync(filePath, content, 'utf8')
    return { hash, path: filePath }
  } catch {
    return null
  }
}

function readPlanContract(userData, sessionId) {
  try {
    const filePath = planContractPath(userData, sessionId)
    const content = fs.readFileSync(filePath, 'utf8')
    const hashMatch = content.match(/^>\s*hash:\s*(\S+)/m)
    const planStart = content.indexOf('\n', content.indexOf('created:'))
    const planText = planStart >= 0 ? content.slice(planStart + 1).trim() : content
    return { hash: hashMatch ? hashMatch[1] : '', path: filePath, content: planText, raw: content }
  } catch {
    return null
  }
}

function verifyPlanHash(userData, sessionId, expectedHash) {
  const contract = readPlanContract(userData, sessionId)
  if (!contract) return false
  return contract.hash === expectedHash
}

module.exports = {
  PLAN_VERSION,
  planDir,
  planContractPath,
  ensurePlanDir,
  planPrefix,
  parseOpenQuestions,
  classifyPlanReadiness,
  contentHash,
  writePlanContract,
  readPlanContract,
  verifyPlanHash,
}