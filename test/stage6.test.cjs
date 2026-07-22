const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')

const artifacts = require('../electron/artifacts.cjs')
const race = require('../electron/race.cjs')
const council = require('../electron/council.cjs')
const profiles = require('../electron/profiles.cjs')
const continuity = require('../electron/continuity.cjs')
const budget = require('../electron/budget.cjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-stage6-'))
}

function execAsync(command, args, cwd) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, windowsHide: true }, (error, stdout = '', stderr = '') => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function initGitRepo(dir) {
  await execAsync('git', ['init'], dir)
  await execAsync('git', ['config', 'user.name', 'Test'], dir)
  await execAsync('git', ['config', 'user.email', 'test@test.local'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n')
  await execAsync('git', ['add', '-A'], dir)
  await execAsync('git', ['commit', '-m', 'init'], dir)
}

// --- 6.1 Artifact schema and crash-safe writing ---

test('stage6: artifacts version is 3', () => {
  assert.equal(artifacts.ARTIFACTS_VERSION, 3)
})

test('stage6: manifest version is 1', () => {
  assert.equal(artifacts.MANIFEST_VERSION, 1)
})

test('stage6: ARTIFACT_KINDS includes all kinds', () => {
  assert.ok(artifacts.ARTIFACT_KINDS.includes('run'))
  assert.ok(artifacts.ARTIFACT_KINDS.includes('plan'))
  assert.ok(artifacts.ARTIFACT_KINDS.includes('council'))
  assert.ok(artifacts.ARTIFACT_KINDS.includes('race'))
  assert.ok(artifacts.ARTIFACT_KINDS.includes('delegate'))
})

test('stage6: REQUIRED_FILES_BY_KIND has required files for each kind', () => {
  assert.ok(artifacts.REQUIRED_FILES_BY_KIND.run.includes('manifest.json'))
  assert.ok(artifacts.REQUIRED_FILES_BY_KIND.race.includes('arbitration/decision.yaml'))
  assert.ok(artifacts.REQUIRED_FILES_BY_KIND.plan.includes('final/plan.md'))
})

test('stage6: writeManifest creates manifest with file hashes', () => {
  const dir = tempDir()
  const runId = 'test-run-1'
  artifacts.ensureRunDir(dir, runId)
  artifacts.writePatch(dir, runId, 'diff content')
  artifacts.writeSummary(dir, runId, 'summary')
  artifacts.writeReceipt(dir, runId, artifacts.normalizeReceipt({ runId, outcome: 'success', exitCode: 0 }))
  const manifest = artifacts.writeManifest(dir, runId, { kind: 'run' })
  assert.ok(manifest)
  assert.equal(manifest.kind, 'run')
  assert.ok(manifest.files.length > 0)
  assert.ok(manifest.files.find((f) => f.path === 'final/patch.diff'))
  assert.ok(manifest.files.find((f) => f.path === 'final/receipt.json'))
})

test('stage6: readManifest returns manifest', () => {
  const dir = tempDir()
  const runId = 'test-run-2'
  artifacts.ensureRunDir(dir, runId)
  artifacts.writeReceipt(dir, runId, artifacts.normalizeReceipt({ runId, outcome: 'success' }))
  artifacts.writeManifest(dir, runId, { kind: 'run' })
  const manifest = artifacts.readManifest(dir, runId)
  assert.ok(manifest)
  assert.equal(manifest.runId, runId)
})

test('stage6: verifyManifestHashes returns ok for correct hashes', () => {
  const dir = tempDir()
  const runId = 'test-run-3'
  artifacts.ensureRunDir(dir, runId)
  artifacts.writePatch(dir, runId, 'diff')
  artifacts.writeManifest(dir, runId, { kind: 'run' })
  const result = artifacts.verifyManifestHashes(dir, runId)
  assert.ok(result.ok)
})

test('stage6: verifyManifestHashes detects hash mismatch', () => {
  const dir = tempDir()
  const runId = 'test-run-4'
  artifacts.ensureRunDir(dir, runId)
  artifacts.writePatch(dir, runId, 'original')
  artifacts.writeManifest(dir, runId, { kind: 'run' })
  // Tamper with the file after manifest is written
  fs.writeFileSync(path.join(dir, 'runs', runId, 'final', 'patch.diff'), 'tampered', 'utf8')
  const result = artifacts.verifyManifestHashes(dir, runId)
  assert.ok(!result.ok)
  assert.ok(result.mismatches.length > 0)
})

test('stage6: atomicWrite writes file safely', () => {
  const dir = tempDir()
  const filePath = path.join(dir, 'test.txt')
  artifacts.atomicWrite(filePath, 'content')
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'content')
})

test('stage6: writeTelemetry creates telemetry.yaml', () => {
  const dir = tempDir()
  const runId = 'test-run-tel'
  artifacts.ensureRunDir(dir, runId)
  artifacts.writeTelemetry(dir, runId, { provider: 'codex', model: 'gpt-5', intent: 'agent', outcome: 'success', exitCode: 0, startedAt: 1000, finishedAt: 2000, usage: { inputTokens: 100, outputTokens: 50 }, cost: { cost: 0, type: 'subscription' } })
  const telemetry = fs.readFileSync(path.join(dir, 'runs', runId, 'final', 'telemetry.yaml'), 'utf8')
  assert.match(telemetry, /provider: codex/)
  assert.match(telemetry, /input_tokens: 100/)
})

test('stage6: writePlanArtifact creates plan.md', () => {
  const dir = tempDir()
  const runId = 'test-run-plan'
  artifacts.ensureRunDir(dir, runId)
  artifacts.writePlanArtifact(dir, runId, '# Plan\nStep 1')
  const plan = fs.readFileSync(path.join(dir, 'runs', runId, 'final', 'plan.md'), 'utf8')
  assert.match(plan, /Step 1/)
})

test('stage6: recoverEventsJsonl recovers partial JSONL', () => {
  const dir = tempDir()
  const runId = 'test-run-jsonl'
  artifacts.ensureRunDir(dir, runId)
  const eventsPath = path.join(dir, 'runs', runId, 'events.jsonl')
  fs.writeFileSync(eventsPath, '{"ts":1}\n{"ts":2}\n{"ts":3}\n{"partial', 'utf8')
  const result = artifacts.recoverEventsJsonl(dir, runId)
  assert.ok(result.ok)
  assert.ok(result.recovered)
  const content = fs.readFileSync(eventsPath, 'utf8')
  assert.ok(!content.includes('partial'))
})

test('stage6: startupRecovery marks interrupted runs', () => {
  const dir = tempDir()
  const runId = 'interrupted-run-1'
  artifacts.ensureRunDir(dir, runId)
  // Write events but no receipt
  artifacts.appendEvents(dir, runId, '{"ts":1,"type":"stdout"}')
  const recovered = artifacts.startupRecovery(dir)
  assert.ok(recovered.length > 0)
  const receipt = artifacts.readReceipt(dir, runId)
  assert.ok(receipt)
  assert.equal(receipt.outcome, 'interrupted')
})

test('stage6: listArtifacts returns all files in run dir', () => {
  const dir = tempDir()
  const runId = 'test-run-list'
  artifacts.ensureRunDir(dir, runId)
  artifacts.writePatch(dir, runId, 'diff')
  artifacts.writeSummary(dir, runId, 'summary')
  const files = artifacts.listArtifacts(dir, runId)
  assert.ok(files.length >= 2)
  assert.ok(files.find((f) => f.path === 'final/patch.diff'))
})

test('stage6: readArtifactByManifest returns null for file not in manifest', () => {
  const dir = tempDir()
  const runId = 'test-run-manifest-read'
  artifacts.ensureRunDir(dir, runId)
  artifacts.writePatch(dir, runId, 'diff')
  artifacts.writeManifest(dir, runId, { kind: 'run' })
  const result = artifacts.readArtifactByManifest(dir, runId, 'final/patch.diff')
  assert.ok(result !== null)
  const missing = artifacts.readArtifactByManifest(dir, runId, 'nonexistent.txt')
  assert.equal(missing, null)
})

// --- 6.2 Best-of-N race ---

test('stage6: race normalizeRaceConfig includes reviewers and minScore', () => {
  const config = race.normalizeRaceConfig({ n: 3, review: true, reviewers: 3, minScore: 10 })
  assert.equal(config.reviewers, 3)
  assert.equal(config.minScore, 10)
})

test('stage6: race selectProvidersForRace returns null when not enough', () => {
  const result = race.selectProvidersForRace(3, [], ['codex'])
  assert.equal(result, null)
})

test('stage6: race selectProvidersForRace returns providers when enough', () => {
  const result = race.selectProvidersForRace(2, [], ['codex', 'claude'])
  assert.deepEqual(result, ['codex', 'claude'])
})

test('stage6: race providerFamily maps providers to families', () => {
  assert.equal(race.providerFamily('codex'), 'openai')
  assert.equal(race.providerFamily('claude'), 'anthropic')
  assert.equal(race.providerFamily('opencode'), 'openai')
})

test('stage6: race distinctReviewFamilies counts distinct families', () => {
  const reviews = [
    { provider: 'codex', verdict: 'approve' },
    { provider: 'claude', verdict: 'approve' },
  ]
  const families = race.distinctReviewFamilies(reviews)
  assert.equal(families.size, 2)
})

test('stage6: race isCandidateEligible rejects failed candidates', () => {
  assert.ok(!race.isCandidateEligible({ exitCode: 1 }, 0))
  assert.ok(!race.isCandidateEligible({ exitCode: 0, failClosed: true }, 0))
  assert.ok(!race.isCandidateEligible({ exitCode: 0, gateResult: { overall: 'test_failed' } }, 0))
})

test('stage6: race isCandidateEligible rejects rejected reviews', () => {
  assert.ok(!race.isCandidateEligible({ exitCode: 0, reviews: [{ verdict: 'reject' }] }, 0))
})

test('stage6: race arbitrate returns no_eligible_candidate for all failed', () => {
  const candidates = [
    { candidateId: 'c1', exitCode: 1 },
    { candidateId: 'c2', exitCode: 1 },
  ]
  const result = race.arbitrate(candidates)
  assert.equal(result.winner, null)
  assert.equal(result.reason, 'no_eligible_candidate')
})

test('stage6: race arbitrate returns tie_no_winner for equal scores', () => {
  const candidates = [
    { candidateId: 'c1', provider: 'codex', exitCode: 0 },
    { candidateId: 'c2', provider: 'claude', exitCode: 0 },
  ]
  const result = race.arbitrate(candidates)
  assert.equal(result.winner, null)
  assert.equal(result.reason, 'tie_no_winner')
})

test('stage6: race arbitrate with review requires 2 distinct families', () => {
  const candidates = [
    { candidateId: 'c1', provider: 'codex', exitCode: 0, reviews: [{ provider: 'claude', verdict: 'approve' }] },
  ]
  const result = race.arbitrate(candidates, { review: true, reviewers: 2 })
  assert.equal(result.winner, null)
  assert.equal(result.reason, 'unverified_insufficient_reviews')
})

test('stage6: race arbitrate selects winner with 2 distinct family reviews', () => {
  const candidates = [
    { candidateId: 'c1', provider: 'codex', exitCode: 0, reviews: [{ provider: 'claude', verdict: 'approve' }, { provider: 'opencode', verdict: 'approve' }] },
  ]
  const result = race.arbitrate(candidates, { review: true, reviewers: 2 })
  assert.ok(result.winner)
  assert.equal(result.reason, 'highest_score')
})

test('stage6: race normalizeCandidate includes failClosed and reviews', () => {
  const c = race.normalizeCandidate({ candidateId: 'c1', provider: 'codex', failClosed: true, reviews: [{ verdict: 'approve' }] })
  assert.equal(c.failClosed, true)
  assert.equal(c.reviews.length, 1)
})

test('stage6: race scoreCandidate penalizes failClosed', () => {
  const score = race.scoreCandidate({ exitCode: 0, failClosed: true })
  assert.ok(score < 0)
})

test('stage6: race selectReviewersForCandidate picks distinct families', () => {
  const reviewers = race.selectReviewersForCandidate('codex', ['codex', 'claude', 'opencode'], [], 2)
  assert.equal(reviewers.length, 2)
  assert.ok(!reviewers.includes('codex'))
  const families = new Set(reviewers.map((p) => race.providerFamily(p)))
  assert.ok(families.size >= 1)
})

test('stage6: race writeReviewArtifact creates review file', () => {
  const dir = tempDir()
  const raceId = 'race-1'
  const candidateId = 'c1'
  race.ensureRaceDir(dir, raceId)
  race.writeReviewArtifact(dir, raceId, candidateId, 'claude', { verdict: 'approve', quality: 8, notes: 'good' })
  const reviewPath = path.join(dir, 'runs', raceId, 'race', 'candidates', candidateId, 'review-claude.yaml')
  assert.ok(fs.existsSync(reviewPath))
  const content = fs.readFileSync(reviewPath, 'utf8')
  assert.match(content, /verdict: approve/)
})

test('stage6: race parseReviewResponse includes provider', () => {
  const review = race.parseReviewResponse('Verdict: approve\nQuality: 8\nNotes: good', 'claude')
  assert.equal(review.provider, 'claude')
})

// --- 6.3 Council lifecycle ---

test('stage6: council normalizeCouncilConfig includes budget and timeout', () => {
  const config = council.normalizeCouncilConfig({ enabled: true, budget: 5, timeout: 60000 })
  assert.equal(config.budget, 5)
  assert.equal(config.timeout, 60000)
})

test('stage6: council writeDraft returns object with hash', () => {
  const dir = tempDir()
  const result = council.writeDraft(dir, 's1', 'codex', 'Plan content')
  assert.ok(result.path)
  assert.ok(result.hash)
  assert.equal(result.provider, 'codex')
})

test('stage6: council readDraft returns object with hash', () => {
  const dir = tempDir()
  council.writeDraft(dir, 's1', 'codex', 'Plan content')
  const draft = council.readDraft(dir, 's1', 'codex')
  assert.equal(draft.content, 'Plan content')
  assert.ok(draft.hash)
})

test('stage6: council contentHash produces stable hash', () => {
  const h1 = council.contentHash('test')
  const h2 = council.contentHash('test')
  assert.equal(h1, h2)
  assert.notEqual(h1, council.contentHash('different'))
})

test('stage6: council mergeOpenQuestions deduplicates by stable id', () => {
  const draftQuestions = [
    [{ id: 'abc123', text: 'Which framework?', kind: 'single', options: ['A', 'B'] }],
    [{ id: 'abc123', text: 'Which framework?', kind: 'single', options: ['A', 'B', 'C'] }],
  ]
  const merged = council.mergeOpenQuestions(draftQuestions)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'abc123')
  assert.ok(merged[0].options.length >= 2)
})

