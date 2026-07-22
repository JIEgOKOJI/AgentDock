const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const worktree = require('../electron/worktree.cjs')

test('worktree: worktreePath builds safe path structure', () => {
  const p = worktree.worktreePath('/userdata', 'session-123', 'run-abc-def-456')
  assert.ok(p.includes('worktrees'))
  assert.ok(p.includes('session-123'))
  assert.ok(p.includes('run-abc-def'))
})

test('worktree: worktreePath sanitizes unsafe characters', () => {
  const p = worktree.worktreePath('/userdata', 'session/../etc', 'run!!@#$')
  assert.ok(!p.includes('..'))
  assert.ok(p.includes('sessionetc'))
})

test('worktree: worktreeBaseDir returns correct path', () => {
  const base = worktree.worktreeBaseDir('/userdata')
  assert.equal(base, path.join('/userdata', 'worktrees'))
})

test('worktree: isGitRepo resolves false for non-git directory', async () => {
  const os = require('node:os')
  const fs = require('node:fs')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'))
  const result = await worktree.isGitRepo(tmpDir)
  assert.ok(!result)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('worktree: listWorktrees returns empty for non-git', async () => {
  const os = require('node:os')
  const fs = require('node:fs')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'))
  const result = await worktree.listWorktrees(tmpDir)
  assert.deepEqual(result, [])
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('worktree: applyPatch returns error for empty patch', async () => {
  const result = await worktree.applyPatch('.', '')
  assert.ok(!result.ok)
  assert.equal(result.error, 'no_patch')
})