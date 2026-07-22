const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const RACE_VERSION = 2

const PROVIDER_FAMILIES = {
  codex: 'openai',
  claude: 'anthropic',
  opencode: 'openai',
}

const MIN_REVIEW_SCORE = 0
const DEFAULT_MIN_SCORE = 0

function normalizeRaceConfig(value) {
  if (!value || typeof value !== 'object') return { n: 1, review: false, autoAdopt: false, providers: [], reviewers: 2, minScore: DEFAULT_MIN_SCORE }
  const n = Number.isFinite(value.n) ? Math.max(2, Math.min(5, Math.floor(value.n))) : 1
  return {
    n,
    review: Boolean(value.review),
    autoAdopt: Boolean(value.autoAdopt),
    providers: Array.isArray(value.providers) ? value.providers.filter((p) => typeof p === 'string') : [],
    reviewers: Number.isFinite(value.reviewers) ? Math.max(1, Math.min(5, Math.floor(value.reviewers))) : 2,
    minScore: Number.isFinite(value.minScore) ? value.minScore : DEFAULT_MIN_SCORE,
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
    baseTreeHash: typeof value.baseTreeHash === 'string' ? value.baseTreeHash : null,
    exitCode: Number.isFinite(value.exitCode) ? value.exitCode : null,
    patch: typeof value.patch === 'string' ? value.patch : '',
    summary: typeof value.summary === 'string' ? value.summary : '',
    filesChanged: Array.isArray(value.filesChanged) ? value.filesChanged : [],
    gateResult: value.gateResult || null,
    review: value.review || null,
    reviews: Array.isArray(value.reviews) ? value.reviews : [],
    score: Number.isFinite(value.score) ? value.score : 0,
    failClosed: Boolean(value.failClosed),
    spawnError: value.spawnError || null,
  }
}

function scoreCandidate(candidate) {
  if (!candidate) return 0
  let score = 0
  if (candidate.exitCode === 0) score += 10
  if (candidate.gateResult?.testPassed) score += 20
  if (candidate.gateResult?.overall === 'pass') score += 15
  if (candidate.gateResult?.needsApproval) score -= 30
  if (candidate.failClosed) score -= 100
  if (candidate.spawnError) score -= 100
  const reviews = candidate.reviews?.length ? candidate.reviews : (candidate.review ? [candidate.review] : [])
  for (const review of reviews) {
    if (review.verdict === 'approve') score += 25
    if (review.verdict === 'reject') score -= 50
    if (review.verdict === 'needs_work') score += 5
    if (review.quality) score += Math.min(10, Number(review.quality) || 0)
  }
  if (candidate.filesChanged?.length > 0) score += 5
  if (candidate.patch?.length > 0) score += 5
  return score
}

function providerFamily(provider) {
  return PROVIDER_FAMILIES[provider] || provider
}

function distinctReviewFamilies(reviews) {
  if (!Array.isArray(reviews) || !reviews.length) return new Set()
  const families = new Set()
  for (const review of reviews) {
    if (review?.provider && review.verdict) families.add(providerFamily(review.provider))
  }
  return families
}

function isCandidateEligible(candidate, minScore) {
  if (!candidate) return false
  if (candidate.failClosed) return false
  if (candidate.spawnError) return false
  if (candidate.exitCode !== 0) return false
  if (candidate.gateResult?.needsApproval) return false
  if (candidate.gateResult?.overall === 'test_failed') return false
  if (candidate.gateResult?.overall === 'needs_approval') return false
  const score = scoreCandidate(candidate)
  if (Number.isFinite(minScore) && score < minScore) return false
  const reviews = candidate.reviews?.length ? candidate.reviews : (candidate.review ? [candidate.review] : [])
  for (const review of reviews) {
    if (review.verdict === 'reject') return false
  }
  return true
}

