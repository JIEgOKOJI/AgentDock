// Token usage aggregation for the Token Usage tab. Groups spend-ledger records
// by provider → model → profile and preserves "unknown" as distinct from 0.
//
// The aggregator only sums the *session total* fields of a usage object
// (input/cached/output/reasoning/total). Context-window fields are intentionally
// excluded because they describe the live window fill, not accumulated spend.

'use strict'

const tokenUsage = require('./token-usage.cjs')

const UNKNOWN_MODEL = 'Unknown'
const UNKNOWN_PROFILE = 'Unknown'

function emptyTotals() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    runCount: 0,
    firstTs: null,
    lastTs: null,
    hasInput: false,
    hasCached: false,
    hasOutput: false,
    hasReasoning: false,
    hasTotal: false,
  }
}

function addTotals(a, b) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    runCount: a.runCount + b.runCount,
    firstTs: a.firstTs == null ? b.firstTs : b.firstTs == null ? a.firstTs : Math.min(a.firstTs, b.firstTs),
    lastTs: a.lastTs == null ? b.lastTs : b.lastTs == null ? a.lastTs : Math.max(a.lastTs, b.lastTs),
    hasInput: a.hasInput || b.hasInput,
    hasCached: a.hasCached || b.hasCached,
    hasOutput: a.hasOutput || b.hasOutput,
    hasReasoning: a.hasReasoning || b.hasReasoning,
    hasTotal: a.hasTotal || b.hasTotal,
  }
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function isNonEmptyUsage(usage) {
  if (!usage || typeof usage !== 'object') return false
  // totalTokens is a computed sum. If only totalTokens is present without the
  // underlying component fields, treat it as the only known metric rather than
  // deriving unknown components as 0.
  return Number.isFinite(usage.totalTokens) ||
    Number.isFinite(usage.inputTokens) ||
    Number.isFinite(usage.cachedInputTokens) ||
    Number.isFinite(usage.outputTokens) ||
    Number.isFinite(usage.reasoningTokens)
}

// Normalize a raw ledger entry into a shape the UI can group reliably. Missing or
// invalid provider/model/profileId become explicit Unknown/Default groups; empty
// usage objects stay marked "unknown" rather than being coerced to 0.
function normalizeUsageRecord(entry) {
  if (!entry || typeof entry !== 'object') return null
  const ts = Number.isFinite(entry.ts) && entry.ts > 0 ? entry.ts : null
  const provider = typeof entry.provider === 'string' && entry.provider.trim() ? entry.provider.trim().toLowerCase() : 'unknown'
  const model = typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : UNKNOWN_MODEL
  const profileId = typeof entry.profileId === 'string' && entry.profileId.trim() ? entry.profileId.trim() : ''
  const rawUsage = entry.usage
  const hasUsage = isNonEmptyUsage(rawUsage)
  const usage = hasUsage ? tokenUsage.normalizeTokenUsage(rawUsage, { legacy: false }) : null
  return {
    ts,
    provider,
    model,
    profileId,
    usage,
    hasUsage,
    // Preserve which telemetry fields were actually present in the ledger so the
    // aggregator can distinguish missing fields from legitimate zeros.
    hasInput: hasUsage && Number.isFinite(rawUsage.inputTokens),
    hasCached: hasUsage && Number.isFinite(rawUsage.cachedInputTokens),
    hasOutput: hasUsage && Number.isFinite(rawUsage.outputTokens),
    hasReasoning: hasUsage && Number.isFinite(rawUsage.reasoningTokens),
    hasTotal: hasUsage && Number.isFinite(rawUsage.totalTokens),
  }
}

function totalsFromUsage(record) {
  const { usage, ts, hasInput, hasCached, hasOutput, hasReasoning, hasTotal } = record
  if (!usage) {
    return { ...emptyTotals(), runCount: 1, firstTs: ts, lastTs: ts }
  }
  return {
    inputTokens: hasInput ? number(usage.inputTokens) : 0,
    cachedInputTokens: hasCached ? number(usage.cachedInputTokens) : 0,
    outputTokens: hasOutput ? number(usage.outputTokens) : 0,
    reasoningTokens: hasReasoning ? number(usage.reasoningTokens) : 0,
    totalTokens: hasTotal ? number(usage.totalTokens) : 0,
    runCount: 1,
    firstTs: ts,
    lastTs: ts,
    hasInput,
    hasCached,
    hasOutput,
    hasReasoning,
    hasTotal,
  }
}

function matchesFilter(value, filter) {
  if (filter == null || filter === '') return true
  return value === filter
}

function aggregateUsage(records, options = {}) {
  const providerFilter = options.provider
  const modelFilter = options.model
  const profileIdFilter = options.profileId
  const fromTs = options.from ? new Date(options.from).getTime() : null
  const toTs = options.to ? new Date(options.to).getTime() : null

  const groups = new Map() // key: provider
  let grandTotal = emptyTotals()

  for (const record of records) {
    if (!record) continue

    if (providerFilter != null && record.provider !== providerFilter) continue
    if (modelFilter != null && record.model !== modelFilter) continue
    if (profileIdFilter != null && record.profileId !== profileIdFilter) continue
    if (fromTs != null && record.ts != null && record.ts < fromTs) continue
    if (toTs != null && record.ts != null && record.ts > toTs) continue

    const totals = totalsFromUsage(record)
    grandTotal = addTotals(grandTotal, totals)

    if (!groups.has(record.provider)) groups.set(record.provider, new Map())
    const providerNode = groups.get(record.provider)

    if (!providerNode.has(record.model)) providerNode.set(record.model, new Map())
    const modelNode = providerNode.get(record.model)

    const profileKey = record.profileId || UNKNOWN_PROFILE
    const existing = modelNode.get(profileKey) || emptyTotals()
    modelNode.set(profileKey, addTotals(existing, totals))
  }

  return {
    grandTotal,
    providers: [...groups.entries()].map(([provider, models]) => ({
      provider,
      models: [...models.entries()].map(([model, profiles]) => ({
        model,
        profiles: [...profiles.entries()].map(([profileId, totals]) => ({ profileId, ...totals })),
        ...sumProfiles(profiles),
      })),
      ...sumProvider(models),
    })),
  }
}

function sumProfiles(profiles) {
  let result = emptyTotals()
  for (const totals of profiles.values()) {
    result = addTotals(result, totals)
  }
  return result
}

function sumProvider(models) {
  let result = emptyTotals()
  for (const model of models.values()) {
    for (const totals of model.values()) {
      result = addTotals(result, totals)
    }
  }
  return result
}

function uniqueValues(records, field) {
  const seen = new Set()
  const values = []
  for (const record of records) {
    if (!record) continue
    const value = record[field]
    if (value == null) continue
    if (field === 'model' && value === UNKNOWN_MODEL && record.hasUsage === false) continue
    if (field === 'profileId' && value === '' && record.hasUsage === false) continue
    const displayValue = field === 'profileId' && value === '' ? UNKNOWN_PROFILE : value
    if (!seen.has(displayValue)) {
      seen.add(displayValue)
      values.push(displayValue)
    }
  }
  return values.sort()
}

module.exports = {
  normalizeUsageRecord,
  aggregateUsage,
  uniqueValues,
  UNKNOWN_MODEL,
  UNKNOWN_PROFILE,
}
