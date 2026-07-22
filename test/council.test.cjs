const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const council = require('../electron/council.cjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-council-'))
}

test('council: normalizeCouncilConfig defaults to disabled', () => {
  const config = council.normalizeCouncilConfig({})
  assert.equal(config.enabled, false)
  assert.deepEqual(config.providers, [])
})

test('council: normalizeCouncilConfig enabled with providers', () => {
  const config = council.normalizeCouncilConfig({ enabled: true, providers: ['codex', 'claude'] })
  assert.equal(config.enabled, true)
  assert.deepEqual(config.providers, ['codex', 'claude'])
})

test('council: normalizeCouncilConfig accepts council alias', () => {
  const config = council.normalizeCouncilConfig({ council: true })
  assert.equal(config.enabled, true)
})

test('council: writeDraft and readDraft round-trip', () => {
  const dir = tempDir()
  const result = council.writeDraft(dir, 's1', 'codex', 'Plan: step 1, step 2')
  assert.ok(result)
  assert.ok(fs.existsSync(result.path))
  assert.ok(result.hash)
  const draft = council.readDraft(dir, 's1', 'codex')
  assert.equal(draft.content, 'Plan: step 1, step 2')
  assert.ok(draft.hash)
})

test('council: readDraft returns null for missing', () => {
  const dir = tempDir()
  assert.equal(council.readDraft(dir, 's1', 'codex'), null)
})

test('council: listDrafts returns all draft files', () => {
  const dir = tempDir()
  council.writeDraft(dir, 's1', 'codex', 'codex plan')
  council.writeDraft(dir, 's1', 'claude', 'claude plan')
  const drafts = council.listDrafts(dir, 's1')
  assert.equal(drafts.length, 2)
  const providers = drafts.map((d) => d.provider).sort()
  assert.deepEqual(providers, ['claude', 'codex'])
})

test('council: listDrafts returns empty when no drafts', () => {
  const dir = tempDir()
  assert.deepEqual(council.listDrafts(dir, 's1'), [])
})

test('council: buildMergePrompt includes task and draft paths', () => {
  const prompt = council.buildMergePrompt('Build a REST API', ['/path/draft-codex.md', '/path/draft-claude.md'])
  assert.match(prompt, /Build a REST API/)
  assert.match(prompt, /\/path\/draft-codex\.md/)
  assert.match(prompt, /\/path\/draft-claude\.md/)
  assert.match(prompt, /Read each draft file/)
  assert.match(prompt, /Open Questions/)
})

test('council: councilEventPayload creates typed event', () => {
  const event = council.councilEventPayload('s1', 'started', { councilId: 'c1' })
  assert.equal(event.type, 'agentdock.council.started')
  assert.equal(event.sessionId, 's1')
  assert.equal(event.councilId, 'c1')
})

test('council: draftPath produces safe path', () => {
  const p = council.draftPath('/userdata', 's1', 'codex')
  assert.ok(p.includes('council'))
  assert.ok(p.includes('draft-codex.md'))
})