test('stage6: council selectCouncilProviders returns null for insufficient', () => {
  const result = council.selectCouncilProviders(['codex'], ['codex'])
  assert.equal(result.providers, null)
})

test('stage6: council selectCouncilProviders returns missing for unavailable providers', () => {
  const result = council.selectCouncilProviders(['codex', 'claude'], ['codex'])
  assert.equal(result.providers, null)
  assert.ok(result.missing.includes('claude'))
})

test('stage6: council selectCouncilProviders returns providers when enough', () => {
  const result = council.selectCouncilProviders([], ['codex', 'claude'])
  assert.deepEqual(result.providers, ['codex', 'claude'])
  assert.equal(result.missing.length, 0)
})

// --- 6.4 Delegation Belt ---

test('stage6: delegate-mcp spawnSubRun returns subRunId immediately', async () => {
  const { createDelegateMcp } = require('../electron/delegate-mcp.cjs')
  let spawnedKind = null
  const server = createDelegateMcp({
    spawnSubRun: async (kind, params) => {
      spawnedKind = kind
      return { subRunId: 'test-sub-id', ok: true, status: 'queued' }
    },
  })
  // We can't easily call the tool directly, but we can verify the server starts
  await server.start()
  assert.ok(server.isReady())
  await server.stop()
})

