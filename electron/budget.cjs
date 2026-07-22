const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const BUDGET_VERSION = 1

const PRICING_SNAPSHOT_VERSION = 1
const PRICING_SNAPSHOT_DATE = '2026-07-23'

const PROVIDER_COST_MODELS = {
  codex: { type: 'subscription', marginalCostPerRun: 0, marginalSubscription: true },
  claude: { type: 'subscription', marginalCostPerRun: 0, marginalSubscription: true },
  opencode: { type: 'api', inputPricePer1M: 2.5, outputPricePer1M: 10, cachedInputPricePer1M: 0.3 },
}

const DEFAULT_MODEL_OVERRIDES = {}

function pricingSnapshot() {
  return {
    version: PRICING_SNAPSHOT_VERSION,
    date: PRICING_SNAPSHOT_DATE,
    source: 'hardcoded',
    models: { ...PROVIDER_COST_MODELS },
  }
}

function getCostModel(provider, model) {
  const base = PROVIDER_COST_MODELS[provider] || PROVIDER_COST_MODELS.opencode
  const override = DEFAULT_MODEL_OVERRIDES[`${provider}:${model}`]
  return override ? { ...base, ...override } : base
}

function estimateRunCost(provider, model, usage) {
  if (!usage || typeof usage !== 'object') return { cost: 0, type: 'unknown', unverifiable: true }
  const costModel = getCostModel(provider, model)
  if (costModel.type === 'subscription') {
    return { cost: 0, type: 'subscription', unverifiable: false, marginalSubscription: Boolean(costModel.marginalSubscription) }
  }
  if (costModel.type === 'api') {
    const inputTokens = Number(usage.inputTokens) || 0
    const cachedInputTokens = Number(usage.cachedInputTokens) || 0
    const outputTokens = Number(usage.outputTokens) || 0
    const reasoningTokens = Number(usage.reasoningTokens) || 0
    const inputCost = (inputTokens / 1_000_000) * (costModel.inputPricePer1M || 0)
    const cachedCost = (cachedInputTokens / 1_000_000) * (costModel.cachedInputPricePer1M || 0)
    const outputCost = ((outputTokens + reasoningTokens) / 1_000_000) * (costModel.outputPricePer1M || 0)
    const cost = Math.round((inputCost + cachedCost + outputCost) * 1_000_000) / 1_000_000
    return { cost, type: 'api', unverifiable: false, breakdown: { inputCost, cachedCost, outputCost } }
  }
  return { cost: 0, type: 'unknown', unverifiable: true }
}

function normalizeBudget(value) {
  if (value == null) return { maxUsd: null, enabled: false, omitted: true }
  const num = typeof value === 'number' ? value : parseFloat(value)
  if (!Number.isFinite(num) || num < 0) return { maxUsd: null, enabled: false, omitted: true }
  if (num === 0) return { maxUsd: 0, enabled: true, omitted: false, zero: true }
  return { maxUsd: num, enabled: true, omitted: false }
}

function checkBudget(spend, budget) {
  if (!budget.enabled || budget.maxUsd == null) return { exceeded: false, remaining: null }
  const remaining = Math.round((budget.maxUsd - spend) * 1_000_000) / 1_000_000
  return { exceeded: spend >= budget.maxUsd, remaining: Math.max(0, remaining) }
}

function hasBudgetHeadroom(spend, budget) {
  if (!budget.enabled || budget.maxUsd == null) return { allowed: true, remaining: null }
  if (budget.zero) return { allowed: false, remaining: 0, reason: 'zero_budget' }
  const remaining = Math.round((budget.maxUsd - spend) * 1_000_000) / 1_000_000
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) }
}

function budgetDir(userData) {
  return path.join(userData, 'budget')
}

function ensureBudgetDir(userData) {
  const dir = budgetDir(userData)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function ledgerPath(userData, sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  return path.join(budgetDir(userData), `${safe}.jsonl`)
}

function appendSpendEntry(userData, sessionId, entry) {
  if (!entry || typeof entry !== 'object') return
  try {
    ensureBudgetDir(userData)
    const line = JSON.stringify({ ts: Date.now(), ...entry })
    fs.appendFileSync(ledgerPath(userData, sessionId), `${line}\n`, 'utf8')
  } catch {}
}

function readSpendLedger(userData, sessionId) {
  try {
    const content = fs.readFileSync(ledgerPath(userData, sessionId), 'utf8')
    return content.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

function totalSpend(entries) {
  if (!Array.isArray(entries)) return 0
  return entries.reduce((sum, entry) => sum + (Number(entry.cost) || 0), 0)
}

function sessionSpend(userData, sessionId) {
  return totalSpend(readSpendLedger(userData, sessionId))
}

function profileSpend(userData, sessionId, profileId) {
  const entries = readSpendLedger(userData, sessionId)
  return totalSpend(entries.filter((entry) => entry.profileId === profileId))
}

const reservations = new Map()

function reserveBudget(sessionId, amount, metadata = {}) {
  const key = String(sessionId || '')
  if (!reservations.has(key)) reservations.set(key, { total: 0, items: [] })
  const ledger = reservations.get(key)
  const id = crypto.randomUUID().slice(0, 8)
  ledger.items.push({ id, amount, ts: Date.now(), ...metadata })
  ledger.total = Math.round((ledger.total + amount) * 1_000_000) / 1_000_000
  return { id, reserved: amount, totalReserved: ledger.total }
}

function releaseReservation(sessionId, reservationId) {
  const key = String(sessionId || '')
  const ledger = reservations.get(key)
  if (!ledger) return false
  const item = ledger.items.find((i) => i.id === reservationId)
  if (!item) return false
  ledger.items = ledger.items.filter((i) => i.id !== reservationId)
  ledger.total = Math.round((ledger.total - item.amount) * 1_000_000) / 1_000_000
  return true
}

function settleReservation(sessionId, reservationId, actualCost) {
  const key = String(sessionId || '')
  const ledger = reservations.get(key)
  if (!ledger) return false
  const item = ledger.items.find((i) => i.id === reservationId)
  if (!item) return false
  const delta = Math.round((actualCost - item.amount) * 1_000_000) / 1_000_000
  ledger.items = ledger.items.filter((i) => i.id !== reservationId)
  ledger.total = Math.round((ledger.total + delta) * 1_000_000) / 1_000_000
  return true
}

function totalReserved(sessionId) {
  const ledger = reservations.get(String(sessionId || ''))
  return ledger ? ledger.total : 0
}

function clearReservations(sessionId) {
  reservations.delete(String(sessionId || ''))
}

module.exports = {
  BUDGET_VERSION,
  PRICING_SNAPSHOT_VERSION,
  PRICING_SNAPSHOT_DATE,
  PROVIDER_COST_MODELS,
  pricingSnapshot,
  getCostModel,
  estimateRunCost,
  normalizeBudget,
  checkBudget,
  hasBudgetHeadroom,
  budgetDir,
  ensureBudgetDir,
  ledgerPath,
  appendSpendEntry,
  readSpendLedger,
  totalSpend,
  sessionSpend,
  profileSpend,
  reserveBudget,
  releaseReservation,
  settleReservation,
  totalReserved,
  clearReservations,
}