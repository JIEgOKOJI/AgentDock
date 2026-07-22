const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const plan = require('../electron/plan.cjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-plan-'))
}

test('plan: planPrefix adds plan directive for plan intent', () => {
  assert.match(plan.planPrefix('plan'), /Plan, do not implement/)
  assert.match(plan.planPrefix('plan'), /Open Questions/)
})

test('plan: planPrefix adds ask directive for ask intent', () => {
  assert.match(plan.planPrefix('ask'), /Answer the question/)
  assert.match(plan.planPrefix('ask'), /Do not modify/)
})

test('plan: planPrefix is empty for agent intent', () => {
  assert.equal(plan.planPrefix('agent'), '')
})

test('plan: parseOpenQuestions extracts questions from block', () => {
  const text = `Here is my plan.

## Open Questions

- Should we use PostgreSQL or SQLite?
- What is the preferred date format?
- Do we need backward compatibility with v1?
`
  const questions = plan.parseOpenQuestions(text)
  assert.equal(questions.length, 3)
  assert.ok(questions[0].text.includes('PostgreSQL'))
  assert.ok(questions.every((q) => ['single', 'multi', 'text'].includes(q.kind)))
})

test('plan: parseOpenQuestions returns empty when no section', () => {
  assert.deepEqual(plan.parseOpenQuestions('No questions here.'), [])
  assert.deepEqual(plan.parseOpenQuestions(''), [])
})

test('plan: parseOpenQuestions deduplicates', () => {
  const text = `## Open Questions\n- Same question?\n- Same question?`
  const questions = plan.parseOpenQuestions(text)
  assert.equal(questions.length, 1)
})

test('plan: classifyPlanReadiness returns needs_answers when questions exist', () => {
  assert.equal(plan.classifyPlanReadiness('plan', [{ id: '1', kind: 'text', text: 'what?', required: true }]), 'needs_answers')
})

test('plan: classifyPlanReadiness returns ready when required questions are answered', () => {
  assert.equal(plan.classifyPlanReadiness('plan', [{ id: '1', kind: 'text', text: 'what?', required: true, answer: 'yes' }]), 'ready')
})

test('plan: classifyPlanReadiness returns ready when no questions and no uncertainty', () => {
  assert.equal(plan.classifyPlanReadiness('A complete plan with all details.'), 'ready')
})

test('plan: classifyPlanReadiness returns needs_answers with uncertain language', () => {
  assert.equal(plan.classifyPlanReadiness('I am not sure about this part. TBD.'), 'needs_answers')
})

test('plan: classifyPlanReadiness returns unverified for empty text', () => {
  assert.equal(plan.classifyPlanReadiness(''), 'unverified')
})

test('plan: contentHash is deterministic and 16 chars', () => {
  const h1 = plan.contentHash('test')
  const h2 = plan.contentHash('test')
  assert.equal(h1, h2)
  assert.equal(h1.length, 16)
  assert.notEqual(plan.contentHash('test'), plan.contentHash('different'))
})

test('plan: writePlanContract and readPlanContract round-trip', () => {
  const dir = tempDir()
  const result = plan.writePlanContract(dir, 's1', 'Do step 1.\nDo step 2.', [])
  assert.ok(result)
  assert.ok(result.hash)
  assert.ok(fs.existsSync(result.path))
  const contract = plan.readPlanContract(dir, 's1')
  assert.ok(contract)
  assert.equal(contract.hash, result.hash)
  assert.ok(contract.content.includes('Do step 1.'))
})

test('plan: writePlanContract includes answers', () => {
  const dir = tempDir()
  const result = plan.writePlanContract(dir, 's1', 'Plan text', [{ text: 'Which db?', value: 'PostgreSQL' }])
  const contract = plan.readPlanContract(dir, 's1')
  assert.ok(contract.raw.includes('PostgreSQL'))
  assert.ok(contract.raw.includes('Which db?'))
  assert.ok(contract.answersHash)
})

test('plan: verifyPlanHash returns true for matching hash', () => {
  const dir = tempDir()
  const result = plan.writePlanContract(dir, 's1', 'Plan', [])
  assert.ok(plan.verifyPlanHash(dir, 's1', result.hash))
  assert.ok(!plan.verifyPlanHash(dir, 's1', 'wrong'))
})

test('plan: verifyPlanContentHash detects tampered plan body', () => {
  const dir = tempDir()
  const result = plan.writePlanContract(dir, 's1', 'Original plan', [])
  const contract = plan.readPlanContract(dir, 's1')
  const tampered = contract.raw.replace('Original plan', 'Tampered plan')
  fs.writeFileSync(contract.path, tampered, 'utf8')
  const verify = plan.verifyPlanContentHash(dir, 's1')
  assert.equal(verify.ok, false)
  assert.notEqual(verify.recomputed, verify.stored)
})

test('plan: readPlanContract returns null when no plan', () => {
  const dir = tempDir()
  assert.equal(plan.readPlanContract(dir, 's1'), null)
})