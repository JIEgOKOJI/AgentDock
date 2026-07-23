const crypto = require('node:crypto')
const { normalizeTokenUsage, emptyTokenUsage, CONTEXT_UNKNOWN, CONTEXT_ESTIMATED, CONTEXT_RUNTIME } = require('./token-usage.cjs')
const { CONTEXT_STATUS_REPORTED, CONTEXT_STATUS_ESTIMATED, CONTEXT_STATUS_UNKNOWN, COMPONENT_CATEGORIES, estimateTokens } = require('./context-usage-shared.cjs')

function makePreview(text, maxLength = 300) {
  if (text == null || typeof text !== 'string') return { preview: '', truncated: false, hash: null }
  const normalized = text.replace(/\s+/g, ' ').trim()
  const truncated = normalized.length > maxLength
  const preview = truncated ? normalized.slice(0, maxLength) : normalized
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
  return { preview, truncated, hash }
}

function createContextItem({ category, source, runId = null, agent = null, text, status, tokens }) {
  const tokenInfo = tokens != null ? { tokens, status: status || CONTEXT_STATUS_REPORTED } : estimateTokens(text)
  const preview = makePreview(text)
  return {
    id: `${category}-${crypto.randomUUID().slice(0, 8)}`,
    category,
    source,
    runId,
    agent,
    chars: typeof text === 'string' ? text.length : 0,
    tokens: tokenInfo.tokens,
    status: tokenInfo.status,
    preview: preview.preview,
    truncated: preview.truncated,
    hash: preview.hash,
  }
}

function createContextInvocation({ runId, parentRunId = null, provider, model, runType, pipelineStep = null, startedAt = Date.now() }) {
  return {
    runId,
    parentRunId,
    provider,
    model,
    runType,
    pipelineStep,
    startedAt,
    components: [],
    usage: null,
  }
}

function sumComponents(components) {
  let reported = 0
  let estimated = 0
  let unknown = 0
  for (const component of components) {
    if (component.tokens == null) unknown += 1
    else if (component.status === CONTEXT_STATUS_REPORTED) reported += component.tokens
    else if (component.status === CONTEXT_STATUS_ESTIMATED) estimated += component.tokens
    else unknown += component.tokens
  }
  return { reported, estimated, unknown }
}

function reconcileInvocation(invocation, providerUsage) {
  const usage = normalizeTokenUsage(providerUsage) || emptyTokenUsage()
  const known = sumComponents(invocation.components)
  const knownTotal = known.reported + known.estimated
  const input = usage.inputTokens ?? 0
  const cached = usage.cachedInputTokens ?? 0
  const providerInput = input + cached
  let discrepancy = null
  if (providerInput > 0) {
    if (knownTotal === 0) {
      const unknown = createContextItem({
        category: COMPONENT_CATEGORIES.providerSystemState,
        source: 'provider-cli',
        runId: invocation.runId,
        agent: invocation.agent,
        text: 'Provider-reported input tokens; individual components are unknown.',
        status: CONTEXT_STATUS_UNKNOWN,
        tokens: providerInput,
      })
      invocation.components.push(unknown)
    } else if (providerInput > knownTotal) {
      discrepancy = providerInput - knownTotal
      invocation.components.push(createContextItem({
        category: COMPONENT_CATEGORIES.providerOverhead,
        source: 'provider-reconciliation',
        runId: invocation.runId,
        agent: invocation.agent,
        text: `Provider reported ${providerInput} input tokens; known components account for ${knownTotal}.`,
        status: CONTEXT_STATUS_REPORTED,
        tokens: discrepancy,
      }))
    } else if (providerInput < knownTotal) {
      discrepancy = knownTotal - providerInput
    }
  }
  invocation.usage = { ...usage, discrepancy }
  return invocation
}

