const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const { adapters } = require('./adapters.cjs')
const { normalizePermissionMode, effectivePermissionOptions, isReadOnlyIntent } = require('./permissions.cjs')
const { ensureRunDir, appendEvents, writePatch, writeSummary, writeReceipt, normalizeReceipt, workspaceFingerprint, buildDiffFromChanges } = require('./artifacts.cjs')
const { planPrefix, parseOpenQuestions, classifyPlanReadiness, writePlanContract, contentHash, verifyPlanContentHash } = require('./plan.cjs')
const { normalizeGatesConfig, checkProtectedPaths, runGateCommand, writeGateResult, evaluateGates } = require('./gates.cjs')
const { normalizeRepairConfig, buildRepairPrompt, stallFingerprint, shouldContinue, writeAttemptLog, writeAttemptArtifact, repairEventPayload, MAX_ATTEMPTS } = require('./repair.cjs')
const { estimateRunCost, normalizeBudget, checkBudget, hasBudgetHeadroom, appendSpendEntry, sessionSpend, reserveBudget, releaseReservation, settleReservation, totalReserved, pricingSnapshot } = require('./budget.cjs')
const { createWorktree, createNonGitEnvelope, captureWorktreeDiff, applyPatch, removeWorktree, isGitRepo, getBaseTreeHash } = require('./worktree.cjs')
const { globalSkillPrompt } = require('./skills.cjs')

const ORCHESTRATOR_VERSION = 1

const PHASES = ['prepare', 'spawn', 'collect', 'capture', 'verify', 'decide', 'adopt', 'finalize', 'cleanup']

function generateRunId() {
  return crypto.randomUUID()
}

function buildPrompt({ prompt, intent, availableSkills, defaultGlobalSkills, delegateConfig, withBrowserAwarenessPrompt, withDelegateAwarenessPrompt }) {
  const basePrompt = globalSkillPrompt(prompt, availableSkills, defaultGlobalSkills)
  const intentPrefix = planPrefix(intent)
  const promptBase = withBrowserAwarenessPrompt(intentPrefix + basePrompt)
  return delegateConfig?.enabled ? withDelegateAwarenessPrompt(promptBase) : promptBase
}

async function prepareEnvelope({ isolated, intent, userData, sessionId, runId, workspace }) {
  if (!isolated || isReadOnlyIntent(intent)) {
    return { isolated: false, cwd: workspace, worktreeInfo: null, baseTreeHash: null }
  }
  const gitRepo = await isGitRepo(workspace)
  let worktreeInfo
  let baseTreeHash = null
  if (gitRepo) {
    worktreeInfo = await createWorktree(userData, sessionId || 'standalone', runId, workspace)
  } else {
    worktreeInfo = await createNonGitEnvelope(userData, sessionId || 'standalone', runId, workspace)
  }
  if (!worktreeInfo.ok) {
    return { isolated: true, failClosed: true, error: worktreeInfo.error, cwd: null, worktreeInfo, baseTreeHash: null }
  }
  baseTreeHash = worktreeInfo.baseTreeHash || null
  return { isolated: true, failClosed: false, cwd: worktreeInfo.path, worktreeInfo, baseTreeHash }
}

async function executeAttempt({
  adapter,
  executable,
  buildArgs,
  cwd,
  env,
  prompt,
  attachments,
  model,
  reasoning,
  agent,
  permissionArgs,
  emit,
  appendArtifact,
  userData,
  runId,
  attemptNumber,
}) {
  return new Promise((resolve) => {
    let rawOutput = ''
    let spawnError = null
    let settled = false
    const startedAt = Date.now()
    let child
    try {
      child = spawn(executable, buildArgs({ workspace: cwd, model, reasoning, agent, prompt, attachments: attachments || [], permissionArgs }), {
        cwd, env, windowsHide: true, shell: false,
      })
    } catch (error) {
      spawnError = error
    }
    if (spawnError) {
      const result = { exitCode: -1, rawOutput: spawnError.message, spawnError: spawnError.message, startedAt, finishedAt: Date.now() }
      if (emit) emit('error', spawnError.message)
      if (appendArtifact) appendArtifact('error', spawnError.message)
      resolve(result)
      return
    }
    child.stdin.end()
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      rawOutput += text
      if (emit) emit('stdout', text)
      if (appendArtifact) appendArtifact('stdout', text)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      rawOutput += text
      if (emit) emit('stderr', text)
      if (appendArtifact) appendArtifact('stderr', text)
    })
    child.on('error', (error) => {
      if (settled) return
      rawOutput += error.message
      if (emit) emit('error', error.message)
      if (appendArtifact) appendArtifact('error', error.message)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      const exitCode = Number.isFinite(code) ? code : -1
      resolve({ exitCode, rawOutput, spawnError: null, startedAt, finishedAt: Date.now() })
    })
  })
}

