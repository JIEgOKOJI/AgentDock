const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const race = require('../electron/race.cjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-race-'))
}

test('race: normalizeRaceConfig defaults to n=1', () => {
  const config = race.normalizeRaceConfig({})
  assert.equal(config.n, 1)
  assert.equal(config.review, false)
  assert.equal(config.autoAdopt, false)
})

test('race: normalizeRaceConfig clamps n to 2-5', () => {
  assert.equal(race.normalizeRaceConfig({ n: 1 }).n, 2)
  assert.equal(race.normalizeRaceConfig({ n: 3 }).n, 3)
  assert.equal(race.normalizeRaceConfig({ n: 10 }).n, 5)
})

test('race: normalizeRaceConfig sets review and autoAdopt', () => {
  const config = race.normalizeRaceConfig({ n: 3, review: true, autoAdopt: true })
  assert.equal(config.review, true)
  assert.equal(config.autoAdopt, true)
})

test('race: normalizeCandidate returns null for invalid input', () => {
  assert.equal(race.normalizeCandidate(null), null)
  assert.equal(race.normalizeCandidate('invalid'), null)
})

test('race: normalizeCandidate fills defaults', () => {
  const c = race.normalizeCandidate({ candidateId: 'c1', provider: 'codex' })
  assert.equal(c.candidateId, 'c1')
  assert.equal(c.provider, 'codex')
  assert.equal(c.exitCode, null)
  assert.equal(c.score, 0)
})

test('race: scoreCandidate gives high score for passing candidate', () => {
  const score = race.scoreCandidate({ exitCode: 0, gateResult: { testPassed: true, overall: 'pass', needsApproval: false }, review: { verdict: 'approve', quality: 8 }, filesChanged: [{}], patch: 'diff' })
  assert.ok(score > 50)
})

test('race: scoreCandidate penalizes rejected review', () => {
  const score = race.scoreCandidate({ exitCode: 0, review: { verdict: 'reject', quality: 2 } })
  assert.ok(score < 0)
})

test('race: scoreCandidate penalizes needs_approval', () => {
  const score = race.scoreCandidate({ exitCode: 0, gateResult: { needsApproval: true } })
  assert.ok(score < 0)
})

test('race: arbitrate returns highest scoring candidate as winner', () => {
  const candidates = [
    { candidateId: 'c1', provider: 'codex', exitCode: 0, gateResult: { testPassed: true, overall: 'pass' } },
    { candidateId: 'c2', provider: 'claude', exitCode: 1 },
  ]
  const result = race.arbitrate(candidates)
  assert.equal(result.winner.candidateId, 'c1')
  assert.ok(result.scores[0].score > result.scores[1].score)
})

test('race: arbitrate returns no winner for empty candidates', () => {
  const result = race.arbitrate([])
  assert.equal(result.winner, null)
  assert.equal(result.reason, 'no_candidates')
})

test('race: buildReviewPrompt includes task, summary, and patch', () => {
  const prompt = race.buildReviewPrompt('diff content', 'fixed bug', 'Fix the bug')
  assert.match(prompt, /Fix the bug/)
  assert.match(prompt, /fixed bug/)
  assert.match(prompt, /diff content/)
  assert.match(prompt, /Verdict:/)
})

test('race: parseReviewResponse extracts verdict, quality, notes', () => {
  const review = race.parseReviewResponse('Verdict: approve\nQuality: 8.5\nNotes: Good solution, clean code.')
  assert.equal(review.verdict, 'approve')
  assert.equal(review.quality, 8.5)
  assert.match(review.notes, /Good solution/)
})

test('race: parseReviewResponse defaults to needs_work for invalid', () => {
  const review = race.parseReviewResponse('')
  assert.equal(review.verdict, 'needs_work')
  assert.equal(review.quality, 0)
})

test('race: parseReviewResponse clamps quality to 0-10', () => {
  assert.equal(race.parseReviewResponse('Quality: 15').quality, 10)
  assert.equal(race.parseReviewResponse('Quality: -5').quality, 0)
})

test('race: writeCandidateArtifact and readCandidateArtifact round-trip', () => {
  const dir = tempDir()
  race.writeCandidateArtifact(dir, 'race-1', 'c1', 'summary.md', 'Task done')
  const content = race.readCandidateArtifact(dir, 'race-1', 'c1', 'summary.md')
  assert.equal(content, 'Task done')
})

test('race: readCandidateArtifact returns null for missing', () => {
  const dir = tempDir()
  assert.equal(race.readCandidateArtifact(dir, 'race-1', 'c1', 'missing.md'), null)
})

test('race: writeArbitrationResult creates decision.yaml', () => {
  const dir = tempDir()
  race.writeArbitrationResult(dir, 'race-1', {
    raceId: 'race-1',
    reason: 'highest_score',
    winner: { candidateId: 'c1', provider: 'codex' },
    scores: [{ candidateId: 'c1', score: 50, provider: 'codex' }, { candidateId: 'c2', score: 30, provider: 'claude' }],
  })
  const filePath = path.join(dir, 'runs', 'race-1', 'race', 'decision.yaml')
  assert.ok(fs.existsSync(filePath))
  const content = fs.readFileSync(filePath, 'utf8')
  assert.ok(content.includes('c1'))
  assert.ok(content.includes('highest_score'))
})

test('race: raceEventPayload creates typed event', () => {
  const event = race.raceEventPayload('race-1', 'started', { n: 3 })
  assert.equal(event.type, 'agentdock.race.started')
  assert.equal(event.raceId, 'race-1')
  assert.equal(event.n, 3)
})

test('race: selectProvidersForRace returns n providers', () => {
  const result = race.selectProvidersForRace(3, [], ['codex', 'claude', 'opencode'])
  assert.equal(result.length, 3)
})

test('race: selectProvidersForRace respects requested providers', () => {
  const result = race.selectProvidersForRace(2, ['codex', 'claude'], ['codex', 'claude', 'opencode'])
  assert.deepEqual(result, ['codex', 'claude'])
})

test('race: selectProvidersForRace returns null when not enough', () => {
  const result = race.selectProvidersForRace(3, [], ['codex'])
  assert.equal(result, null)
})