function aggregateSessionSummary(invocations, originalMessages = []) {
  const reportedByCategory = {}
  const estimatedByCategory = {}
  const unknownByCategory = {}
  const seenRunIds = new Set()
  const components = []
  for (const invocation of invocations) {
    if (!invocation || !invocation.runId) continue
    const isNewRun = !seenRunIds.has(invocation.runId)
    if (isNewRun) seenRunIds.add(invocation.runId)
    for (const component of invocation.components || []) {
      const target = isNewRun ? components : components.filter((c) => c.runId !== invocation.runId)
      components.push(component)
      const bucket = component.status === CONTEXT_STATUS_REPORTED ? reportedByCategory
        : component.status === CONTEXT_STATUS_ESTIMATED ? estimatedByCategory
          : unknownByCategory
      bucket[component.category] = (bucket[component.category] || 0) + (component.tokens ?? 0)
    }
  }
  const byCategory = Object.keys(COMPONENT_CATEGORIES).reduce((acc, key) => {
    const category = COMPONENT_CATEGORIES[key]
    acc[category] = {
      reported: reportedByCategory[category] || 0,
      estimated: estimatedByCategory[category] || 0,
      unknown: unknownByCategory[category] || 0,
    }
    return acc
  }, {})
  const accumulatedUsage = invocations.reduce((total, invocation) => {
    const usage = invocation?.usage
    if (!usage) return total
    return {
      inputTokens: total.inputTokens + (usage.inputTokens || 0),
      cachedInputTokens: total.cachedInputTokens + (usage.cachedInputTokens || 0),
      outputTokens: total.outputTokens + (usage.outputTokens || 0),
      reasoningTokens: total.reasoningTokens + (usage.reasoningTokens || 0),
      totalTokens: total.totalTokens + (usage.totalTokens || 0),
    }
  }, emptyTokenUsage())
  return {
    components,
    byCategory,
    accumulatedUsage,
    invocationCount: seenRunIds.size,
    originalMessages,
    unknownExplanation: 'Provider system prompts and CLI internal state are not visible to AgentDock; they are marked as unknown.',
  }
}

function buildLegacySummary(messages, provider, model) {
  const userMessages = messages.filter((m) => m.role === 'user' && m.id !== 'hello').map((m) => m.content)
  const assistantMessages = messages.filter((m) => m.role === 'assistant' && m.id !== 'hello').map((m) => m.content)
  const components = []
  if (userMessages.length) {
    components.push(createContextItem({
      category: COMPONENT_CATEGORIES.userRequest,
      source: 'session-transcript',
      text: userMessages.join('\n\n'),
      status: CONTEXT_STATUS_ESTIMATED,
      tokens: null,
    }))
  }
  if (assistantMessages.length) {
    components.push(createContextItem({
      category: COMPONENT_CATEGORIES.portableContext,
      source: 'session-transcript',
      text: assistantMessages.join('\n\n'),
      status: CONTEXT_STATUS_ESTIMATED,
      tokens: null,
    }))
  }
  return {
    components,
    byCategory: {},
    accumulatedUsage: emptyTokenUsage(),
    invocationCount: 0,
    originalMessages: userMessages,
    unknownExplanation: 'This session predates per-invocation context manifests. User and assistant messages are estimated; provider-reported usage and call history are unavailable.',
    legacy: true,
    provider,
    model,
  }
}

function buildEmptySummary() {
  return {
    components: [],
    byCategory: {},
    accumulatedUsage: emptyTokenUsage(),
    invocationCount: 0,
    originalMessages: [],
    unknownExplanation: 'No model calls have been made in this session yet.',
  }
}

function contextSnapshot(invocation) {
  if (!invocation) return null
  return {
    runId: invocation.runId,
    parentRunId: invocation.parentRunId,
    provider: invocation.provider,
    model: invocation.model,
    runType: invocation.runType,
    pipelineStep: invocation.pipelineStep,
    startedAt: invocation.startedAt,
    reported: sumComponents(invocation.components).reported,
    estimated: sumComponents(invocation.components).estimated,
    unknown: sumComponents(invocation.components).unknown,
    contextWindow: invocation.usage?.contextWindow || null,
    contextTokens: invocation.usage?.contextTokens || null,
  }
}

module.exports = {
  COMPONENT_CATEGORIES,
  CONTEXT_STATUS_REPORTED,
  CONTEXT_STATUS_ESTIMATED,
  CONTEXT_STATUS_UNKNOWN,
  createContextItem,
  createContextInvocation,
  sumComponents,
  reconcileInvocation,
  aggregateSessionSummary,
  buildLegacySummary,
  buildEmptySummary,
  contextSnapshot,
  estimateTokens,
  makePreview,
}
