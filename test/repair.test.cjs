const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const repair = require('../electron/repair.cjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-repair-'))
}

test('repair: normalizeRepairConfig defaults to 1 attempt', () => {
  const config = repair.normalizeRepairConfig({})
  assert.equal(config.attempts, 1)
  assert.equal(config.untilClean, false)
})

test('repair: normalizeRepairConfig clamps attempts to MAX_ATTEMPTS', () => {
  const config = repair.normalizeRepairConfig({ attempts: 100 })
  assert.equal(config.attempts, repair.MAX_ATTEMPTS)
})

test('repair: normalizeRepairConfig min attempts is 1', () => {
  const config = repair.normalizeRepairConfig({ attempts: 0 })
  assert.equal(config.attempts, 1)
  const config2 = repair.normalizeRepairConfig({ attempts: -5 })
  assert.equal(config2.attempts, 1)
})

test('repair: normalizeRepairConfig sets untilClean', () => {
  const config = repair.normalizeRepairConfig({ untilClean: true })
  assert.equal(config.untilClean, true)
})

test('repair: buildRepairPrompt includes previous prompt and gate output', () => {
  const prompt = repair.buildRepairPrompt('Fix the bug', 'Test failed: expected 5 got 3', 2)
  assert.match(prompt, /Fix the bug/)
  assert.match(prompt, /Test failed/)
  assert.match(prompt, /Attempt 2/)
})

test('repair: detectStall returns true for repeated identical outputs', () => {
  const outputs = ['same error', 'same error', 'same error']
  assert.ok(repair.detectStall(outputs))
})

test('repair: detectStall returns false for different outputs', () => {
  const outputs = ['error 1', 'error 2', 'error 3']
  assert.ok(!repair.detectStall(outputs))
})

test('repair: detectStall returns false for less than threshold', () => {
  assert.ok(!repair.detectStall(['same', 'same']))
})

test('repair: shouldContinue returns false when gate passed', () => {
  const result = repair.shouldContinue({ attempt: 1, attempts: 3, untilClean: false, lastGatePassed: true, lastGateOutput: '', gateOutputs: [], cancelled: false })
  assert.ok(!result)
})

test('repair: shouldContinue returns false when cancelled', () => {
  const result = repair.shouldContinue({ attempt: 1, attempts: 3, untilClean: false, lastGatePassed: false, lastGateOutput: 'err', gateOutputs: [], cancelled: true })
  assert.ok(!result)
})

test('repair: shouldContinue returns true when attempts remain', () => {
  const result = repair.shouldContinue({ attempt: 1, attempts: 3, untilClean: false, lastGatePassed: false, lastGateOutput: 'err', gateOutputs: [], cancelled: false })
  assert.ok(result)
})

test('repair: shouldContinue returns false when attempts exhausted', () => {
  const result = repair.shouldContinue({ attempt: 3, attempts: 3, untilClean: false, lastGatePassed: false, lastGateOutput: 'err', gateOutputs: [], cancelled: false })
  assert.ok(!result)
})

test('repair: shouldContinue with untilClean stops on stall', () => {
  const gateOutputs = ['same', 'same']
  const result = repair.shouldContinue({ attempt: 4, attempts: 1, untilClean: true, lastGatePassed: false, lastGateOutput: 'same', gateOutputs, cancelled: false })
  assert.ok(!result)
})

test('repair: shouldContinue with untilClean continues when no stall', () => {
  const result = repair.shouldContinue({ attempt: 2, attempts: 1, untilClean: true, lastGatePassed: false, lastGateOutput: 'different', gateOutputs: ['err1'], cancelled: false })
  assert.ok(result)
})

test('repair: shouldContinue with untilClean stops at MAX_ATTEMPTS', () => {
  const result = repair.shouldContinue({ attempt: repair.MAX_ATTEMPTS, attempts: 1, untilClean: true, lastGatePassed: false, lastGateOutput: 'different', gateOutputs: [], cancelled: false })
  assert.ok(!result)
})

test('repair: writeAttemptLog creates log file', () => {
  const dir = tempDir()
  repair.writeAttemptLog(dir, 'run-1', [
    { exitCode: 1, gateOverall: 'test_failed', gatePassed: false, gateOutput: 'first failure' },
    { exitCode: 0, gateOverall: 'pass', gatePassed: true, gateOutput: '' },
  ])
  const filePath = path.join(dir, 'runs', 'run-1', 'repair', 'attempts.log')
  assert.ok(fs.existsSync(filePath))
  const content = fs.readFileSync(filePath, 'utf8')
  assert.ok(content.includes('first failure'))
  assert.ok(content.includes('Attempt 1'))
  assert.ok(content.includes('Attempt 2'))
})

test('repair: repairEventPayload has typed structure', () => {
  const event = repair.repairEventPayload('run-1', 2, 'test_failed', 'gate_failed_retry')
  assert.equal(event.type, 'agentdock.repair.attempt')
  assert.equal(event.runId, 'run-1')
  assert.equal(event.attempt, 2)
  assert.equal(event.overall, 'test_failed')
  assert.equal(event.reason, 'gate_failed_retry')
})