const test = require('node:test')
const assert = require('node:assert/strict')
const { adapters, promptWithAttachments } = require('../electron/adapters.cjs')

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
  assert.match(args.at(-1), /C:\\Temp\\screen shot\.png/)
})

test('terminates OpenCode variadic file arguments before the prompt', () => {
  const args = adapters.opencode.buildArgs(request)
  assert.deepEqual(args.slice(-4, -2), ['--file', request.attachments[0]])
  assert.equal(args.at(-2), '--')
  assert.match(args.at(-1), /What is shown/)
})
