const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile, spawn } = require('node:child_process')

const worktree = require('../electron/worktree.cjs')
const budget = require('../electron/budget.cjs')
const repair = require('../electron/repair.cjs')
const gates = require('../electron/gates.cjs')
const plan = require('../electron/plan.cjs')
const artifacts = require('../electron/artifacts.cjs')
const permissions = require('../electron/permissions.cjs')
const orchestrator = require('../electron/run-orchestrator.cjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-stage5-'))
}

async function initGitRepo(dir) {
  await execAsync('git', ['init'], dir)
  await execAsync('git', ['config', 'user.name', 'Test'], dir)
  await execAsync('git', ['config', 'user.email', 'test@test.local'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n')
  await execAsync('git', ['add', '-A'], dir)
  await execAsync('git', ['commit', '-m', 'init'], dir)
}

function execAsync(command, args, cwd) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, windowsHide: true }, (error, stdout = '', stderr = '') => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

// --- 5.1 RunOrchestrator ---

test('orchestrator: PHASES defines complete state machine', () => {
  assert.deepEqual(orchestrator.PHASES, ['prepare', 'spawn', 'collect', 'capture', 'verify', 'decide', 'adopt', 'finalize', 'cleanup'])
})

test('orchestrator: generateRunId returns unique UUIDs', () => {
  const id1 = orchestrator.generateRunId()
  const id2 = orchestrator.generateRunId()
  assert.notEqual(id1, id2)
  assert.ok(id1.length > 0)
})

test('orchestrator: computeOutcome returns blocked for spawn error', () => {
  assert.equal(orchestrator.computeOutcome({ exitCode: -1, spawnError: 'failed' }), 'blocked')
})

test('orchestrator: computeOutcome returns needs_human for protected trigger', () => {
  assert.equal(orchestrator.computeOutcome({ exitCode: 0, protectedTriggered: true }), 'needs_human')
})

test('orchestrator: computeOutcome returns exhausted_overshoot for budget exceeded', () => {
  assert.equal(orchestrator.computeOutcome({ exitCode: 0, budgetExceeded: true }), 'exhausted_overshoot')
})

test('orchestrator: computeOutcome returns cost_unverifiable', () => {
  assert.equal(orchestrator.computeOutcome({ exitCode: 0, costUnverifiable: true }), 'cost_unverifiable')
})

test('orchestrator: computeOutcome returns success for clean exit', () => {
  assert.equal(orchestrator.computeOutcome({ exitCode: 0 }), 'success')
})

test('orchestrator: executeAttempt resolves with spawn error for bad executable', async () => {
  const result = await orchestrator.executeAttempt({
    executable: 'nonexistent-command-xyz',
    buildArgs: (opts) => [],
    cwd: process.cwd(),
    env: process.env,
    prompt: 'test',
    permissionArgs: [],
  })
  assert.ok(result.exitCode !== 0)
  assert.ok(result.spawnError || result.exitCode !== 0)
})

test('orchestrator: executeAttempt runs a simple command and captures output', async () => {
  const result = await orchestrator.executeAttempt({
    executable: 'node',
    buildArgs: () => ['-e', 'console.log("hello world")'],
    cwd: process.cwd(),
    env: process.env,
    prompt: '',
    permissionArgs: [],
  })
  assert.equal(result.exitCode, 0)
  assert.match(result.rawOutput, /hello world/)
})

// --- 5.2 Worktree lifecycle ---

test('stage5-worktree: createWorktree creates isolated worktree with baseTreeHash', async () => {
  const dir = tempDir()
  await initGitRepo(dir)
  fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
  await execAsync('git', ['add', '-A'], dir)
  await execAsync('git', ['commit', '-m', 'add file'], dir)
  const userData = tempDir()
  const result = await worktree.createWorktree(userData, 'session-1', 'run-001', dir)
  assert.ok(result.ok)
  assert.ok(result.path)
  assert.ok(result.baseTreeHash)
  assert.ok(fs.existsSync(result.path))
  assert.ok(fs.existsSync(path.join(result.path, 'README.md')))
  await worktree.removeWorktree(dir, result.path, result.branch)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
})

test('stage5-worktree: createWorktree returns fail-closed for non-git repo', async () => {
  const dir = tempDir()
  const userData = tempDir()
  const result = await worktree.createWorktree(userData, 'session-1', 'run-001', dir)
  assert.ok(!result.ok)
  assert.equal(result.error, 'not_a_git_repo')
  assert.ok(!result.path)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
})

test('stage5-worktree: createNonGitEnvelope creates copy with synthetic baseline', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("hello")')
  fs.writeFileSync(path.join(dir, 'data.json'), '{"key":"value"}')
  const userData = tempDir()
  const result = await worktree.createNonGitEnvelope(userData, 'session-1', 'run-001', dir)
  assert.ok(result.ok)
  assert.ok(result.path)
  assert.ok(result.baseTreeHash)
  assert.ok(result.nonGit)
  assert.ok(fs.existsSync(path.join(result.path, 'app.js')))
  assert.ok(fs.existsSync(path.join(result.path, 'data.json')))
  assert.ok(!fs.existsSync(path.join(dir, '.git')))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
})

