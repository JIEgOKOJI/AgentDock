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

test('captures the Codex thread id from a thread.started event', async () => {
  const parse = await loadParser()
  const raw = [
    { type: 'thread.started', thread_id: '019f88b6-3d49-7cb2-8e7c-6399724a7e51' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Hi!' } },
  ].map(JSON.stringify).join('\n')
  const result = parse('codex', raw)
  assert.equal(result.cliSessionId, '019f88b6-3d49-7cb2-8e7c-6399724a7e51')
})

test('captures the Claude session id from the init event', async () => {
  const parse = await loadParser()
  const raw = [
    { type: 'system', subtype: 'init', session_id: 'e6fe5a8b-917a-4afd-a876-781a71e64db6', cwd: '/tmp' },
    { type: 'result', result: 'Done.' },
  ].map(JSON.stringify).join('\n')
  const result = parse('claude', raw)
  assert.equal(result.cliSessionId, 'e6fe5a8b-917a-4afd-a876-781a71e64db6')
})

test('captures the OpenCode session id from any event carrying sessionID', async () => {
  const parse = await loadParser()
  const raw = JSON.stringify({ type: 'step_start', sessionID: 'ses_077495d21ffeMcDtjcHVEMa0e2', part: { type: 'step-start' } })
  const result = parse('opencode', raw)
  assert.equal(result.cliSessionId, 'ses_077495d21ffeMcDtjcHVEMa0e2')
})

test('collects typed agentdock events and extracts run outcome', async () => {
  const parse = await loadParser()
  const raw = [
    { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
    { type: 'agentdock.run.outcome', runId: 'r1', outcome: 'success', exitCode: 0 },
  ].map(JSON.stringify).join('\n')
  const result = parse('codex', raw)
  assert.equal(result.outcome, 'success')
  assert.ok(result.typedEvents.length >= 1)
  assert.equal(result.typedEvents[0].type, 'agentdock.run.outcome')
})

test('collects session.continuity typed events', async () => {
  const parse = await loadParser()
  const raw = [
    { type: 'agentdock.session.continuity', from: 'codex:work', to: 'claude:personal', reason: 'lane_switch' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Continuing.' } },
  ].map(JSON.stringify).join('\n')
  const result = parse('codex', raw)
  assert.equal(result.typedEvents.length, 1)
  assert.equal(result.typedEvents[0].type, 'agentdock.session.continuity')
  assert.equal(result.typedEvents[0].from, 'codex:work')
})

test('collects profile_rotated typed events', async () => {
  const parse = await loadParser()
  const raw = [
    { type: 'agentdock.profile_rotated', from: 'p1', to: 'p2', reason: 'quota_exhausted' },
  ].map(JSON.stringify).join('\n')
  const result = parse('claude', raw)
  assert.equal(result.typedEvents.length, 1)
  assert.equal(result.typedEvents[0].type, 'agentdock.profile_rotated')
  assert.equal(result.typedEvents[0].to, 'p2')
})
