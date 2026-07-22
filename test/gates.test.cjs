const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const gates = require('../electron/gates.cjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-gates-'))
}

test('gates: normalizeGatesConfig parses testCommand array', () => {
  const config = gates.normalizeGatesConfig({ testCommand: ['npm', 'test'], protectedPaths: ['migrations/**'] })
  assert.deepEqual(config.testCommand, ['npm', 'test'])
  assert.deepEqual(config.protectedPaths, ['migrations/**'])
})

test('gates: normalizeGatesConfig parses testCommand string', () => {
  const config = gates.normalizeGatesConfig({ testCommand: 'npm test' })
  assert.deepEqual(config.testCommand, ['npm', 'test'])
})

test('gates: normalizeGatesConfig returns null testCommand for empty', () => {
  const config = gates.normalizeGatesConfig({})
  assert.equal(config.testCommand, null)
  assert.deepEqual(config.protectedPaths, [])
})

test('gates: matchGlob matches double-star patterns', () => {
  assert.ok(gates.matchGlob('migrations/001_init.sql', 'migrations/**'))
  assert.ok(gates.matchGlob('migrations/sub/002.sql', 'migrations/**'))
  assert.ok(!gates.matchGlob('src/app.ts', 'migrations/**'))
})

test('gates: matchGlob matches single-star patterns', () => {
  assert.ok(gates.matchGlob('.env', '*.env'))
  assert.ok(gates.matchGlob('config.env', '*.env'))
  assert.ok(!gates.matchGlob('env.txt', '*.env'))
})

test('gates: matchGlob matches exact paths', () => {
  assert.ok(gates.matchGlob('src/config.ts', 'src/config.ts'))
  assert.ok(!gates.matchGlob('src/other.ts', 'src/config.ts'))
})

test('gates: matchGlob handles backslash paths', () => {
  assert.ok(gates.matchGlob('migrations\\001.sql', 'migrations/**'))
})

test('gates: checkProtectedPaths returns triggered for matching changes', () => {
  const changes = [{ path: 'migrations/001.sql' }, { path: 'src/app.ts' }]
  const result = gates.checkProtectedPaths(changes, ['migrations/**'])
  assert.ok(result.triggered)
  assert.equal(result.matchedPaths.length, 1)
  assert.equal(result.matchedPaths[0].path, 'migrations/001.sql')
})

test('gates: checkProtectedPaths returns empty when no matches', () => {
  const changes = [{ path: 'src/app.ts' }]
  const result = gates.checkProtectedPaths(changes, ['migrations/**'])
  assert.ok(!result.triggered)
  assert.equal(result.matchedPaths.length, 0)
})

test('gates: checkProtectedPaths handles empty paths', () => {
  const result = gates.checkProtectedPaths([], ['migrations/**'])
  assert.ok(!result.triggered)
})

test('gates: evaluateGates returns pass when no issues', () => {
  const result = gates.evaluateGates({ testResult: { passed: true }, protectedResult: { triggered: false } })
  assert.equal(result.overall, 'pass')
  assert.ok(!result.needsApproval)
})

test('gates: evaluateGates returns needs_approval when protected triggered', () => {
  const result = gates.evaluateGates({ testResult: { passed: true }, protectedResult: { triggered: true } })
  assert.equal(result.overall, 'needs_approval')
  assert.ok(result.needsApproval)
})

test('gates: evaluateGates returns test_failed when test fails', () => {
  const result = gates.evaluateGates({ testResult: { passed: false }, protectedResult: { triggered: false } })
  assert.equal(result.overall, 'test_failed')
  assert.ok(result.needsApproval)
})

test('gates: evaluateGates passes when no test result and no protected', () => {
  const result = gates.evaluateGates({ testResult: null, protectedResult: null })
  assert.equal(result.overall, 'pass')
})

test('gates: writeGateResult creates result.yaml', () => {
  const dir = tempDir()
  gates.writeGateResult(dir, 'run-1', {
    runId: 'run-1',
    testCommand: ['npm', 'test'],
    testPassed: true,
    testExitCode: 0,
    protectedPaths: { triggered: false, matchedPaths: [] },
    needsApproval: false,
    overall: 'pass',
  })
  const filePath = path.join(dir, 'runs', 'run-1', 'gates', 'result.yaml')
  assert.ok(fs.existsSync(filePath))
  const content = fs.readFileSync(filePath, 'utf8')
  assert.ok(content.includes('test_passed: true'))
  assert.ok(content.includes('overall: pass'))
})

test('gates: formatGateResult includes matched paths', () => {
  const formatted = gates.formatGateResult({
    testCommand: ['npm', 'test'],
    testPassed: false,
    testExitCode: 1,
    protectedPaths: { triggered: true, matchedPaths: [{ path: 'migrations/001.sql', pattern: 'migrations/**' }] },
    needsApproval: true,
    overall: 'needs_approval',
  })
  assert.ok(formatted.includes('migrations/001.sql'))
  assert.ok(formatted.includes('needs_approval'))
})

test('gates: runGateCommand resolves with passed=true for exit 0', async () => {
  const result = await gates.runGateCommand(['node', '-e', 'process.exit(0)'])
  assert.ok(result.passed)
  assert.equal(result.exitCode, 0)
})

test('gates: runGateCommand resolves with passed=false for non-zero exit', async () => {
  const result = await gates.runGateCommand(['node', '-e', 'process.exit(1)'])
  assert.ok(!result.passed)
  assert.equal(result.exitCode, 1)
})

test('gates: runGateCommand handles missing command', async () => {
  const result = await gates.runGateCommand(null)
  assert.ok(!result.passed)
  assert.equal(result.error, 'no_command')
})