test('stage5-worktree: captureWorktreeDiff includes untracked files', async () => {
  const dir = tempDir()
  await initGitRepo(dir)
  fs.writeFileSync(path.join(dir, 'existing.txt'), 'original')
  await execAsync('git', ['add', '-A'], dir)
  await execAsync('git', ['commit', '-m', 'init'], dir)
  const userData = tempDir()
  const wt = await worktree.createWorktree(userData, 'session-1', 'run-001', dir)
  assert.ok(wt.ok)
  fs.writeFileSync(path.join(wt.path, 'new-untracked.txt'), 'new content')
  fs.writeFileSync(path.join(wt.path, 'existing.txt'), 'modified')
  const diff = await worktree.captureWorktreeDiff(wt.path)
  assert.match(diff, /new-untracked\.txt/)
  assert.match(diff, /existing\.txt/)
  await worktree.removeWorktree(dir, wt.path, wt.branch)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
})

test('stage5-worktree: removeWorktree deletes branch when provided', async () => {
  const dir = tempDir()
  await initGitRepo(dir)
  const userData = tempDir()
  const wt = await worktree.createWorktree(userData, 'session-1', 'run-001', dir)
  assert.ok(wt.ok)
  assert.ok(wt.branch)
  await worktree.removeWorktree(dir, wt.path, wt.branch)
  const branchList = await execAsync('git', ['branch', '--list'], dir)
  assert.ok(!branchList.stdout.includes(wt.branch))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
})

test('stage5-worktree: verifyBaseCompatible detects changed base', async () => {
  const dir = tempDir()
  await initGitRepo(dir)
  const hashResult = await execAsync('git', ['rev-parse', 'HEAD'], dir)
  const baseHash = hashResult.stdout.trim()
  const result1 = await orchestrator.verifyBaseCompatible(dir, baseHash)
  assert.ok(result1.compatible)
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new')
  await execAsync('git', ['add', '-A'], dir)
  await execAsync('git', ['commit', '-m', 'new'], dir)
  const result2 = await orchestrator.verifyBaseCompatible(dir, baseHash)
  assert.ok(!result2.compatible)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stage5-worktree: adoptPatch returns adoption_conflict on changed base', async () => {
  const dir = tempDir()
  await initGitRepo(dir)
  const hashResult = await execAsync('git', ['rev-parse', 'HEAD'], dir)
  const baseHash = hashResult.stdout.trim()
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new')
  await execAsync('git', ['add', '-A'], dir)
  await execAsync('git', ['commit', '-m', 'changed'], dir)
  const result = await orchestrator.adoptPatch({ workspace: dir, patch: 'some patch', baseTreeHash: baseHash, emit: () => {}, appendArtifact: () => {}, runId: 'r1' })
  assert.ok(!result.ok)
  assert.ok(result.baseConflict)
  fs.rmSync(dir, { recursive: true, force: true })
})

// --- 5.3 Read-only enforcement ---

test('stage5-readonly: readOnlyPermissionOptions returns read-only for codex', () => {
  const opts = permissions.readOnlyPermissionOptions('codex')
  assert.equal(opts.mode, 'ask')
  assert.ok(opts.args.some((a) => a.includes('read-only')))
})

