const path = require('node:path')
const fs = require('node:fs')
const { execFile } = require('node:child_process')

const WORKTREE_VERSION = 1

function execCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout = '', stderr = '') => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function worktreeBaseDir(userData) {
  return path.join(userData, 'worktrees')
}

function worktreePath(userData, sessionId, runId) {
  const sessionSafe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
  const runSafe = String(runId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12)
  return path.join(worktreeBaseDir(userData), sessionSafe, runSafe)
}

async function isGitRepo(cwd) {
  const result = await execCapture('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
  return result.ok && /^true$/i.test(result.stdout.trim())
}

async function getCurrentBranch(cwd) {
  const result = await execCapture('git', ['branch', '--show-current'], { cwd })
  return result.ok ? result.stdout.trim() : ''
}

async function ensureBaselineCommit(cwd) {
  const hasHead = await execCapture('git', ['rev-parse', 'HEAD'], { cwd })
  if (hasHead.ok) return true
  const addResult = await execCapture('git', ['add', '-A'], { cwd })
  if (!addResult.ok) return false
  await execCapture('git', ['-c', 'user.name=AgentDock', '-c', 'user.email=agent@dock.local', 'commit', '-m', 'AgentDock baseline'], { cwd })
  return true
}

async function getBaseTreeHash(cwd) {
  const result = await execCapture('git', ['rev-parse', 'HEAD'], { cwd })
  return result.ok ? result.stdout.trim() : null
}

async function createWorktree(userData, sessionId, runId, sourceCwd) {
  if (!await isGitRepo(sourceCwd)) return { ok: false, error: 'not_a_git_repo', path: null }
  await ensureBaselineCommit(sourceCwd)
  const baseTreeHash = await getBaseTreeHash(sourceCwd)
  const wtPath = worktreePath(userData, sessionId, runId)
  const branchName = `agentdock/${String(runId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12)}`
  fs.mkdirSync(path.dirname(wtPath), { recursive: true })
  const result = await execCapture('git', ['worktree', 'add', '-b', branchName, wtPath], { cwd: sourceCwd })
  if (!result.ok) {
    const resultForce = await execCapture('git', ['worktree', 'add', '--detach', wtPath], { cwd: sourceCwd })
    if (!resultForce.ok) return { ok: false, error: result.stderr || resultForce.stderr, path: null }
    return { ok: true, path: wtPath, branch: null, baseTreeHash }
  }
  return { ok: true, path: wtPath, branch: branchName, baseTreeHash }
}

async function createNonGitEnvelope(userData, sessionId, runId, sourceCwd) {
  const envelopePath = worktreePath(userData, sessionId, runId)
  fs.mkdirSync(path.dirname(envelopePath), { recursive: true })
  fs.mkdirSync(envelopePath, { recursive: true })
  const skipNames = new Set(['.git', 'node_modules', '.agentdock-baseline'])
  await fs.promises.cp(sourceCwd, envelopePath, {
    recursive: true,
    filter: (src) => {
      const basename = path.basename(src)
      return !skipNames.has(basename)
    },
  })
  try {
    await execCapture('git', ['init'], { cwd: envelopePath })
    await execCapture('git', ['add', '-A'], { cwd: envelopePath })
    await execCapture('git', ['-c', 'user.name=AgentDock', '-c', 'user.email=agent@dock.local', 'commit', '-m', 'AgentDock synthetic baseline'], { cwd: envelopePath })
  } catch (error) {
    return { ok: false, error: error.message, path: null }
  }
  const baseTreeHash = await getBaseTreeHash(envelopePath)
  fs.writeFileSync(path.join(envelopePath, '.agentdock-baseline'), JSON.stringify({ created: Date.now(), source: sourceCwd, nonGit: true }), 'utf8')
  return { ok: true, path: envelopePath, branch: null, baseTreeHash, nonGit: true }
}

async function captureWorktreeDiff(wtPath) {
  const untrackedResult = await execCapture('git', ['ls-files', '--others', '--exclude-standard'], { cwd: wtPath })
  if (untrackedResult.ok && untrackedResult.stdout.trim()) {
    const untrackedFiles = untrackedResult.stdout.split(/\r?\n/).filter(Boolean)
    await execCapture('git', ['add', '-N', ...untrackedFiles], { cwd: wtPath })
  }
  const result = await execCapture('git', ['diff', 'HEAD'], { cwd: wtPath })
  return result.ok ? result.stdout : ''
}

async function applyPatch(targetCwd, patch) {
  if (!patch) return { ok: false, error: 'no_patch' }
  try {
    const { spawn } = require('node:child_process')
    return await new Promise((resolve) => {
      const child = spawn('git', ['apply', '--check'], { cwd: targetCwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      child.on('close', (checkCode) => {
        if (checkCode !== 0) {
          resolve({ ok: false, error: `patch check failed: ${stderr}` })
          return
        }
        const applyChild = spawn('git', ['apply'], { cwd: targetCwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        let applyStderr = ''
        applyChild.stderr.on('data', (chunk) => { applyStderr += chunk.toString() })
        applyChild.on('close', (applyCode) => {
          resolve({ ok: applyCode === 0, error: applyCode !== 0 ? applyStderr : null })
        })
        applyChild.stdin.write(patch)
        applyChild.stdin.end()
      })
      child.stdin.write(patch)
      child.stdin.end()
    })
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

async function removeWorktree(sourceCwd, wtPath, branchName = null) {
  if (!wtPath) return { ok: true }
  try {
    await execCapture('git', ['worktree', 'remove', '--force', wtPath], { cwd: sourceCwd })
  } catch {}
  try {
    if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true })
  } catch {}
  if (branchName) {
    try {
      await execCapture('git', ['branch', '-D', branchName], { cwd: sourceCwd })
    } catch {}
  }
  return { ok: true }
}

async function listWorktrees(cwd) {
  const result = await execCapture('git', ['worktree', 'list', '--porcelain'], { cwd })
  if (!result.ok) return []
  const worktrees = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^worktree\s+(.+)$/)
    if (match) worktrees.push(match[1])
  }
  return worktrees
}

module.exports = {
  WORKTREE_VERSION,
  worktreeBaseDir,
  worktreePath,
  isGitRepo,
  getCurrentBranch,
  ensureBaselineCommit,
  getBaseTreeHash,
  createWorktree,
  createNonGitEnvelope,
  captureWorktreeDiff,
  applyPatch,
  removeWorktree,
  listWorktrees,
}