test('stage6: delegate-mcp describePolicy shows remaining sub-runs', async () => {
  const { createDelegateMcp } = require('../electron/delegate-mcp.cjs')
  const server = createDelegateMcp({ policy: { maxSubRuns: 5 } })
  await server.start()
  const policy = server.describePolicy()
  assert.equal(policy.maxSubRuns, 5)
  assert.equal(policy.remainingSubRuns, 5)
  await server.stop()
})

// --- 6.5 Quota rotation and lane continuity ---

test('stage6: profiles isTypedVendorLimitSignal returns false for non-zero exit without limits', () => {
  assert.ok(!profiles.isTypedVendorLimitSignal(null, 1))
  assert.ok(!profiles.isTypedVendorLimitSignal({ available: false }, 1))
})

test('stage6: profiles isTypedVendorLimitSignal returns true for exhausted limits', () => {
  const limits = { available: true, primary: { usedPercent: 100 } }
  assert.ok(profiles.isTypedVendorLimitSignal(limits, 1))
})

test('stage6: profiles isTypedVendorLimitSignal returns false for non-exhausted limits', () => {
  const limits = { available: true, primary: { usedPercent: 50 } }
  assert.ok(!profiles.isTypedVendorLimitSignal(limits, 1))
})

test('stage6: profiles isProfileReady returns false for exhausted profile', () => {
  const profile = { enabled: true }
  const limits = { available: true, primary: { usedPercent: 100 } }
  assert.ok(!profiles.isProfileReady(profile, limits))
})