test('stage5-readonly: readOnlyPermissionOptions returns manual for claude', () => {
  const opts = permissions.readOnlyPermissionOptions('claude')
  assert.equal(opts.mode, 'ask')
  assert.ok(opts.args.includes('--permission-mode'))
  assert.ok(opts.args.includes('manual'))
})

test('stage5-readonly: readOnlyPermissionOptions returns ask for opencode', () => {
  const opts = permissions.readOnlyPermissionOptions('opencode')
  assert.equal(opts.mode, 'ask')
  assert.ok(opts.env.OPENCODE_CONFIG_CONTENT)
  const config = JSON.parse(opts.env.OPENCODE_CONFIG_CONTENT)
  assert.equal(config.permission.edit, 'ask')
})

test('stage5-readonly: isReadOnlyIntent returns true for ask and plan', () => {
  assert.ok(permissions.isReadOnlyIntent('ask'))
  assert.ok(permissions.isReadOnlyIntent('plan'))
  assert.ok(!permissions.isReadOnlyIntent('agent'))
})

test('stage5-readonly: effectivePermissionOptions uses read-only for plan intent', () => {
  const opts = permissions.effectivePermissionOptions('codex', 'plan', 'full')
  assert.equal(opts.mode, 'ask')
  assert.ok(opts.args.some((a) => a.includes('read-only')))
})

test('stage5-readonly: effectivePermissionOptions uses requested mode for agent intent', () => {
  const opts = permissions.effectivePermissionOptions('codex', 'agent', 'full')
  assert.equal(opts.mode, 'full')
  assert.ok(opts.args.includes('--dangerously-bypass-approvals-and-sandbox'))
})

