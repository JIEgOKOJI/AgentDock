const test = require('node:test')
const assert = require('node:assert/strict')

const loadParser = () => import('../src/agent-events.mjs').then((module) => module.parseAgentTranscript)

test('normalizes Codex reasoning, commands, answer, and final file summary', async () => {
  const parse = await loadParser()
  const raw = [
    { type: 'item.completed', item: { type: 'reasoning', text: 'Inspecting the project' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', aggregated_output: 'ok', status: 'completed' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Готово.' } },
    { type: 'agentdock.file_changes', changes: [{ path: 'src/App.tsx', additions: 12, deletions: 3 }] },
  ].map(JSON.stringify).join('\n')
  const result = parse('codex', raw)
  assert.equal(result.content, 'Готово.')
  assert.deepEqual(result.activities.map((item) => item.type), ['thinking', 'command'])
  assert.deepEqual(result.finalFiles[0], { path: 'src/App.tsx', additions: 12, deletions: 3, diff: '' })
})

test('normalizes Claude tool calls and OpenCode tool parts', async () => {
  const parse = await loadParser()
  const claude = parse('claude', JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'Checking files' },
    { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: 'README.md', old_string: 'old', new_string: 'new\nline' } },
  ] } }))
  assert.deepEqual(claude.activities.map((item) => item.type), ['thinking', 'command', 'files'])

  const opencode = parse('opencode', JSON.stringify({ type: 'tool', part: { type: 'tool', tool: 'shell', state: { input: { command: 'npm test' }, status: 'completed' } } }))
  assert.equal(opencode.activities[0].type, 'command')
})

test('does not display read, grep, or glob tools as file changes', async () => {
  const parse = await loadParser()
  const raw = ['glob', 'grep', 'read'].map((tool) => JSON.stringify({ type: 'tool', part: { type: 'tool', tool, state: { input: { path: `C:\\workspace\\${tool}` }, status: 'completed' } } })).join('\n')
  const result = parse('opencode', raw)
  assert.deepEqual(result.activities.map((item) => item.type), ['tool', 'tool', 'tool'])
  assert.equal(result.activities.some((item) => item.files?.length), false)
})

test('keeps only text emitted after the last action in the final summary', async () => {
  const parse = await loadParser()
  const raw = [
    { type: 'text', part: { type: 'text', text: 'Начинаю изучать проект.' } },
    { type: 'tool', part: { type: 'tool', tool: 'read', state: { input: { path: 'src/App.tsx' } } } },
    { type: 'text', part: { type: 'text', text: 'Готово. Изменения внесены.' } },
  ].map(JSON.stringify).join('\n')
  assert.equal(parse('opencode', raw).content, 'Готово. Изменения внесены.')
})

test('merges streaming updates for the same action', async () => {
  const parse = await loadParser()
  const raw = [
    { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'npm test', status: 'completed', aggregated_output: '15 tests passed' } },
  ].map(JSON.stringify).join('\n')
  const result = parse('codex', raw)
  assert.equal(result.activities.length, 1)
  assert.equal(result.activities[0].status, 'completed')
  assert.equal(result.activities[0].output, '15 tests passed')
})