async function captureChanges({ isolated, cwd, worktreeInfo, workspace, changesBeforeRun, includeDiff = true, readWorkspaceChanges }) {
  if (isolated && worktreeInfo?.ok && worktreeInfo.path) {
    const patch = await captureWorktreeDiff(worktreeInfo.path)
    return { patch, changes: [], isWorktree: true }
  }
  const changes = workspaceChangeDelta(changesBeforeRun, await readWorkspaceChanges(workspace, includeDiff))
  return { patch: buildDiffFromChanges(changes), changes, isWorktree: false }
}

function workspaceChangeDelta(before, after) {
  const result = []
  for (const [file, current] of after) {
    const previous = before.get(file) || { additions: 0, deletions: 0 }
    const additions = Math.abs(current.additions - previous.additions)
    const deletions = Math.abs(current.deletions - previous.deletions)
    if (additions || deletions || !before.has(file)) result.push({ path: file, additions, deletions, ...(current.diff ? { diff: current.diff } : {}) })
  }
  return result.sort((left, right) => left.path.localeCompare(right.path))
}

async function verifyGates({ gatesConfig, changes, cwd, workspace, emit, appendArtifact, runId, isolated, worktreeInfo }) {
  if (!gatesConfig.testCommand && !gatesConfig.protectedPaths.length) return { gateResult: null, protectedTriggered: false, testPassed: true }
  const protectedResult = gatesConfig.protectedPaths.length
    ? checkProtectedPaths(changes, gatesConfig.protectedPaths)
    : { triggered: false, matchedPaths: [] }
  let testResult = null
  const gateCwd = isolated && worktreeInfo?.ok && worktreeInfo.path ? worktreeInfo.path : workspace
  if (gatesConfig.testCommand && !protectedResult.triggered) {
    if (emit) emit('stdout', `\n${JSON.stringify({ type: 'agentdock.gates.running', runId, command: gatesConfig.testCommand })}\n`)
    testResult = await runGateCommand(gatesConfig.testCommand, gateCwd)
  }
  const evaluation = evaluateGates({ testResult, protectedResult })
  const gateResult = {
    runId,
    testCommand: gatesConfig.testCommand,
    testPassed: evaluation.testPassed,
    testExitCode: testResult?.exitCode ?? null,
    testStdout: testResult?.stdout?.slice(0, 5000) || '',
    testStderr: testResult?.stderr?.slice(0, 5000) || '',
    protectedPaths: protectedResult,
    needsApproval: evaluation.needsApproval,
    overall: evaluation.overall,
  }
  return { gateResult, protectedTriggered: protectedResult.triggered, testPassed: evaluation.testPassed }
}

async function verifyBaseCompatible(workspace, expectedBaseTreeHash) {
  if (!expectedBaseTreeHash) return { compatible: true }
  const currentHash = await getBaseTreeHash(workspace)
  if (!currentHash) return { compatible: true }
  return { compatible: currentHash === expectedBaseTreeHash, currentHash, expectedBaseTreeHash }
}

