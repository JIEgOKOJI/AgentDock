const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const GATES_VERSION = 1

function normalizeGatesConfig(value) {
  if (!value || typeof value !== 'object') return { testCommand: null, protectedPaths: [] }
  const testCommand = Array.isArray(value.testCommand)
    ? value.testCommand.filter((item) => typeof item === 'string')
    : typeof value.testCommand === 'string'
      ? value.testCommand.split(/\s+/).filter(Boolean)
      : null
  const protectedPaths = Array.isArray(value.protectedPaths)
    ? value.protectedPaths.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : []
  return { testCommand: testCommand && testCommand.length ? testCommand : null, protectedPaths }
}

function matchGlob(filePath, pattern) {
  if (!pattern || !filePath) return false
  const normalized = filePath.replace(/\\/g, '/')
  let regex = pattern
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*/g, '@@GLOBSTAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@GLOBSTAR@@/g, '.*')
    .replace(/\?/g, '[^/]')
  regex = `^${regex}$`
  try {
    return new RegExp(regex).test(normalized)
  } catch {
    return false
  }
}

function checkProtectedPaths(changes, protectedPaths) {
  if (!protectedPaths || !protectedPaths.length) return { triggered: false, matchedPaths: [] }
  const matched = []
  for (const change of changes) {
    const filePath = change.path || change
    for (const pattern of protectedPaths) {
      if (matchGlob(filePath, pattern)) {
        matched.push({ path: filePath, pattern })
        break
      }
    }
  }
  return { triggered: matched.length > 0, matchedPaths: matched }
}

function runGateCommand(command, cwd = process.cwd(), timeout = 120000) {
  return new Promise((resolve) => {
    if (!command || !command.length) {
      resolve({ passed: false, exitCode: -1, stdout: '', stderr: 'No test command provided', error: 'no_command' })
      return
    }
    const [cmd, ...args] = command
    const child = spawn(cmd, args, { cwd, windowsHide: true, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let finished = false
    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      try { child.kill('SIGKILL') } catch {}
      resolve({ passed: false, exitCode: -1, stdout, stderr: `${stderr}\nTimeout after ${timeout}ms`, error: 'timeout' })
    }, timeout)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ passed: false, exitCode: -1, stdout, stderr, error: error.message })
    })
    child.on('close', (code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ passed: code === 0, exitCode: code, stdout, stderr, error: null })
    })
  })
}

function gatesDir(userData, runId) {
  return path.join(userData, 'runs', runId, 'gates')
}

function ensureGatesDir(userData, runId) {
  const dir = gatesDir(userData, runId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeGateResult(userData, runId, result) {
  if (!result || typeof result !== 'object') return
  try {
    ensureGatesDir(userData, runId)
    fs.writeFileSync(path.join(gatesDir(userData, runId), 'result.yaml'), formatGateResult(result), 'utf8')
  } catch {}
}

function formatGateResult(result) {
  const lines = []
  lines.push(`# Gate result — run ${result.runId || ''}`)
  lines.push(`generated: ${new Date().toISOString()}`)
  lines.push(``)
  lines.push(`test_command: ${result.testCommand ? result.testCommand.join(' ') : 'null'}`)
  lines.push(`test_passed: ${result.testPassed}`)
  lines.push(`test_exit_code: ${result.testExitCode ?? 'null'}`)
  lines.push(``)
  lines.push(`protected_paths_triggered: ${result.protectedPaths?.triggered || false}`)
  if (result.protectedPaths?.matchedPaths?.length) {
    lines.push(`matched:`)
    for (const match of result.protectedPaths.matchedPaths) {
      lines.push(`  - path: ${match.path}`)
      lines.push(`    pattern: ${match.pattern}`)
    }
  }
  lines.push(``)
  lines.push(`needs_approval: ${result.needsApproval}`)
  lines.push(`overall: ${result.overall}`)
  if (result.testStderr) lines.push(`\n--- test stderr ---\n${result.testStderr.slice(0, 5000)}`)
  return lines.join('\n')
}

function evaluateGates({ testResult, protectedResult }) {
  const testPassed = testResult ? testResult.passed : true
  const protectedTriggered = protectedResult ? protectedResult.triggered : false
  const needsApproval = protectedTriggered || (testResult && !testPassed)
  let overall = 'pass'
  if (protectedTriggered) overall = 'needs_approval'
  else if (testResult && !testPassed) overall = 'test_failed'
  return { testPassed, protectedTriggered, needsApproval, overall }
}

module.exports = {
  GATES_VERSION,
  normalizeGatesConfig,
  matchGlob,
  checkProtectedPaths,
  runGateCommand,
  gatesDir,
  ensureGatesDir,
  writeGateResult,
  formatGateResult,
  evaluateGates,
}