test('stage5-readonly: workspaceFingerprint detects mutations', async () => {
  const dir = tempDir()
  await initGitRepo(dir)
  const fp1 = await artifacts.workspaceFingerprint(dir)
  fs.writeFileSync(path.join(dir, 'new.txt'), 'content')
  const fp2 = await artifacts.workspaceFingerprint(dir)
  assert.notEqual(fp1.hash, fp2.hash)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stage5-readonly: workspaceFingerprint returns same hash for unchanged repo', async () => {
  const dir = tempDir()
  await initGitRepo(dir)
  const fp1 = await artifacts.workspaceFingerprint(dir)
  const fp2 = await artifacts.workspaceFingerprint(dir)
  assert.equal(fp1.hash, fp2.hash)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stage5-readonly: verifyPlanContentHash detects tampered plan', () => {
  const dir = tempDir()
  const result = plan.writePlanContract(dir, 's1', 'Original plan content', [])
  const contract = plan.readPlanContract(dir, 's1')
  const tampered = contract.raw.replace('Original plan content', 'Tampered content')
  fs.writeFileSync(contract.path, tampered, 'utf8')
  const verify = plan.verifyPlanContentHash(dir, 's1')
  assert.equal(verify.ok, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stage5-readonly: parseOpenQuestions produces stable IDs', () => {
  const text = `## Open Questions\n- Should we use PostgreSQL or SQLite or MongoDB?`
  const q1 = plan.parseOpenQuestions(text)
  const q2 = plan.parseOpenQuestions(text)
  assert.equal(q1[0].id, q2[0].id)
  assert.ok(q1[0].required)
  assert.ok(q1[0].options.length >= 2)
})

// --- 5.4 Repair loop ---

test('stage5-repair: shouldContinue returns object with continue and reason', () => {
  const result = repair.shouldContinue({ attempt: 1, attempts: 3, untilClean: false, lastGatePassed: false, lastGateOutput: 'err', gateOutputs: [], cancelled: false })
  assert.equal(typeof result, 'object')
  assert.ok(result.continue)
  assert.equal(result.reason, 'retry')
})

test('stage5-repair: shouldContinue stops on protectedTriggered', () => {
  const result = repair.shouldContinue({ attempt: 1, attempts: 3, untilClean: false, lastGatePassed: false, lastGateOutput: '', gateOutputs: [], cancelled: false, protectedTriggered: true })
  assert.ok(!result.continue)
  assert.equal(result.reason, 'protected_approval_needed')
})

test('stage5-repair: shouldContinue stops on budgetExhausted', () => {
  const result = repair.shouldContinue({ attempt: 1, attempts: 3, untilClean: false, lastGatePassed: false, lastGateOutput: '', gateOutputs: [], cancelled: false, budgetExhausted: true })
  assert.ok(!result.continue)
  assert.equal(result.reason, 'budget_exhausted')
})

test('stage5-repair: shouldContinue stops on spawnError', () => {
  const result = repair.shouldContinue({ attempt: 1, attempts: 3, untilClean: false, lastGatePassed: false, lastGateOutput: '', gateOutputs: [], cancelled: false, spawnError: true })
  assert.ok(!result.continue)
  assert.equal(result.reason, 'spawn_error')
})

test('stage5-repair: stallFingerprint differentiates same error with different patches', () => {
  const fp1 = repair.stallFingerprint('same error', 'patch-hash-aaa')
  const fp2 = repair.stallFingerprint('same error', 'patch-hash-bbb')
  assert.notEqual(fp1, fp2)
})

test('stage5-repair: detectStallByFingerprint returns false for different patch hashes', () => {
  const fps = ['err::hash1', 'err::hash2', 'err::hash3']
  assert.ok(!repair.detectStallByFingerprint(fps))
})

test('stage5-repair: detectStallByFingerprint returns true for identical fingerprints', () => {
  const fps = ['err::hash1', 'err::hash1', 'err::hash1']
  assert.ok(repair.detectStallByFingerprint(fps))
})

test('stage5-repair: writeAttemptArtifact creates per-attempt directory', () => {
  const dir = tempDir()
  repair.writeAttemptArtifact(dir, 'run-1', 3, 'patch.diff', 'diff content')
  const filePath = path.join(dir, 'runs', 'run-1', 'repair', '3', 'patch.diff')
  assert.ok(fs.existsSync(filePath))
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'diff content')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stage5-repair: repair loop simulation with 3 attempts', async () => {
  let attemptCount = 0
  const fakeGateResults = [
    { testPassed: false, overall: 'test_failed', testStderr: 'error 1' },
    { testPassed: false, overall: 'test_failed', testStderr: 'error 2' },
    { testPassed: true, overall: 'pass', testStderr: '' },
  ]
  const maxAttempts = 3
  const gateOutputs = []
  const stallFingerprints = []
  let finalOutcome = 'blocked'
  for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
    attemptCount++
    const gateResult = fakeGateResults[attemptNum - 1]
    const gateOutput = gateResult.testStderr
    gateOutputs.push(gateOutput)
    stallFingerprints.push(repair.stallFingerprint(gateOutput, `patch-${attemptNum}`))
    if (gateResult.testPassed) { finalOutcome = 'success'; break }
    const decision = repair.shouldContinue({
      attempt: attemptNum, attempts: maxAttempts, untilClean: false,
      lastGatePassed: false, lastGateOutput: gateOutput, gateOutputs,
      cancelled: false, stallFingerprints,
    })
    if (!decision.continue) break
  }
  assert.equal(attemptCount, 3)
  assert.equal(finalOutcome, 'success')
})

test('stage5-repair: repair loop stops on stall with identical fingerprints', () => {
  const stallFingerprints = []
  const gateOutputs = []
  let stopped = false
  for (let i = 1; i <= 5; i++) {
    const gateOutput = 'same error'
    gateOutputs.push(gateOutput)
    stallFingerprints.push(repair.stallFingerprint(gateOutput, 'same-patch-hash'))
    if (i >= 3 && repair.detectStallByFingerprint(stallFingerprints)) { stopped = true; break }
  }
  assert.ok(stopped)
})

// --- 5.5 Budget hard cap ---

test('stage5-budget: normalizeBudget treats zero as enabled hard cap', () => {
  const result = budget.normalizeBudget(0)
  assert.ok(result.enabled)
  assert.equal(result.maxUsd, 0)
  assert.ok(result.zero)
  assert.ok(!result.omitted)
})

test('stage5-budget: normalizeBudget treats null as omitted', () => {
  const result = budget.normalizeBudget(null)
  assert.ok(!result.enabled)
  assert.ok(result.omitted)
})

test('stage5-budget: hasBudgetHeadroom blocks zero budget for paid provider', () => {
  const headroom = budget.hasBudgetHeadroom(0, { enabled: true, maxUsd: 0, zero: true })
  assert.ok(!headroom.allowed)
  assert.equal(headroom.reason, 'zero_budget')
})

