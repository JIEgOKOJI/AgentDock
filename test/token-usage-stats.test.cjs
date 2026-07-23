const test = require('node:test')
const assert = require('node:assert/strict')

const { normalizeUsageRecord, aggregateUsage, uniqueValues, UNKNOWN_MODEL, UNKNOWN_PROFILE } = require('../electron/token-usage-stats.cjs')

function makeRecord(overrides = {}) {
  return normalizeUsageRecord({
    ts: Date.now(),
    provider: 'codex',
    model: 'gpt-5.6-sol',
    profileId: 'default-codex',
    usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
    ...overrides,
  })
}

test('normalizeUsageRecord: preserves provider, model, profileId, usage', () => {
  const record = makeRecord({ ts: 1234567890, provider: 'Codex ', model: ' gpt-5.6-sol ', profileId: 'p1' })
  assert.equal(record.provider, 'codex')
  assert.equal(record.model, 'gpt-5.6-sol')
  assert.equal(record.profileId, 'p1')
  assert.equal(record.ts, 1234567890)
  assert.ok(record.usage)
  assert.equal(record.usage.inputTokens, 1000)
  assert.equal(record.usage.outputTokens, 200)
})

test('normalizeUsageRecord: unknown provider/model/profileId marked explicitly', () => {
  const record = normalizeUsageRecord({ ts: 1, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
  assert.equal(record.provider, 'unknown')
  assert.equal(record.model, UNKNOWN_MODEL)
  assert.equal(record.profileId, '')
  assert.equal(record.profileId || UNKNOWN_PROFILE, UNKNOWN_PROFILE)
})

test('normalizeUsageRecord: empty usage object yields hasUsage false', () => {
  const record = normalizeUsageRecord({ ts: 1, provider: 'codex', model: 'x', profileId: 'p1', usage: {} })
  assert.equal(record.hasUsage, false)
  assert.equal(record.usage, null)
})

test('normalizeUsageRecord: missing usage is not coerced to 0', () => {
  const record = normalizeUsageRecord({ ts: 1, provider: 'codex', model: 'x', profileId: 'p1' })
  assert.equal(record.hasUsage, false)
  assert.equal(record.usage, null)
})

test('aggregateUsage: groups by provider, model, profile', () => {
  const records = [
    makeRecord({ provider: 'codex', model: 'gpt-5.6-sol', profileId: 'work', usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } }),
    makeRecord({ provider: 'codex', model: 'gpt-5.6-sol', profileId: 'personal', usage: { inputTokens: 800, outputTokens: 100, totalTokens: 900 } }),
    makeRecord({ provider: 'claude', model: 'sonnet', profileId: 'work', usage: { inputTokens: 500, outputTokens: 300, totalTokens: 800 } }),
  ]
  const stats = aggregateUsage(records)
  assert.equal(stats.grandTotal.runCount, 3)
  assert.equal(stats.grandTotal.inputTokens, 2300)
  assert.equal(stats.grandTotal.totalTokens, 2900)

  assert.equal(stats.providers.length, 2)
  const codex = stats.providers.find((p) => p.provider === 'codex')
  assert.ok(codex)
  assert.equal(codex.runCount, 2)
  assert.equal(codex.inputTokens, 1800)
  const model = codex.models.find((m) => m.model === 'gpt-5.6-sol')
  assert.equal(model.profiles.length, 2)
  const work = model.profiles.find((p) => p.profileId === 'work')
  assert.equal(work.inputTokens, 1000)
  const personal = model.profiles.find((p) => p.profileId === 'personal')
  assert.equal(personal.inputTokens, 800)
})

test('aggregateUsage: profiles of the same provider are not merged', () => {
  const records = [
    makeRecord({ provider: 'codex', profileId: 'p1', usage: { inputTokens: 1000, totalTokens: 1000 } }),
    makeRecord({ provider: 'codex', profileId: 'p2', usage: { inputTokens: 2000, totalTokens: 2000 } }),
  ]
  const stats = aggregateUsage(records)
  const model = stats.providers[0].models[0]
  assert.equal(model.profiles.length, 2)
  assert.equal(stats.grandTotal.inputTokens, 3000)
})

test('aggregateUsage: Codex cached and reasoning tokens are preserved', () => {
  const records = [
    makeRecord({
      provider: 'codex',
      usage: {
        inputTokens: 12000,
        cachedInputTokens: 4000,
        outputTokens: 800,
        reasoningTokens: 200,
        totalTokens: 17000,
      },
    }),
  ]
  const stats = aggregateUsage(records)
  assert.equal(stats.grandTotal.inputTokens, 12000)
  assert.equal(stats.grandTotal.cachedInputTokens, 4000)
  assert.equal(stats.grandTotal.outputTokens, 800)
  assert.equal(stats.grandTotal.reasoningTokens, 200)
  assert.equal(stats.grandTotal.totalTokens, 17000)
})

test('aggregateUsage: Claude cache read + creation counted as cachedInputTokens', () => {
  const records = [
    normalizeUsageRecord({
      ts: 1,
      provider: 'claude',
      model: 'sonnet',
      profileId: 'default-claude',
      usage: { inputTokens: 50000, cachedInputTokens: 35000, outputTokens: 4000, reasoningTokens: 0, totalTokens: 89000 },
    }),
  ]
  const stats = aggregateUsage(records)
  assert.equal(stats.grandTotal.inputTokens, 50000)
  assert.equal(stats.grandTotal.cachedInputTokens, 35000)
  assert.equal(stats.grandTotal.outputTokens, 4000)
  assert.equal(stats.grandTotal.totalTokens, 89000)
})

test('aggregateUsage: OpenCode step totals are preserved', () => {
  const records = [
    normalizeUsageRecord({
      ts: 1,
      provider: 'opencode',
      model: 'qwen-coder',
      profileId: 'p1',
      usage: { inputTokens: 4000, cachedInputTokens: 2100, outputTokens: 600, reasoningTokens: 150, totalTokens: 6850 },
    }),
  ]
  const stats = aggregateUsage(records)
  assert.equal(stats.grandTotal.inputTokens, 4000)
  assert.equal(stats.grandTotal.cachedInputTokens, 2100)
  assert.equal(stats.grandTotal.outputTokens, 600)
  assert.equal(stats.grandTotal.reasoningTokens, 150)
  assert.equal(stats.grandTotal.totalTokens, 6850)
})

test('aggregateUsage: empty usage records marked unavailable, not 0', () => {
  const records = [
    normalizeUsageRecord({ ts: 1, provider: 'codex', model: 'x', profileId: 'p1' }),
  ]
  const stats = aggregateUsage(records)
  const profile = stats.providers[0].models[0].profiles[0]
  assert.equal(profile.runCount, 1)
  assert.equal(profile.hasInput, false)
  assert.equal(profile.hasOutput, false)
  assert.equal(profile.hasTotal, false)
})

test('aggregateUsage: partial usage still sums available fields and marks missing unavailable', () => {
  const records = [
    normalizeUsageRecord({ ts: 1, provider: 'codex', model: 'x', profileId: 'p1', usage: { inputTokens: 500, outputTokens: 100 } }),
  ]
  const stats = aggregateUsage(records)
  const profile = stats.providers[0].models[0].profiles[0]
  assert.equal(profile.inputTokens, 500)
  assert.equal(profile.hasInput, true)
  assert.equal(profile.hasCached, false)
  assert.equal(profile.cachedInputTokens, 0)
  assert.equal(profile.hasReasoning, false)
  assert.equal(profile.reasoningTokens, 0)
})

test('aggregateUsage: filter by provider', () => {
  const records = [
    makeRecord({ provider: 'codex', usage: { inputTokens: 1000, totalTokens: 1000 } }),
    makeRecord({ provider: 'claude', usage: { inputTokens: 500, totalTokens: 500 } }),
  ]
  const stats = aggregateUsage(records, { provider: 'claude' })
  assert.equal(stats.providers.length, 1)
  assert.equal(stats.providers[0].provider, 'claude')
  assert.equal(stats.grandTotal.inputTokens, 500)
})

test('aggregateUsage: filter by model and profile', () => {
  const records = [
    makeRecord({ provider: 'codex', model: 'a', profileId: 'p1', usage: { inputTokens: 100, totalTokens: 100 } }),
    makeRecord({ provider: 'codex', model: 'a', profileId: 'p2', usage: { inputTokens: 200, totalTokens: 200 } }),
    makeRecord({ provider: 'codex', model: 'b', profileId: 'p1', usage: { inputTokens: 300, totalTokens: 300 } }),
  ]
  const stats = aggregateUsage(records, { model: 'a', profileId: 'p1' })
  assert.equal(stats.grandTotal.inputTokens, 100)
  assert.equal(stats.providers[0].models[0].profiles.length, 1)
})

test('aggregateUsage: filter by date range', () => {
  const records = [
    makeRecord({ ts: new Date('2026-01-01').getTime(), usage: { inputTokens: 100, totalTokens: 100 } }),
    makeRecord({ ts: new Date('2026-01-15').getTime(), usage: { inputTokens: 200, totalTokens: 200 } }),
    makeRecord({ ts: new Date('2026-02-01').getTime(), usage: { inputTokens: 300, totalTokens: 300 } }),
  ]
  const stats = aggregateUsage(records, { from: '2026-01-10', to: '2026-01-31' })
  assert.equal(stats.grandTotal.inputTokens, 200)
  assert.equal(stats.grandTotal.runCount, 1)
})

test('aggregateUsage: no records returns empty grand total and no providers', () => {
  const stats = aggregateUsage([])
  assert.equal(stats.grandTotal.runCount, 0)
  assert.equal(stats.providers.length, 0)
})

test('aggregateUsage: unknown model and profile are explicit groups', () => {
  const records = [
    normalizeUsageRecord({ ts: 1, provider: 'codex', usage: { inputTokens: 10, totalTokens: 10 } }),
  ]
  const stats = aggregateUsage(records)
  assert.equal(stats.providers[0].models[0].model, UNKNOWN_MODEL)
  assert.equal(stats.providers[0].models[0].profiles[0].profileId, UNKNOWN_PROFILE)
})

test('uniqueValues: returns sorted unique values', () => {
  const records = [
    makeRecord({ model: 'a' }),
    makeRecord({ model: 'b' }),
    makeRecord({ model: 'a' }),
  ]
  assert.deepEqual(uniqueValues(records, 'model'), ['a', 'b'])
})

test('uniqueValues: ignores records with no telemetry', () => {
  const records = [
    makeRecord({ model: 'a' }),
    normalizeUsageRecord({ ts: 1, provider: 'codex', usage: {} }),
  ]
  // Records with no telemetry have unknown model/profile; they should not pollute
  // filter dropdowns because selecting them would show nothing useful.
  assert.deepEqual(uniqueValues(records, 'model'), ['a'])
})
