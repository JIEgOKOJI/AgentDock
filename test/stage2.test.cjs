const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const lanes = require('../electron/lanes.cjs')
const artifacts = require('../electron/artifacts.cjs')
const continuity = require('../electron/continuity.cjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-test-'))
}

test('lanes: laneKey produces stable provider:profile keys', () => {
  assert.equal(lanes.laneKey('codex', 'work'), 'codex:work')
  assert.equal(lanes.laneKey('claude'), 'claude:default')
})

test('lanes: getLaneState returns defaults for missing lane', () => {
  const state = lanes.getLaneState({}, 'codex', 'work')
  assert.equal(state.cliSessionId, '')
  assert.equal(state.lastExitCode, null)
  assert.equal(state.lastRunFailed, false)
})

test('lanes: setLaneState merges partial updates', () => {
  const lanesMap = lanes.setLaneState({}, 'codex', 'work', { cliSessionId: 'abc', lastPrompt: 'fix bug' })
  const updated = lanes.setLaneState(lanesMap, 'codex', 'work', { lastExitCode: 0 })
  const state = lanes.getLaneState(updated, 'codex', 'work')
  assert.equal(state.cliSessionId, 'abc')
  assert.equal(state.lastPrompt, 'fix bug')
  assert.equal(state.lastExitCode, 0)
})

test('lanes: normalizeLanes filters invalid keys', () => {
  const result = lanes.normalizeLanes({ 'codex:work': { cliSessionId: 'x' }, 'invalid': {}, 'claude:': { lastPrompt: 'p' } })
  assert.ok('codex:work' in result)
  assert.ok(!('invalid' in result))
  assert.equal(result['codex:work'].cliSessionId, 'x')
})

test('lanes: migrateLegacySession moves flat fields to lanes', () => {
  const session = {
    id: 's1', workspace: '/tmp', provider: 'codex',
    cliSessionId: 'thread-123', lastPrompt: 'fix bug', lastExitCode: 0, lastRunFailed: false,
  }
  const migrated = lanes.migrateLegacySession(session)
  assert.ok(migrated.lanes)
  const state = lanes.getLaneState(migrated.lanes, 'codex', '')
  assert.equal(state.cliSessionId, 'thread-123')
  assert.equal(state.lastPrompt, 'fix bug')
  assert.ok(!migrated.cliSessionId)
})

test('lanes: ensureLaneDir creates directory structure', () => {
  const dir = os.tmpdir()
  const result = lanes.ensureLaneDir(dir, 'session-1', 'codex', 'work')
  assert.ok(fs.existsSync(result))
  assert.ok(result.includes('session-1'))
  assert.ok(result.includes('codex-work'))
})

test('agent runs preserve the native home used for CLI credentials', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.doesNotMatch(mainSource, /\bHOME\s*:\s*lane/i)
  assert.doesNotMatch(mainSource, /\bUSERPROFILE\s*:\s*lane/i)
})

test('artifacts: ensureRunDir creates final subdirectory', () => {
  const dir = tempDir()
  const runDir = artifacts.ensureRunDir(dir, 'run-1')
  assert.ok(fs.existsSync(runDir))
  assert.ok(fs.existsSync(path.join(runDir, 'final')))
})

test('artifacts: appendEvents writes jsonl lines', () => {
  const dir = tempDir()
  artifacts.appendEvents(dir, 'run-1', JSON.stringify({ type: 'stdout', data: 'hello' }))
  artifacts.appendEvents(dir, 'run-1', JSON.stringify({ type: 'stdout', data: 'world' }))
  const content = fs.readFileSync(path.join(dir, 'runs', 'run-1', 'events.jsonl'), 'utf8')
  assert.ok(content.includes('hello'))
  assert.ok(content.includes('world'))
})

test('artifacts: writePatch and writeSummary create files', () => {
  const dir = tempDir()
  artifacts.writePatch(dir, 'run-1', '--- a\n+++ b\n')
  artifacts.writeSummary(dir, 'run-1', 'Task completed.')
  assert.ok(fs.existsSync(path.join(dir, 'runs', 'run-1', 'final', 'patch.diff')))
  assert.ok(fs.existsSync(path.join(dir, 'runs', 'run-1', 'final', 'summary.md')))
})

test('artifacts: writeReceipt and readReceipt round-trip', () => {
  const dir = tempDir()
  artifacts.writeReceipt(dir, 'run-1', artifacts.normalizeReceipt({
    runId: 'run-1', sessionId: 's1', provider: 'codex', profileId: 'work',
    mode: 'run', prompt: 'fix', exitCode: 0, outcome: 'success',
    filesChanged: [{ path: 'src/App.tsx', additions: 10, deletions: 2 }],
    startedAt: 1000, finishedAt: 2000,
  }))
  const receipt = artifacts.readReceipt(dir, 'run-1')
  assert.equal(receipt.runId, 'run-1')
  assert.equal(receipt.outcome, 'success')
  assert.equal(receipt.filesChanged[0].path, 'src/App.tsx')
})

