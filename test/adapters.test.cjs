const test = require('node:test')
const assert = require('node:assert/strict')
const { adapters, promptWithAttachments, codexApprovalPolicy, codexResumePermissionArgs } = require('../electron/adapters.cjs')

const request = {
  model: 'test-model',
  reasoning: 'high',
  agent: 'default',
  prompt: 'What is shown in the screenshot?',
  workspace: 'C:\\workspace',
  attachments: ['C:\\Temp\\screen shot.png'],
  permissionArgs: [],
}

test('describes attached files explicitly in the user prompt', () => {
  const prompt = promptWithAttachments(request.prompt, request.attachments)
  assert.match(prompt, /Open and inspect them before answering/)
  assert.match(prompt, /C:\\Temp\\screen shot\.png/)
})

test('terminates Codex variadic image arguments before the prompt', () => {
  const args = adapters.codex.buildArgs(request)
  assert.deepEqual(args.slice(-4, -2), ['--image', request.attachments[0]])
  assert.equal(args.at(-2), '--')
  assert.match(args.at(-1), /What is shown/)
})

test('gives Claude an explicit attachment-aware prompt', () => {
  const args = adapters.claude.buildArgs(request)
  assert.equal(args.includes('--append-system-prompt'), false)
  assert.equal(args.at(-2), '--')
  assert.match(args.at(-1), /C:\\Temp\\screen shot\.png/)
})

test('terminates OpenCode variadic file arguments before the prompt', () => {
  const args = adapters.opencode.buildArgs(request)
  assert.deepEqual(args.slice(-4, -2), ['--file', request.attachments[0]])
  assert.equal(args.at(-2), '--')
  assert.match(args.at(-1), /What is shown/)
})

test('codexApprovalPolicy maps permission modes to Codex approval policies', () => {
  assert.equal(codexApprovalPolicy('ask'), 'untrusted')
  assert.equal(codexApprovalPolicy('auto'), 'on-request')
  assert.equal(codexApprovalPolicy('full'), 'on-request')
})

test('codexResumePermissionArgs bypasses approvals in full mode', () => {
  assert.deepEqual(codexResumePermissionArgs('full'), ['--dangerously-bypass-approvals-and-sandbox'])
})

test('codexResumePermissionArgs writes approval_policy and sandbox_mode for ask and auto', () => {
  assert.deepEqual(codexResumePermissionArgs('ask'), ['-c', 'approval_policy="untrusted"', '-c', 'sandbox_mode="workspace-write"'])
  assert.deepEqual(codexResumePermissionArgs('auto'), ['-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"'])
})

test('Codex resume arguments target the session id and reuse the last prompt', () => {
  const args = adapters.codex.buildResumeArgs({
    model: 'gpt-5',
    reasoning: 'medium',
    workspace: 'C:\\workspace',
    cliSessionId: '019f88b6-3d49-7cb2-8e7c-6399724a7e51',
    lastPrompt: 'Continue the task.',
    attachments: [],
    permissionMode: 'auto',
  })
  assert.ok(args.includes('exec'))
  assert.ok(args.includes('resume'))
  assert.ok(args.includes('019f88b6-3d49-7cb2-8e7c-6399724a7e51'))
  assert.ok(args.some((value, index) => value === '-c' && /^approval_policy=/.test(args[index + 1])))
  assert.equal(args.at(-1), 'Continue the task.')
})

test('Codex resume forwards permissionArgs after the permission config overrides', () => {
  const args = adapters.codex.buildResumeArgs({
    model: 'gpt-5',
    workspace: 'C:\\workspace',
    cliSessionId: '019f88b6-3d49-7cb2-8e7c-6399724a7e51',
    permissionMode: 'auto',
    permissionArgs: ['-c', 'mcp_servers.agentdock-browser={ url="http://127.0.0.1" }'],
  })
  assert.ok(args.some((value, index) => value === '-c' && /^mcp_servers\.agentdock-browser=/.test(args[index + 1])))
})

test('Codex resume falls back to --last when no session id is provided', () => {
  const args = adapters.codex.buildResumeArgs({ workspace: 'C:\\workspace', permissionMode: 'auto' })
  assert.ok(args.includes('--last'))
})

test('Claude resume arguments pass --resume with the session id', () => {
  const args = adapters.claude.buildResumeArgs({
    model: 'sonnet',
    reasoning: 'high',
    cliSessionId: 'e6fe5a8b-917a-4afd-a876-781a71e64db6',
    lastPrompt: 'Continue.',
    attachments: [],
    permissionArgs: ['--permission-mode', 'auto'],
  })
  assert.equal(args[args.indexOf('--resume') + 1], 'e6fe5a8b-917a-4afd-a876-781a71e64db6')
  assert.ok(args.includes('--model'))
  assert.equal(args.at(-1), 'Continue.')
})

test('OpenCode resume arguments pass --session with the session id', () => {
  const args = adapters.opencode.buildResumeArgs({
    model: 'openai/gpt-5',
    reasoning: 'high',
    agent: 'default',
    workspace: 'C:\\workspace',
    cliSessionId: 'ses_077495d21ffeMcDtjcHVEMa0e2',
    lastPrompt: 'Continue.',
    attachments: [],
    permissionArgs: [],
  })
  assert.equal(args[args.indexOf('--session') + 1], 'ses_077495d21ffeMcDtjcHVEMa0e2')
  assert.equal(args.at(-1), 'Continue.')
})