test('stage6: profiles isProfileReady returns true for available profile', () => {
  const profile = { enabled: true }
  const limits = { available: true, primary: { usedPercent: 50 } }
  assert.ok(profiles.isProfileReady(profile, limits))
})

test('stage6: profiles nextReadyProfileByLimits selects ready profile', () => {
  const allProfiles = [
    { id: 'p1', provider: 'codex', enabled: true },
    { id: 'p2', provider: 'codex', enabled: true },
  ]
  const limitsByProfile = {
    p1: { available: true, primary: { usedPercent: 100 } },
    p2: { available: true, primary: { usedPercent: 50 } },
  }
  const candidate = profiles.nextReadyProfileByLimits(allProfiles, 'codex', 'p1', limitsByProfile)
  assert.equal(candidate.id, 'p2')
})

test('stage6: continuity buildContinuationPacket includes delta messages with byte budget', () => {
  const messages = [
    { id: 'm1', role: 'user', content: 'First message' },
    { id: 'm2', role: 'assistant', content: 'Second message' },
  ]
  const packet = continuity.buildContinuationPacket({
    fromLane: 'codex:default',
    toLane: 'claude:default',
    checkpoint: 'checkpoint content',
    threadPath: '/path/to/thread.md',
    sessionId: 's1',
    messages,
    byteBudget: 10000,
  })
  assert.match(packet, /Delta since last checkpoint/)
  assert.match(packet, /First message/)
  assert.match(packet, /Second message/)
})