test('stage5-budget: hasBudgetHeadroom allows when under cap', () => {
  const headroom = budget.hasBudgetHeadroom(2.5, { enabled: true, maxUsd: 5.0 })
  assert.ok(headroom.allowed)
  assert.ok(headroom.remaining > 0)
})

test('stage5-budget: hasBudgetHeadroom blocks when over cap', () => {
  const headroom = budget.hasBudgetHeadroom(6.0, { enabled: true, maxUsd: 5.0 })
  assert.ok(!headroom.allowed)
})

test('stage5-budget: hasBudgetHeadroom allows when budget omitted', () => {
  const headroom = budget.hasBudgetHeadroom(100, { enabled: false, omitted: true })
  assert.ok(headroom.allowed)
})

test('stage5-budget: reserveBudget and settleReservation work', () => {
  const dir = tempDir()
  const res1 = budget.reserveBudget('session-1', 1.0, { runId: 'r1' })
  assert.ok(res1.id)
  assert.equal(res1.reserved, 1.0)
  assert.equal(res1.totalReserved, 1.0)
  const res2 = budget.reserveBudget('session-1', 0.5, { runId: 'r2' })
  assert.equal(res2.totalReserved, 1.5)
  budget.settleReservation('session-1', res1.id, 0.8)
  assert.equal(budget.totalReserved('session-1'), 1.3)
  budget.clearReservations('session-1')
  assert.equal(budget.totalReserved('session-1'), 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stage5-budget: releaseReservation removes from ledger', () => {
  budget.clearReservations('session-release')
  const res = budget.reserveBudget('session-release', 2.0, { runId: 'r1' })
  assert.equal(budget.totalReserved('session-release'), 2.0)
  budget.releaseReservation('session-release', res.id)
  assert.equal(budget.totalReserved('session-release'), 0)
  budget.clearReservations('session-release')
})

test('stage5-budget: pricingSnapshot returns versioned data', () => {
  const snapshot = budget.pricingSnapshot()
  assert.ok(snapshot.version)
  assert.ok(snapshot.date)
  assert.ok(snapshot.source)
  assert.ok(snapshot.models)
  assert.equal(snapshot.models.codex.type, 'subscription')
  assert.ok(snapshot.models.codex.marginalSubscription)
})

test('stage5-budget: estimateRunCost for subscription includes marginalSubscription', () => {
  const result = budget.estimateRunCost('codex', 'gpt-5', { inputTokens: 100, outputTokens: 50 })
  assert.equal(result.type, 'subscription')
  assert.ok(result.marginalSubscription)
  assert.equal(result.cost, 0)
})

test('stage5-budget: estimateRunCost returns unverifiable for null usage', () => {
  const result = budget.estimateRunCost('opencode', 'openai/gpt-5', null)
  assert.ok(result.unverifiable)
  assert.equal(result.cost, 0)
})

// --- Integration: orchestrator phases ---

test('stage5-integration: prepareEnvelope returns non-isolated for non-isolated run', async () => {
  const dir = tempDir()
  const userData = tempDir()
  const result = await orchestrator.prepareEnvelope({ isolated: false, intent: 'agent', userData, sessionId: 's1', runId: 'r1', workspace: dir })
  assert.ok(!result.isolated)
  assert.equal(result.cwd, dir)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
})

test('stage5-integration: prepareEnvelope returns non-isolated for plan intent', async () => {
  const dir = tempDir()
  const userData = tempDir()
  const result = await orchestrator.prepareEnvelope({ isolated: true, intent: 'plan', userData, sessionId: 's1', runId: 'r1', workspace: dir })
  assert.ok(!result.isolated)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
})

test('stage5-integration: prepareEnvelope fail-closed for isolated non-git', async () => {
  const dir = tempDir()
  const userData = tempDir()
  const result = await orchestrator.prepareEnvelope({ isolated: true, intent: 'agent', userData, sessionId: 's1', runId: 'r1', workspace: dir })
  assert.ok(result.isolated)
  assert.ok(result.failClosed || result.worktreeInfo?.ok)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
})

test('stage5-integration: prepareEnvelope creates worktree for isolated git run', async () => {
  const dir = tempDir()
  await initGitRepo(dir)
  const userData = tempDir()
  const result = await orchestrator.prepareEnvelope({ isolated: true, intent: 'agent', userData, sessionId: 's1', runId: 'r1', workspace: dir })
  assert.ok(result.isolated)
  assert.ok(!result.failClosed)
  assert.ok(result.worktreeInfo.ok)
  assert.ok(result.baseTreeHash)
  await worktree.removeWorktree(dir, result.worktreeInfo.path, result.worktreeInfo.branch)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
})

test('stage5-integration: verifyGates runs test in worktree cwd', async () => {
  const dir = tempDir()
  await initGitRepo(dir)
  fs.writeFileSync(path.join(dir, 'test.js'), 'module.exports = () => true')
  await execAsync('git', ['add', '-A'], dir)
  await execAsync('git', ['commit', '-m', 'add test'], dir)
  const userData = tempDir()
  const envelope = await orchestrator.prepareEnvelope({ isolated: true, intent: 'agent', userData, sessionId: 's1', runId: 'r1', workspace: dir })
  const gatesConfig = gates.normalizeGatesConfig({ testCommand: ['node', '-e', 'process.exit(0)'] })
  const result = await orchestrator.verifyGates({ gatesConfig, changes: [], cwd: envelope.cwd, workspace: dir, emit: () => {}, appendArtifact: () => {}, runId: 'r1', isolated: envelope.isolated, worktreeInfo: envelope.worktreeInfo })
  assert.ok(result.gateResult)
  assert.ok(result.testPassed)
  await worktree.removeWorktree(dir, envelope.worktreeInfo.path, envelope.worktreeInfo.branch)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
})

test('stage5-integration: cleanupEnvelope removes worktree', async () => {
  const dir = tempDir()
  await initGitRepo(dir)
  const userData = tempDir()
  const envelope = await orchestrator.prepareEnvelope({ isolated: true, intent: 'agent', userData, sessionId: 's1', runId: 'r1', workspace: dir })
  assert.ok(fs.existsSync(envelope.worktreeInfo.path))
  await orchestrator.cleanupEnvelope({ isolated: envelope.isolated, worktreeInfo: envelope.worktreeInfo, workspace: dir, intent: 'agent' })
  assert.ok(!fs.existsSync(envelope.worktreeInfo.path))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })
})