test('artifacts: listRuns filters by sessionId', () => {
  const dir = tempDir()
  artifacts.writeReceipt(dir, 'run-1', artifacts.normalizeReceipt({ runId: 'run-1', sessionId: 's1', provider: 'codex', exitCode: 0, outcome: 'success', startedAt: 1000, finishedAt: 1100 }))
  artifacts.writeReceipt(dir, 'run-2', artifacts.normalizeReceipt({ runId: 'run-2', sessionId: 's2', provider: 'claude', exitCode: 1, outcome: 'blocked', startedAt: 2000, finishedAt: 2100 }))
  const all = artifacts.listRuns(dir)
  assert.equal(all.length, 2)
  const filtered = artifacts.listRuns(dir, 's1')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].runId, 'run-1')
})

test('artifacts: readArtifact rejects disallowed paths', () => {
  const dir = tempDir()
  const result = artifacts.readArtifact(dir, 'run-1', '../../../etc/passwd')
  assert.equal(result, null)
})

test('artifacts: buildDiffFromChanges concatenates diffs', () => {
  const changes = [
    { path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n+hello' },
    { path: 'b.ts', diff: 'diff --git a/b.ts b/b.ts\n+world' },
  ]
  const diff = artifacts.buildDiffFromChanges(changes)
  assert.ok(diff.includes('hello'))
  assert.ok(diff.includes('world'))
})

test('artifacts: buildDiffFromChanges handles missing diffs', () => {
  const changes = [{ path: 'new.ts' }]
  const diff = artifacts.buildDiffFromChanges(changes)
  assert.ok(diff.includes('new.ts'))
})

test('continuity: laneLabel formats provider:profile', () => {
  assert.equal(continuity.laneLabel('codex', 'work'), 'codex:work')
  assert.equal(continuity.laneLabel('claude'), 'claude:default')
})

test('continuity: writeCheckpoint and readCheckpoint round-trip', () => {
  const dir = tempDir()
  continuity.writeCheckpoint(dir, 's1', 'codex', 'work', 'checkpoint content')
  const content = continuity.readCheckpoint(dir, 's1', 'codex', 'work')
  assert.equal(content, 'checkpoint content')
})

test('continuity: writeThread returns file path', () => {
  const dir = tempDir()
  const filePath = continuity.writeThread(dir, 's1', 'thread content')
  assert.ok(filePath)
  assert.ok(fs.existsSync(filePath))
  const content = continuity.readThread(dir, 's1')
  assert.equal(content, 'thread content')
})

test('continuity: buildThreadFromMessages creates structured thread', () => {
  const messages = [
    { id: 'hello', role: 'assistant', content: 'welcome' },
    { id: '1', role: 'user', content: 'fix the bug' },
    { id: '2', role: 'assistant', content: 'fixed it', provider: 'codex', activities: [{ type: 'command', title: 'npm test' }], files: [{ path: 'src/App.tsx', additions: 5, deletions: 1 }] },
  ]
  const thread = continuity.buildThreadFromMessages(messages, 's1')
  assert.ok(thread.includes('fix the bug'))
  assert.ok(thread.includes('fixed it'))
  assert.ok(thread.includes('npm test'))
  assert.ok(thread.includes('src/App.tsx'))
  assert.ok(!thread.includes('welcome'))
})

test('continuity: buildContinuationPacket includes checkpoint and thread path', () => {
  const packet = continuity.buildContinuationPacket({
    fromLane: 'codex:work', toLane: 'claude:personal',
    checkpoint: 'last state', threadPath: '/tmp/THREAD.md',
    deltaSummary: 'delta', sessionId: 's1',
  })
  assert.ok(packet.includes('codex:work'))
  assert.ok(packet.includes('claude:personal'))
  assert.ok(packet.includes('last state'))
  assert.ok(packet.includes('/tmp/THREAD.md'))
  assert.ok(packet.includes('delta'))
})

test('continuity: continuityEventPayload has typed structure', () => {
  const event = continuity.continuityEventPayload('codex:work', 'claude:personal', '/tmp/THREAD.md', 'lane_switch')
  assert.equal(event.type, 'agentdock.session.continuity')
  assert.equal(event.from, 'codex:work')
  assert.equal(event.to, 'claude:personal')
  assert.equal(event.threadFile, '/tmp/THREAD.md')
  assert.equal(event.reason, 'lane_switch')
})