function arbitrate(candidates, options = {}) {
  if (!Array.isArray(candidates) || !candidates.length) return { winner: null, scores: [], reason: 'no_candidates' }
  const minScore = Number.isFinite(options.minScore) ? options.minScore : DEFAULT_MIN_SCORE
  const requiredReviewers = Number.isFinite(options.reviewers) ? options.reviewers : 2
  const scored = candidates.map((c) => ({ candidate: normalizeCandidate(c), score: scoreCandidate(c) }))
  const eligible = scored.filter((s) => isCandidateEligible(s.candidate, minScore))
  if (!eligible.length) {
    return {
      winner: null,
      scores: scored.map((s) => ({ candidateId: s.candidate.candidateId, score: s.score, provider: s.candidate.provider })),
      reason: 'no_eligible_candidate',
    }
  }
  if (options.review) {
    const verified = eligible.filter((s) => {
      const reviews = s.candidate.reviews?.length ? s.candidate.reviews : (s.candidate.review ? [s.candidate.review] : [])
      if (reviews.length < requiredReviewers) return false
      const families = distinctReviewFamilies(reviews)
      return families.size >= 2
    })
    if (!verified.length) {
      return {
        winner: null,
        scores: scored.map((s) => ({ candidateId: s.candidate.candidateId, score: s.score, provider: s.candidate.provider })),
        reason: 'unverified_insufficient_reviews',
      }
    }
    eligible.sort((a, b) => b.score - a.score)
    const top = eligible[0]
    const tied = eligible.filter((s) => s.score === top.score)
    if (tied.length > 1) {
      return {
        winner: null,
        scores: scored.map((s) => ({ candidateId: s.candidate.candidateId, score: s.score, provider: s.candidate.provider })),
        reason: 'tie_no_winner',
        tied: tied.map((s) => s.candidate.candidateId),
      }
    }
    return {
      winner: top.candidate,
      scores: scored.map((s) => ({ candidateId: s.candidate.candidateId, score: s.score, provider: s.candidate.provider })),
      reason: 'highest_score',
    }
  }
  eligible.sort((a, b) => b.score - a.score)
  const top = eligible[0]
  const tied = eligible.filter((s) => s.score === top.score)
  if (tied.length > 1) {
    return {
      winner: null,
      scores: scored.map((s) => ({ candidateId: s.candidate.candidateId, score: s.score, provider: s.candidate.provider })),
      reason: 'tie_no_winner',
      tied: tied.map((s) => s.candidate.candidateId),
    }
  }
  return {
    winner: top.candidate,
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

function parseReviewResponse(text, reviewerProvider) {
  if (!text || typeof text !== 'string') return { verdict: 'needs_work', quality: 0, notes: '', provider: reviewerProvider || '' }
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
    provider: reviewerProvider || '',
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
    if (result.tied) lines.push('', `## Tied candidates`, ...result.tied.map((t) => `- ${t}`))
    fs.writeFileSync(path.join(raceDir(userData, raceId), 'decision.yaml'), lines.join('\n'), 'utf8')
  } catch {}
}

function writeReviewArtifact(userData, raceId, candidateId, reviewerProvider, review) {
  if (!review) return
  try {
    const dir = ensureCandidateDir(userData, raceId, candidateId)
    const filename = `review-${reviewerProvider}.yaml`
    const lines = [
      `# Review by ${reviewerProvider}`,
      `generated: ${new Date().toISOString()}`,
      `verdict: ${review.verdict}`,
      `quality: ${review.quality}`,
      `notes: ${review.notes || ''}`,
    ]
    fs.writeFileSync(path.join(dir, filename), lines.join('\n'), 'utf8')
  } catch {}
}

function raceEventPayload(raceId, type, data = {}) {
  return { type: `agentdock.race.${type}`, raceId, ...data, ts: Date.now() }
}

function selectProvidersForRace(n, requestedProviders, installedProviders) {
  const available = installedProviders.filter((p) => !requestedProviders.length || requestedProviders.includes(p))
  if (available.length >= n) return available.slice(0, n)
  return null
}

function selectReviewersForCandidate(candidateProvider, allProviders, requestedProviders, count) {
  const otherProviders = allProviders.filter((p) => p !== candidateProvider && (!requestedProviders.length || requestedProviders.includes(p)))
  const families = new Set()
  const selected = []
  for (const p of otherProviders) {
    const fam = providerFamily(p)
    if (!families.has(fam)) {
      selected.push(p)
      families.add(fam)
    }
    if (selected.length >= count) break
  }
  if (selected.length < count) {
    for (const p of otherProviders) {
      if (!selected.includes(p)) selected.push(p)
      if (selected.length >= count) break
    }
  }
  return selected
}

module.exports = {
  RACE_VERSION,
  PROVIDER_FAMILIES,
  normalizeRaceConfig,
  raceDir,
  ensureRaceDir,
  candidateDir,
  ensureCandidateDir,
  writeCandidateArtifact,
  readCandidateArtifact,
  normalizeCandidate,
  scoreCandidate,
  providerFamily,
  distinctReviewFamilies,
  isCandidateEligible,
  arbitrate,
  buildReviewPrompt,
  parseReviewResponse,
  writeArbitrationResult,
  writeReviewArtifact,
  raceEventPayload,
  selectProvidersForRace,
  selectReviewersForCandidate,
}