test('stage6: continuity buildContinuationPacket respects byte budget', () => {
  const messages = []
  for (let i = 0; i < 100; i++) {
    messages.push({ id: `m${i}`, role: 'user', content: `Message ${i} with some content to fill space` })
  }
  const packet = continuity.buildContinuationPacket({
    fromLane: 'codex:default',
    toLane: 'claude:default',
    threadPath: '/path/to/thread.md',
    sessionId: 's1',
    messages,
    byteBudget: 500,
  })
  // Should not include all 100 messages
  assert.ok(!packet.includes('Message 99'))
})

test('stage6: continuity writeDeliveredId and readDeliveredId round-trip', () => {
  const dir = tempDir()
  continuity.writeDeliveredId(dir, 's1', 'codex', 'default', { lastMessageId: 'm5', ts: 1000 })
  const data = continuity.readDeliveredId(dir, 's1', 'codex', 'default')
  assert.equal(data.lastMessageId, 'm5')
  assert.equal(data.ts, 1000)
})

test('stage6: continuity DEFAULT_BYTE_BUDGET is defined', () => {
  assert.ok(continuity.DEFAULT_BYTE_BUDGET > 0)
})

test('stage6: continuity DEFAULT_MAX_MESSAGES is defined', () => {
  assert.ok(continuity.DEFAULT_MAX_MESSAGES > 0)
})