async function adoptPatch({ workspace, patch, baseTreeHash, emit, appendArtifact, runId }) {
  if (!patch) return { ok: false, error: 'no_patch', adopted: false }
  const baseCheck = await verifyBaseCompatible(workspace, baseTreeHash)
  if (!baseCheck.compatible) {
    return { ok: false, error: 'adoption_conflict', adopted: false, baseConflict: true, currentHash: baseCheck.currentHash, expectedHash: baseTreeHash }
  }
  const applyResult = await applyPatch(workspace, patch)
  const event = JSON.stringify({ type: 'agentdock.worktree.applied', runId, ok: applyResult.ok, error: applyResult.error || '' })
  if (emit) emit('stdout', `\n${event}\n`)
  if (appendArtifact) appendArtifact('stdout', `\n${event}\n`)
  return { ok: applyResult.ok, error: applyResult.error || null, adopted: applyResult.ok }
}

function computeOutcome({ exitCode, gateResult, intent, isolated, failClosed, protectedTriggered, budgetExceeded, costUnverifiable, spawnError }) {
  if (spawnError) return 'blocked'
  if (failClosed) return 'blocked'
  if (gateResult?.needsApproval || protectedTriggered) return 'needs_human'
  if (budgetExceeded) return 'exhausted_overshoot'
  if (costUnverifiable) return 'cost_unverifiable'
  if (exitCode === 0) return 'success'
  return 'blocked'
}

async function cleanupEnvelope({ isolated, worktreeInfo, workspace, intent }) {
  if (!isolated || !worktreeInfo?.ok || !worktreeInfo.path) return { ok: true }
  let cleanupWarning = null
  try {
    await removeWorktree(workspace, worktreeInfo.path, worktreeInfo.branch)
  } catch (error) {
    cleanupWarning = `Worktree cleanup failed: ${error.message}`
  }
  if (fs.existsSync(worktreeInfo.path)) {
    try { fs.rmSync(worktreeInfo.path, { recursive: true, force: true }) } catch (error) { cleanupWarning = `Worktree removal failed: ${error.message}` }
  }
  return { ok: !cleanupWarning, warning: cleanupWarning }
}

