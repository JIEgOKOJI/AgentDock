const test = require('node:test')
const assert = require('node:assert/strict')

const contextUsage = require('../electron/context-usage.cjs')
const { createContextItem, createContextInvocation, reconcileInvocation, aggregateSessionSummary, buildLegacySummary, buildEmptySummary, estimateTokens, makePreview, sumComponents, COMPONENT_CATEGORIES } = contextUsage

test('estimateTokens returns estimated status for text', () => {
  const result = estimateTokens('hello world')
  assert.ok(result.tokens > 0)
  assert.equal(result.status, 'estimated')
})

test('estimateTokens returns unknown for non-string', () => {
  const result = estimateTokens(null)
  assert.equal(result.tokens, null)
  assert.equal(result.status, 'unknown')
})

test('makePreview creates preview, truncation flag and hash', () => {
  const text = 'a'.repeat(500)
  const result = makePreview(text, 100)
  assert.equal(result.preview.length, 100)
  assert.equal(result.truncated, true)
  assert.ok(result.hash)
})

test('createContextItem stores category, source, status and tokens', () => {
  const item = createContextItem({
    category: COMPONENT_CATEGORIES.userRequest,
    source: 'user-input',
    text: 'Implement a feature',
    tokens: 120,
    status: 'reported',
  })
  assert.equal(item.category, COMPONENT_CATEGORIES.userRequest)
  assert.equal(item.source, 'user-input')
  assert.equal(item.tokens, 120)
  assert.equal(item.status, 'reported')
  assert.ok(item.id)
  assert.ok(item.hash)
})

test('sumComponents separates reported, estimated and unknown', () => {
  const components = [
    { category: 'user_request', source: 'x', chars: 1, tokens: 100, status: 'reported', preview: 'a', truncated: false, hash: 'h1' },
    { category: 'user_request', source: 'x', chars: 4, tokens: 50, status: 'estimated', preview: 'bbbb', truncated: false, hash: 'h2' },
    { category: 'user_request', source: 'x', chars: 1, tokens: null, status: 'unknown', preview: 'c', truncated: false, hash: 'h3' },
  ]
  const sum = sumComponents(components)
  assert.equal(sum.reported, 100)
  assert.equal(sum.estimated, 50)
  assert.equal(sum.unknown, 1)
})

test('reconcileInvocation adds provider overhead when reported input exceeds known components', () => {
  const invocation = createContextInvocation({ runId: 'r1', provider: 'codex', model: 'gpt-5.6-sol', runType: 'run' })
  invocation.components.push(createContextItem({ category: 'user_request', source: 'x', text: 'a'.repeat(400), tokens: 100, status: 'reported' }))
  reconcileInvocation(invocation, { inputTokens: 500, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0, totalTokens: 510, contextTokens: 500, contextSource: 'runtime' })
  assert.equal(invocation.usage.inputTokens, 500)
  const overhead = invocation.components.find((c) => c.category === COMPONENT_CATEGORIES.providerOverhead)
  assert.ok(overhead)
  assert.equal(overhead.tokens, 400)
})

test('reconcileInvocation marks all reported input as unknown when no known components exist', () => {
  const invocation = createContextInvocation({ runId: 'r2', provider: 'codex', model: 'gpt-5.6-sol', runType: 'run' })
  reconcileInvocation(invocation, { inputTokens: 300, cachedInputTokens: 0, outputTokens: 10, totalTokens: 310 })
  const unknown = invocation.components.find((c) => c.category === COMPONENT_CATEGORIES.providerSystemState)
  assert.ok(unknown)
  assert.equal(unknown.tokens, 300)
  assert.equal(unknown.status, 'unknown')
})

test('aggregateSessionSummary counts repeated block once per invocation', () => {
  const invocations = []
  for (let i = 0; i < 3; i++) {
    const invocation = createContextInvocation({ runId: `r${i}`, provider: 'codex', model: 'gpt-5.6-sol', runType: 'run' })
    invocation.components.push(createContextItem({ category: 'user_request', source: 'x', text: 'same request', tokens: 100, status: 'reported' }))
    invocations.push(invocation)
  }
  const summary = aggregateSessionSummary(invocations)
  assert.equal(summary.invocationCount, 3)
  assert.equal(summary.components.length, 3)
  assert.equal(summary.byCategory.user_request.reported, 300)
})

test('buildLegacySummary marks transcript messages estimated and shows unavailable history', () => {
  const summary = buildLegacySummary([
    { id: 'u1', role: 'user', content: 'Hello' },
    { id: 'a1', role: 'assistant', content: 'Hi there' },
  ], 'codex', 'gpt-5.6-sol')
  assert.equal(summary.legacy, true)
  assert.equal(summary.components.length, 2)
  assert.ok(summary.unknownExplanation.includes('predates'))
  assert.equal(summary.accumulatedUsage.totalTokens, 0)
})

test('buildEmptySummary returns empty state with explanation', () => {
  const summary = buildEmptySummary()
  assert.equal(summary.components.length, 0)
  assert.equal(summary.invocationCount, 0)
  assert.ok(summary.unknownExplanation)
})
