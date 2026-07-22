const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const budget = require('../electron/budget.cjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-budget-'))
}

test('budget: getCostModel returns subscription for codex', () => {
  const model = budget.getCostModel('codex', 'gpt-5')
  assert.equal(model.type, 'subscription')
  assert.equal(model.marginalCostPerRun, 0)
})

test('budget: getCostModel returns subscription for claude', () => {
  const model = budget.getCostModel('claude', 'sonnet')
  assert.equal(model.type, 'subscription')
})

test('budget: getCostModel returns api for opencode', () => {
  const model = budget.getCostModel('opencode', 'openai/gpt-5')
  assert.equal(model.type, 'api')
  assert.ok(model.inputPricePer1M > 0)
})

test('budget: estimateRunCost returns zero for subscription providers', () => {
  const result = budget.estimateRunCost('codex', 'gpt-5', { inputTokens: 100000, outputTokens: 50000 })
  assert.equal(result.cost, 0)
  assert.equal(result.type, 'subscription')
  assert.equal(result.unverifiable, false)
})

test('budget: estimateRunCost calculates api cost', () => {
  const result = budget.estimateRunCost('opencode', 'openai/gpt-5', {
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cachedInputTokens: 200_000,
    reasoningTokens: 100_000,
  })
  assert.equal(result.type, 'api')
  assert.ok(result.cost > 0)
  assert.ok(result.unverifiable === false)
})

test('budget: estimateRunCost returns unverifiable for missing usage', () => {
  const result = budget.estimateRunCost('opencode', 'openai/gpt-5', null)
  assert.equal(result.unverifiable, true)
  assert.equal(result.cost, 0)
})

test('budget: normalizeBudget returns disabled for null', () => {
  const result = budget.normalizeBudget(null)
  assert.equal(result.enabled, false)
  assert.equal(result.maxUsd, null)
})

test('budget: normalizeBudget returns enabled for positive number', () => {
  const result = budget.normalizeBudget(5.0)
  assert.equal(result.enabled, true)
  assert.equal(result.maxUsd, 5.0)
})

test('budget: normalizeBudget treats zero as enabled hard cap', () => {
  const result = budget.normalizeBudget(0)
  assert.equal(result.enabled, true)
  assert.equal(result.maxUsd, 0)
  assert.equal(result.zero, true)
  assert.equal(result.omitted, false)
})

test('budget: normalizeBudget rejects negative', () => {
  const result = budget.normalizeBudget(-5)
  assert.equal(result.enabled, false)
  assert.equal(result.maxUsd, null)
})

test('budget: checkBudget returns not exceeded when under cap', () => {
  const result = budget.checkBudget(2.5, { enabled: true, maxUsd: 5.0 })
  assert.equal(result.exceeded, false)
  assert.ok(result.remaining > 0)
})

test('budget: checkBudget returns exceeded when at cap', () => {
  const result = budget.checkBudget(5.0, { enabled: true, maxUsd: 5.0 })
  assert.equal(result.exceeded, true)
})

test('budget: checkBudget returns not exceeded when disabled', () => {
  const result = budget.checkBudget(100, { enabled: false, maxUsd: null })
  assert.equal(result.exceeded, false)
  assert.equal(result.remaining, null)
})

test('budget: appendSpendEntry and readSpendLedger round-trip', () => {
  const dir = tempDir()
  budget.appendSpendEntry(dir, 's1', { runId: 'r1', provider: 'opencode', cost: 0.5 })
  budget.appendSpendEntry(dir, 's1', { runId: 'r2', provider: 'opencode', cost: 1.2 })
  const entries = budget.readSpendLedger(dir, 's1')
  assert.equal(entries.length, 2)
  assert.equal(entries[0].cost, 0.5)
  assert.equal(entries[1].cost, 1.2)
})

test('budget: totalSpend sums entries', () => {
  const entries = [{ cost: 0.5 }, { cost: 1.2 }, { cost: 0.3 }]
  assert.equal(budget.totalSpend(entries), 2.0)
})

test('budget: sessionSpend returns total from ledger', () => {
  const dir = tempDir()
  budget.appendSpendEntry(dir, 's1', { runId: 'r1', cost: 0.5 })
  budget.appendSpendEntry(dir, 's1', { runId: 'r2', cost: 1.0 })
  assert.equal(budget.sessionSpend(dir, 's1'), 1.5)
})

test('budget: sessionSpend returns 0 for missing ledger', () => {
  const dir = tempDir()
  assert.equal(budget.sessionSpend(dir, 'nonexistent'), 0)
})

test('budget: readSpendLedger returns empty for missing file', () => {
  const dir = tempDir()
  assert.deepEqual(budget.readSpendLedger(dir, 'missing'), [])
})