async function runWithRepairLoop(options) {
  const { request, adapter, workspace, userData, home, sessionId, profileRef, intent, isolated, gatesConfig, repairConfig, budgetConfig, availableSkills, defaultGlobalSkills, emit, appendArtifact, readWorkspaceChanges, browserMcpLaunchOptions, descriptor, profileEnv, withBrowserAwarenessPrompt, withDelegateAwarenessPrompt, delegateConfig, running, runId, changesBeforeRun, envelope, permissions } = options
  const attempts = []
  const stallFingerprints = []
  const gateOutputs = []
  let currentEnvelope = envelope
  let currentPrompt = request.prompt || request.lastPrompt || ''
  let attemptNumber = 0
  let lastOutcome = 'blocked'
  let lastExitCode = -1
  let lastGateResult = null
  let lastPatch = ''
  let lastChanges = []
  let lastRawOutput = ''
  let budgetExhausted = false
  let protectedTriggered = false
  let cancelRequested = false
  const canceller = { cancel: () => { cancelRequested = true } }
  options.registerCanceller?.(canceller)

  const maxAttempts = repairConfig.untilClean ? MAX_ATTEMPTS : Math.max(1, repairConfig.attempts)

  for (attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    if (cancelRequested) { lastOutcome = 'cancelled'; break }
    const promptForAttempt = attemptNumber === 1 ? currentPrompt : buildRepairPrompt(request.prompt || request.lastPrompt || '', gateOutputs[gateOutputs.length - 1] || '', attemptNumber)
    const promptBuilt = buildPrompt({ prompt: promptForAttempt, intent, availableSkills, defaultGlobalSkills, delegateConfig, withBrowserAwarenessPrompt, withDelegateAwarenessPrompt })
    const browserOptions = browserMcpLaunchOptions(request.provider, descriptor, runId, permissions.env)
    const mergedEnv = { ...permissions.env, ...browserOptions.env, ...profileEnv, NO_COLOR: '1', FORCE_COLOR: '0' }
    const mergedArgs = [...permissions.args, ...browserOptions.args]
    if (attemptNumber > 1) {
      const repairEvent = JSON.stringify(repairEventPayload(runId, attemptNumber, lastGateResult?.overall || 'test_failed', 'gate_failed_retry'))
      if (emit) emit('stdout', `\n${repairEvent}\n`)
      if (appendArtifact) appendArtifact('stdout', `\n${repairEvent}\n`)
    }
    const attempt = await executeAttempt({
      executable: adapter.executable,
      buildArgs: adapter.buildArgs,
      cwd: currentEnvelope.cwd,
      env: mergedEnv,
      prompt: promptBuilt,
      attachments: request.attachments || [],
      model: request.model,
      reasoning: request.reasoning,
      agent: request.agent || 'default',
      permissionArgs: mergedArgs,
      emit, appendArtifact, userData, runId, attemptNumber,
    })
    lastRawOutput = attempt.rawOutput
    lastExitCode = attempt.exitCode
    const { patch, changes, isWorktree } = await captureChanges({
      isolated: currentEnvelope.isolated,
      cwd: currentEnvelope.cwd,
      worktreeInfo: currentEnvelope.worktreeInfo,
      workspace,
      changesBeforeRun,
      readWorkspaceChanges,
    })
    lastPatch = patch
    lastChanges = changes
    if (emit && changes.length) {
      const changeEvent = JSON.stringify({ type: 'agentdock.file_changes', changes })
      emit('stdout', `\n${changeEvent}\n`)
      if (appendArtifact) appendArtifact('stdout', `\n${changeEvent}\n`)
    }
    writePatch(userData, runId, patch)
    if (attemptNumber > 1) writeAttemptArtifact(userData, runId, attemptNumber, 'patch.diff', patch)
    const { gateResult, protectedTriggered: pt, testPassed } = await verifyGates({ gatesConfig, changes, cwd: currentEnvelope.cwd, workspace, emit, appendArtifact, runId, isolated: currentEnvelope.isolated, worktreeInfo: currentEnvelope.worktreeInfo })
    lastGateResult = gateResult
    protectedTriggered = pt
    if (gateResult) {
      writeGateResult(userData, runId, gateResult)
      const gateEvent = JSON.stringify({ type: 'agentdock.gates.result', runId, overall: gateResult.overall, needsApproval: gateResult.needsApproval, testPassed: gateResult.testPassed, protectedTriggered: pt })
      if (emit) emit('stdout', `\n${gateEvent}\n`)
      if (appendArtifact) appendArtifact('stdout', `\n${gateEvent}\n`)
    }
    const gateOutput = gateResult?.testStderr || gateResult?.testStdout || ''
    gateOutputs.push(gateOutput)
    const patchHash = contentHash(patch)
    stallFingerprints.push(stallFingerprint(gateOutput, patchHash))
    attempts.push({ exitCode: attempt.exitCode, gateOverall: gateResult?.overall, gatePassed: testPassed, gateOutput, patchHash, attemptNumber })
    writeAttemptArtifact(userData, runId, attemptNumber, 'events.jsonl', attempt.rawOutput)
    writeAttemptLog(userData, runId, attempts)
    const continueDecision = shouldContinue({
      attempt: attemptNumber, attempts: maxAttempts, untilClean: repairConfig.untilClean,
      lastGatePassed: testPassed, lastGateOutput: gateOutput, gateOutputs, cancelled: cancelRequested,
      stallFingerprints, budgetExhausted, protectedTriggered, spawnError: attempt.spawnError,
    })
    if (!continueDecision.continue) {
      lastOutcome = testPassed ? 'success' : continueDecision.reason === 'stall' ? 'blocked' : continueDecision.reason === 'max_attempts' ? 'blocked' : 'blocked'
      break
    }
  }
  return { attempts, lastOutcome, lastExitCode, lastGateResult, lastPatch, lastChanges, lastRawOutput, protectedTriggered, budgetExhausted, cancelRequested }
}

module.exports = {
  ORCHESTRATOR_VERSION,
  PHASES,
  generateRunId,
  buildPrompt,
  prepareEnvelope,
  executeAttempt,
  captureChanges,
  verifyGates,
  verifyBaseCompatible,
  adoptPatch,
  computeOutcome,
  cleanupEnvelope,
  runWithRepairLoop,
  workspaceChangeDelta,
}