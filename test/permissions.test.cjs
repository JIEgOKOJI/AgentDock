const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizePermissionMode, permissionLaunchOptions } = require('../electron/permissions.cjs')

test('normalizes unknown permission modes to automatic approval', () => {
  assert.equal(normalizePermissionMode('unknown'), 'auto')
  assert.equal(normalizePermissionMode('full'), 'full')
})

test('maps permission modes to Codex flags', () => {
  assert.deepEqual(permissionLaunchOptions('codex', 'ask', {}).args, ['--sandbox', 'workspace-write', '-c', 'approval_policy="untrusted"'])
  assert.deepEqual(permissionLaunchOptions('codex', 'auto', {}).args, ['--sandbox', 'workspace-write', '-c', 'approval_policy="on-request"'])
  assert.deepEqual(permissionLaunchOptions('codex', 'full', {}).args, ['--dangerously-bypass-approvals-and-sandbox'])
})

test('maps permission modes to Claude flags', () => {
  assert.deepEqual(permissionLaunchOptions('claude', 'ask', {}).args, ['--permission-mode', 'manual'])
  assert.deepEqual(permissionLaunchOptions('claude', 'auto', {}).args, ['--permission-mode', 'auto'])
  assert.deepEqual(permissionLaunchOptions('claude', 'full', {}).args, ['--dangerously-skip-permissions'])
})

test('overrides only OpenCode permissions in inline runtime config', () => {
  const baseEnv = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'example/model', permission: 'deny' }) }
  const automatic = permissionLaunchOptions('opencode', 'auto', baseEnv)
  assert.deepEqual(JSON.parse(automatic.env.OPENCODE_CONFIG_CONTENT), {
    model: 'example/model',
    permission: { '*': 'allow', external_directory: 'ask', doom_loop: 'ask' },
  })
  const full = permissionLaunchOptions('opencode', 'full', baseEnv)
  assert.deepEqual(full.args, ['--dangerously-skip-permissions'])
  assert.equal(JSON.parse(full.env.OPENCODE_CONFIG_CONTENT).permission, 'allow')
})
