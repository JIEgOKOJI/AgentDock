const test = require('node:test')
const assert = require('node:assert/strict')

const loadFormatter = () => import('../src/activity-format.mjs')

test('describes PowerShell-wrapped reads without exposing the shell', async () => {
  const { describeCommand } = await loadFormatter()
  const result = describeCommand('"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw \'C:\\workspace\\src\\App.tsx\'"')
  assert.deepEqual(result, { kind: 'read', label: 'Reading file', target: 'App.tsx' })
})

test('describes searches and file listing on Windows, Linux, and macOS shells', async () => {
  const { describeCommand } = await loadFormatter()
  assert.deepEqual(describeCommand('pwsh -Command "rg --files -g \'!node_modules\'"'), { kind: 'list', label: 'Listing files', target: '' })
  assert.deepEqual(describeCommand('bash -lc \'rg -n "parseAgent" src\''), { kind: 'search', label: 'Searching project', target: '“parseAgent”' })
  assert.deepEqual(describeCommand('zsh -lc \'grep -R "Actions" src\''), { kind: 'search', label: 'Searching project', target: '“Actions”' })
})

test('describes common development actions', async () => {
  const { describeCommand } = await loadFormatter()
  assert.equal(describeCommand('npm test').label, 'Running tests')
  assert.equal(describeCommand('pnpm build').label, 'Building project')
  assert.equal(describeCommand('git status --short').label, 'Checking Git status')
  assert.equal(describeCommand('apply_patch <<PATCH').label, 'Editing files')
})

test('describes structured tools and file changes', async () => {
  const { describeActivity } = await loadFormatter()
  assert.deepEqual(describeActivity({ type: 'tool', title: 'read', detail: '{"path":"/workspace/README.md"}' }), { kind: 'read', label: 'Reading file', target: 'README.md' })
  assert.deepEqual(describeActivity({ type: 'files', title: 'edit', files: [{ path: 'src/App.tsx' }] }), { kind: 'edit', label: 'Edited file', target: 'App.tsx' })
})
