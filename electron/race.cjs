const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const RACE_VERSION = 1

function normalizeRaceConfig(value) {
  if (!value || typeof value !== 'object') return { n: 1, review: false, autoAdopt: false }
  const n = Number.isFinite(value.n) ? Math.max(2, Math.min(5, Math.floor(value.n))) : 1
  return {
    n,
    review: Boolean(value.review),
    autoAdopt: Boolean(value.autoAdopt),
    providers: Array.isArray(value.providers) ? value.providers.filter((p) => typeof p === 'string') : [],
  }
}

function raceDir(userData, raceId) {
  return path.join(userData, 'runs', raceId, 'race')
}

function ensureRaceDir(userData, raceId) {
  const dir = raceDir(userData, raceId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function candidateDir(userData, raceId, candidateId) {
  return path.join(raceDir(userData, raceId), 'candidates', candidateId)
}

function ensureCandidateDir(userData, raceId, candidateId) {
  const dir = candidateDir(userData, raceId, candidateId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeCandidateArtifact(userData, raceId, candidateId, filename, content) {
  if (!content) return
  try {
    const dir = ensureCandidateDir(userData, raceId, candidateId)
    fs.writeFileSync(path.join(dir, filename), content, 'utf8')
  } catch {}
}

function readCandidateArtifact(userData, raceId, candidateId, filename) {
  try {
    return fs.readFileSync(path.join(candidateDir(userData, raceId, candidateId), filename), 'utf8')
  } catch {
    return null
  }
}

function normalizeCandidate(value) {
  if (!value || typeof value !== 'object') return null
  return {
    candidateId: typeof value.candidateId === 'string' ? value.candidateId : '',
    provider: typeof value.provider === 'string' ? value.provider : '',
    profileId: typeof value.profileId === 'string' ? value.profileId : '',
    runId: typeof value.runId === 'string' ? value.runId : '',
    exitCode: Number.isFinite(value.exitCode) ? value.exitCode : null,
    patch: typeof value.patch === 'string' ? value.patch : '',
    summary: typeof value.summary === 'string' ? value.summary : '',
    filesChanged: Array.isArray(value.filesChanged) ? value.filesChanged : [],
    gateResult: value.gateResult || null,
    review: value.review || null,
    score: Number.isFinite(value.score) ? value.score : 0,
  }
}

function scoreCandidate(candidate) {
  if (!candidate) return 0
  let score = 0
  if (candidate.exitCode === 0) score += 10
  if (candidate.gateResult?.testPassed) score += 20
  if (candidate.gateResult?.overall === 'pass') score += 15
  if (candidate.gateResult?.needsApproval) score -= 30
  if (candidate.review?.verdict === 'approve') score += 25
  if (candidate.review?.verdict === 'reject') score -= 50
  if (candidate.review?.verdict === 'needs_work') score += 5
  if (candidate.filesChanged?.length > 0) score += 5
  if (candidate.patch?.length > 0) score += 5
  if (candidate.review?.quality) score += Math.min(10, Number(candidate.review.quality) || 0)
  return score
}

function arbitrate(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return { winner: null, scores: [], reason: 'no_candidates' }
  const scored = candidates.map((c) => ({ candidate: normalizeCandidate(c), score: scoreCandidate(c) }))
  scored.sort((a, b) => b.score - a.score)
  const winner = scored[0]
  return {
    winner: winner.candidate,
    scores: scored.map((s) => ({ candidateId: s.candidate.candidateId, score: s.score, provider: s.candidate.provider })),
    reason: 'highest_score',
  }
}

function buildReviewPrompt(patch, summary, originalPrompt) {
  const lines = []
  lines.push('You are reviewing a candidate solution for the following task:')
  lines.push('')
  lines.push('--- Task ---')
  lines.push(originalPrompt || '(no task description)')
  lines.push('')
  lines.push('--- Solution summary ---')
  lines.push(summary || '(no summary)')
  lines.push('')
  lines.push('--- Patch ---')
  lines.push('```diff')
  lines.push((patch || '').slice(0, 20000))
  lines.push('```')
  lines.push('')
  lines.push('Evaluate this solution. Respond with:')
  lines.push('- A verdict: approve, reject, or needs_work')
  lines.push('- A quality score from 0 to 10')
  lines.push('- A brief explanation')
  lines.push('')
  lines.push('Format your response as:')
  lines.push('Verdict: <approve|reject|needs_work>')
  lines.push('Quality: <0-10>')
  lines.push('Notes: <explanation>')
  return lines.join('\n')
}

function parseReviewResponse(text) {
  if (!text || typeof text !== 'string') return { verdict: 'needs_work', quality: 0, notes: '' }
  const verdictMatch = text.match(/Verdict:\s*(\w+)/i)
  const qualityMatch = text.match(/Quality:\s*(\d+(?:\.\d+)?)/i)
  const notesMatch = text.match(/Notes:\s*(.+)/is)
  const verdict = verdictMatch ? verdictMatch[1].toLowerCase().trim() : 'needs_work'
  const quality = qualityMatch ? Math.min(10, Math.max(0, parseFloat(qualityMatch[1]))) : 0
  const notes = notesMatch ? notesMatch[1].trim().slice(0, 2000) : ''
  return {
    verdict: ['approve', 'reject', 'needs_work'].includes(verdict) ? verdict : 'needs_work',
    quality,
    notes,
  }
}

function writeArbitrationResult(userData, raceId, result) {
  if (!result || typeof result !== 'object') return
  try {
    ensureRaceDir(userData, raceId)
    const lines = [
      `# Arbitration result — race ${raceId}`,
      `generated: ${new Date().toISOString()}`,
      `reason: ${result.reason}`,
      '',
      `winner: ${result.winner?.candidateId || 'none'}`,
      `winner_provider: ${result.winner?.provider || ''}`,
      `winner_score: ${result.scores?.[0]?.score || 0}`,
      '',
      '## All candidates',
      ...(result.scores || []).map((s) => `- ${s.candidateId} (${s.provider}): ${s.score}`),
    ]
    fs.writeFileSync(path.join(raceDir(userData, raceId), 'decision.yaml'), lines.join('\n'), 'utf8')
  } catch {}
}

function raceEventPayload(raceId, type, data = {}) {
  return { type: `agentdock.race.${type}`, raceId, ...data, ts: Date.now() }
}

function selectProvidersForRace(n, requestedProviders, installedProviders) {
  const available = installedProviders.filter((p) => !requestedProviders.length || requestedProviders.includes(p))
  if (available.length >= n) return available.slice(0, n)
  const result = [...available]
  while (result.length < n) {
    result.push(available[result.length % available.length] || 'codex')
  }
  return result.slice(0, n)
}

module.exports = {
  RACE_VERSION,
  normalizeRaceConfig,
  raceDir,
  ensureRaceDir,
  candidateDir,
  ensureCandidateDir,
  writeCandidateArtifact,
  readCandidateArtifact,
  normalizeCandidate,
  scoreCandidate,
  arbitrate,
  buildReviewPrompt,
  parseReviewResponse,
  writeArbitrationResult,
  raceEventPayload,
  selectProvidersForRace,
}