test('stage5-integration: readArtifact safe path resolution blocks traversal', () => {
  const dir = tempDir()
  artifacts.ensureRunDir(dir, 'run-1')
  fs.writeFileSync(path.join(dir, 'runs', 'run-1', 'final', 'secret.txt'), 'secret')
  const result = artifacts.readArtifact(dir, 'run-1', '../final/secret.txt')
  assert.equal(result, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stage5-integration: readArtifact allows valid paths', () => {
  const dir = tempDir()
  artifacts.ensureRunDir(dir, 'run-1')
  fs.writeFileSync(path.join(dir, 'runs', 'run-1', 'final', 'summary.md'), 'summary')
  const result = artifacts.readArtifact(dir, 'run-1', 'final/summary.md')
  assert.equal(result, 'summary')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stage5-integration: readArtifact blocks symlink escape', () => {
  const dir = tempDir()
  const outsideDir = tempDir()
  artifacts.ensureRunDir(dir, 'run-1')
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret')
  try {
    fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(dir, 'runs', 'run-1', 'escape.txt'))
  } catch {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
    return
  }
  const result = artifacts.readArtifact(dir, 'run-1', 'escape.txt')
  assert.equal(result, null)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(outsideDir, { recursive: true, force: true })
})

test('stage5-integration: normalizeReceipt includes cost and budget fields', () => {
  const receipt = artifacts.normalizeReceipt({
    runId: 'r1', sessionId: 's1', provider: 'codex', exitCode: 0, outcome: 'success',
    cost: { cost: 0, type: 'subscription' },
    budget: { maxUsd: 5, spend: 1, remaining: 4, exceeded: false },
    warnings: ['test warning'],
    baseTreeHash: 'abc123',
  })
  assert.ok(receipt.cost)
  assert.ok(receipt.budget)
  assert.equal(receipt.warnings.length, 1)
  assert.equal(receipt.baseTreeHash, 'abc123')
})