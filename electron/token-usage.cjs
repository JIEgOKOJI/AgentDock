// Single source of truth for token-usage extraction and aggregation, shared by
// the renderer (src/App.tsx) and the main process (electron/main.cjs). Both the
// live context-window fill and the session totals are derived here so the two
// surfaces cannot diverge.
//
// Two independent metrics are kept:
//   - contextTokens (nullable): the most accurate fill of the live context
//     window for the latest authoritative turn. null means "unknown" — the UI
//     must NOT render it as 0%.
//   - session totals (input/cached/output/reasoning/total): accumulated across
//     all completed turns.
//
// Per-provider semantics:
//   - Codex: prefer the CLI-reported used-context + window (token_count /
//     turn.completed info). Fall back to last-turn input_tokens (which already
//     reflects accumulated context) — never add output_tokens to context.
//   - Claude: contextTokens = last result input (+ cache_read, the tokens
//     actually re-sent). Never add output_tokens or cache_creation to the live
//     context figure. Prefer modelUsage.contextWindow as a runtime window.
//   - OpenCode: aggregate steps for totals; contextTokens from the LAST step's
//     context only. Repeated step_finish events are not double-counted for
//     context (only totals sum).

'use strict'

const CONTEXT_RUNTIME = 'runtime'
const CONTEXT_MODEL_META = 'model-meta'
const CONTEXT_FALLBACK = 'fallback'
const CONTEXT_ESTIMATED = 'estimated'
const CONTEXT_UNKNOWN = 'unknown'

function emptyTokenUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    contextTokens: null,
    contextWindow: null,
    contextSource: CONTEXT_UNKNOWN,
    contextWindowSource: CONTEXT_UNKNOWN,
  }
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

// Vetted per-model context-window fallbacks. Only used when no runtime event
// and no model metadata expose a window. Kept conservative and keyed on the
// exact model id so we never attribute a window to the wrong model.
const CONTEXT_FALLBACKS = {
  codex: {
    'gpt-5.6-sol': 400000,
    'gpt-5.6': 400000,
    'gpt-5.5': 400000,
    'gpt-5': 400000,
    'gpt-5-codex': 400000,
  },
  claude: {
    sonnet: 200000,
    opus: 200000,
    haiku: 200000,
    fable: 200000,
  },
}

function fallbackContextWindow(provider, model) {
  if (!model) return null
  const table = CONTEXT_FALLBACKS[provider]
  const value = table && table[model]
  return value ? value : null
}

// Resolve the context window with a clear priority chain. Returns the window
// and the source it came from so callers can distinguish exact from fallback.
function resolveContextWindow(provider, model, runtimeWindow, modelMetaWindow) {
  if (runtimeWindow && Number.isFinite(runtimeWindow) && runtimeWindow > 0) {
    return { window: runtimeWindow, source: CONTEXT_RUNTIME }
  }
  if (modelMetaWindow && Number.isFinite(modelMetaWindow) && modelMetaWindow > 0) {
    return { window: modelMetaWindow, source: CONTEXT_MODEL_META }
  }
  const fallback = fallbackContextWindow(provider, model)
  if (fallback) return { window: fallback, source: CONTEXT_FALLBACK }
  return { window: null, source: CONTEXT_UNKNOWN }
}

// Pick the authoritative context value from a single parsed event. Returns
// { contextTokens, source, runtimeWindow } where runtimeWindow, if present,
// is a window reported by the event itself (supersedes metadata).
function codexContextFromEvent(event) {
  // Codex app-server reports live context via token_count events carrying
  // used-context + window. Prefer that over turn.completed usage sums.
  const tokenCount = event?.type === 'token_count' ? event : null
  if (tokenCount) {
    const used = number(tokenCount.usedTokens ?? tokenCount.used_tokens ?? tokenCount.contextTokens ?? tokenCount.tokens)
    const window = number(tokenCount.contextWindow ?? tokenCount.context_window ?? tokenCount.maxTokens ?? tokenCount.max_tokens)
    if (used > 0) return { contextTokens: used, source: CONTEXT_RUNTIME, runtimeWindow: window || null }
  }
  // turn.completed carries an `info` blob that may include context usage.
  if (event?.type === 'turn.completed' && event.info && typeof event.info === 'object') {
    const used = number(event.info.usedTokens ?? event.info.used_tokens ?? event.info.contextTokens ?? event.info.context_tokens)
    const window = number(event.info.contextWindow ?? event.info.context_window ?? event.info.maxContextTokens ?? event.info.max_context_tokens)
    if (used > 0) return { contextTokens: used, source: CONTEXT_RUNTIME, runtimeWindow: window || null }
  }
  return null
}

function claudeContextFromEvent(event) {
  if (event?.type !== 'result' || !event.usage) return null
  // The tokens actually re-sent into the model: input + cache_read. We do NOT
  // add output_tokens or cache_creation to the live context figure — those are
  // session totals only.
  const input = number(event.usage.input_tokens)
  const cacheRead = number(event.usage.cache_read_input_tokens)
  const contextTokens = input + cacheRead
  if (contextTokens > 0) {
    const modelUsage = event.modelUsage && typeof event.modelUsage === 'object'
      ? Object.values(event.modelUsage)[0]
      : null
    const runtimeWindow = number(modelUsage?.contextWindow)
    return { contextTokens, source: CONTEXT_ESTIMATED, runtimeWindow: runtimeWindow || null }
  }
  return null
}

function extractTokenUsage(provider, raw, options = {}) {
  const modelContextWindow = options.modelContextWindow ?? options.contextWindow
  const model = options.model || ''
  let usage = null
  const openCodeSteps = []

  // Track the latest context-bearing event per provider so multiple events of
  // one run do not produce double-counting — only the final authoritative one
  // supplies contextTokens.
  let lastContext = null
  let lastRuntimeWindow = null

  for (const line of String(raw || '').split(/\r?\n/).filter(Boolean)) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }

    if (provider === 'codex') {
      const ctx = codexContextFromEvent(event)
      if (ctx) {
        lastContext = ctx
        if (ctx.runtimeWindow) lastRuntimeWindow = ctx.runtimeWindow
      }
      if (event.type === 'turn.completed' && event.usage) {
        const inputTokens = number(event.usage.input_tokens)
        const outputTokens = number(event.usage.output_tokens)
        usage = {
          inputTokens,
          cachedInputTokens: number(event.usage.cached_input_tokens),
          outputTokens,
          reasoningTokens: number(event.usage.reasoning_output_tokens),
          totalTokens: inputTokens + outputTokens,
          contextTokens: null,
          contextWindow: null,
          contextSource: CONTEXT_UNKNOWN,
          contextWindowSource: CONTEXT_UNKNOWN,
        }
      } else if (event.type === 'token_count' && !usage) {
        // Some Codex runs emit token_count without a turn.completed usage
        // payload. Synthesize a minimal usage so the runtime context is still
        // surfaced; session totals stay 0 until a turn.completed arrives.
        usage = { ...emptyTokenUsage() }
      }
    } else if (provider === 'claude' && event.type === 'result' && event.usage) {
      const inputTokens = number(event.usage.input_tokens)
      const cachedInputTokens = number(event.usage.cache_read_input_tokens) + number(event.usage.cache_creation_input_tokens)
      const outputTokens = number(event.usage.output_tokens)
      const modelUsage = event.modelUsage && typeof event.modelUsage === 'object'
        ? Object.values(event.modelUsage)[0]
        : null
      const runtimeWindow = number(modelUsage?.contextWindow)
      usage = {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningTokens: 0,
        totalTokens: inputTokens + cachedInputTokens + outputTokens,
        // context: tokens actually re-sent (input + cache_read), NOT output.
        contextTokens: inputTokens + number(event.usage.cache_read_input_tokens),
        contextWindow: runtimeWindow || null,
        contextSource: CONTEXT_ESTIMATED,
        contextWindowSource: runtimeWindow ? CONTEXT_RUNTIME : CONTEXT_UNKNOWN,
      }
    } else if (provider === 'opencode' && (event.type === 'step_finish' || event.type === 'step-finish') && event.part?.tokens) {
      const tokens = event.part.tokens
      const inputTokens = number(tokens.input)
      const cachedInputTokens = number(tokens.cache?.read) + number(tokens.cache?.write)
      const outputTokens = number(tokens.output)
      const reasoningTokens = number(tokens.reasoning)
      // Per-step context: input + cache_read (tokens re-sent), NOT output.
      const stepContext = inputTokens + number(tokens.cache?.read)
      openCodeSteps.push({
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningTokens,
        totalTokens: inputTokens + outputTokens + reasoningTokens,
        contextTokens: stepContext,
        contextWindow: null,
        contextSource: CONTEXT_ESTIMATED,
        contextWindowSource: CONTEXT_UNKNOWN,
      })
    }
  }

  if (provider === 'opencode' && openCodeSteps.length) {
    const last = openCodeSteps[openCodeSteps.length - 1]
    usage = openCodeSteps.reduce((total, step) => ({
      inputTokens: total.inputTokens + step.inputTokens,
      cachedInputTokens: total.cachedInputTokens + step.cachedInputTokens,
      outputTokens: total.outputTokens + step.outputTokens,
      reasoningTokens: total.reasoningTokens + step.reasoningTokens,
      totalTokens: total.totalTokens + step.totalTokens,
      contextTokens: last.contextTokens,
      contextWindow: last.contextWindow,
      contextSource: last.contextSource,
      contextWindowSource: last.contextWindowSource,
    }), emptyTokenUsage())
  }

  if (!usage) return null

  // Resolve the context window using the priority chain: runtime event →
  // model metadata → keyed fallback. The runtime window from the event
  // (lastRuntimeWindow / usage.contextWindow) supersedes the catalog value.
  const runtimeWindow = lastRuntimeWindow || usage.contextWindow || null
  const resolved = resolveContextWindow(provider, model, runtimeWindow, modelContextWindow)
  usage.contextWindow = resolved.window
  usage.contextWindowSource = resolved.source

  // For Codex, override the context with the authoritative runtime value when
  // available; otherwise fall back to the turn.completed input_tokens (which
  // already reflects accumulated context) — never the input+output sum.
  if (provider === 'codex') {
    if (lastContext) {
      usage.contextTokens = lastContext.contextTokens
      usage.contextSource = lastContext.source
      if (lastContext.runtimeWindow) {
        usage.contextWindow = lastContext.runtimeWindow
        usage.contextWindowSource = CONTEXT_RUNTIME
      }
    } else if (usage.inputTokens > 0) {
      usage.contextTokens = usage.inputTokens
      usage.contextSource = CONTEXT_ESTIMATED
    } else {
      usage.contextTokens = null
      usage.contextSource = CONTEXT_UNKNOWN
    }
  }

  return usage
}

// Merge a completed turn into the running session total. Session totals sum;
// contextTokens/contextWindow are taken from the latest turn (they describe
// the live window, not accumulated spend). A null contextTokens on the turn
// preserves a null on the total (unknown stays unknown, never 0).
function addTokenUsage(total, turn) {
  const next = {
    inputTokens: total.inputTokens + turn.inputTokens,
    cachedInputTokens: total.cachedInputTokens + turn.cachedInputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    reasoningTokens: total.reasoningTokens + turn.reasoningTokens,
    totalTokens: total.totalTokens + turn.totalTokens,
    contextTokens: turn.contextTokens,
    contextWindow: turn.contextWindow || total.contextWindow,
    contextSource: turn.contextSource || CONTEXT_UNKNOWN,
    contextWindowSource: turn.contextWindow ? turn.contextWindowSource : total.contextWindowSource,
  }
  return next
}

// Normalize a persisted usage object (from session storage) into the full
// shape, preserving unknowns rather than coercing them to 0. Old sessions that
// lack provenance fields are upgraded; sessions that predate per-lane usage
// (where contextTokens was the session sum) are detected via `legacy` and
// coerced to unknown context so the UI never shows a stale fill as current.
function normalizeTokenUsage(value, { legacy = false } = {}) {
  if (!value || typeof value !== 'object') return undefined
  const num = (field) => Number.isFinite(value[field]) ? Math.max(0, value[field]) : 0
  const contextWindow = Number.isFinite(value.contextWindow) && value.contextWindow > 0 ? value.contextWindow : null
  let contextTokens = Number.isFinite(value.contextTokens) ? Math.max(0, value.contextTokens) : null
  let contextSource = typeof value.contextSource === 'string' ? value.contextSource : CONTEXT_UNKNOWN
  let contextWindowSource = typeof value.contextWindowSource === 'string' ? value.contextWindowSource : (contextWindow ? CONTEXT_MODEL_META : CONTEXT_UNKNOWN)
  // Legacy sessions stored contextTokens as the session token sum — that is
  // NOT the live window fill, so mark it unknown rather than misrepresent it.
  if (legacy && contextTokens !== null && !value.contextSource) {
    contextTokens = null
    contextSource = CONTEXT_UNKNOWN
  }
  return {
    inputTokens: num('inputTokens'),
    cachedInputTokens: num('cachedInputTokens'),
    outputTokens: num('outputTokens'),
    reasoningTokens: num('reasoningTokens'),
    totalTokens: num('totalTokens'),
    contextTokens,
    contextWindow,
    contextSource,
    contextWindowSource,
  }
}

// Extract only the live-context fields from a usage object. Lanes persist this
// snapshot so that switching back to a lane restores its window fill without
// clobbering the session totals (which are tracked separately at the session
// level). Keeping context and totals separate prevents a lane's stale totals
// from replacing the current session totals on restore.
function contextSnapshot(usage) {
  if (!usage || typeof usage !== 'object') return null
  const contextTokens = Number.isFinite(usage.contextTokens) ? Math.max(0, usage.contextTokens) : null
  const contextWindow = Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null
  if (contextTokens === null && contextWindow === null && !usage.contextSource) return null
  return {
    contextTokens,
    contextWindow,
    contextSource: typeof usage.contextSource === 'string' ? usage.contextSource : CONTEXT_UNKNOWN,
    contextWindowSource: typeof usage.contextWindowSource === 'string' ? usage.contextWindowSource : (contextWindow ? CONTEXT_MODEL_META : CONTEXT_UNKNOWN),
  }
}

// Merge session totals (from session.usage) with a lane's live-context
// snapshot (from the lane). The totals describe the whole session; the context
// fields describe the active lane's window fill. The merge never lets a lane's
// stale totals overwrite the current session totals. When no lane context is
// present the totals are treated as legacy (contextTokens was the session sum)
// and coerced to unknown so the UI never shows the session sum as the live
// context fill.
function mergeUsageWithTotals(totals, context) {
  const ctx = context && typeof context === 'object'
    ? contextSnapshot(context)
    : null
  const base = totals && typeof totals === 'object'
    ? normalizeTokenUsage(totals, { legacy: !ctx })
    : undefined
  if (!base && !ctx) return undefined
  if (!base) return { ...emptyTokenUsage(), ...ctx }
  if (!ctx) return base
  return {
    ...base,
    contextTokens: ctx.contextTokens,
    contextWindow: ctx.contextWindow,
    contextSource: ctx.contextSource,
    contextWindowSource: ctx.contextWindowSource,
  }
}

// Resolve the live-context fields for a lane switch (provider/profile/model
// change). Lanes are keyed by provider+profile, NOT by model, so:
//   - On a MODEL switch the live context is always invalidated to unknown
//     (the lane's snapshot belongs to the previous model and does not apply).
//   - On a provider/profile switch the matching lane's context snapshot is
//     restored when present, otherwise the context is marked unknown so the
//     previous lane's fill never leaks across the switch.
// `currentUsage` supplies the totals that must survive the switch (they come
// from session.usage and are not affected by the lane). The returned object is
// a full TokenUsage with totals preserved and only the context fields changed.
function resolveLaneContext({ lanes, provider, profileId, model, availableModels, currentUsage, switchingModel }) {
  const key = `${provider}:${profileId || ''}`
  const lane = lanes && lanes[key]
  const selected = (availableModels || []).find((item) => item.id === model)
  const fallbackWindow = (selected && Number.isFinite(selected.contextWindow) && selected.contextWindow > 0) ? selected.contextWindow : null
  const fallbackWindowSource = (selected && typeof selected.contextWindowSource === 'string') ? selected.contextWindowSource : CONTEXT_UNKNOWN
  const base = currentUsage && typeof currentUsage === 'object'
    ? normalizeTokenUsage(currentUsage, { legacy: false })
    : emptyTokenUsage()
  if (switchingModel) {
    return {
      ...base,
      contextTokens: null,
      contextWindow: fallbackWindow,
      contextSource: CONTEXT_UNKNOWN,
      contextWindowSource: fallbackWindowSource,
    }
  }
  const snap = lane && lane.usage ? contextSnapshot(lane.usage) : null
  if (snap) {
    return {
      ...base,
      contextTokens: snap.contextTokens,
      contextWindow: snap.contextWindow || fallbackWindow,
      contextSource: snap.contextSource,
      contextWindowSource: snap.contextWindowSource !== CONTEXT_UNKNOWN ? snap.contextWindowSource : fallbackWindowSource,
    }
  }
  return {
    ...base,
    contextTokens: null,
    contextWindow: fallbackWindow,
    contextSource: CONTEXT_UNKNOWN,
    contextWindowSource: fallbackWindowSource,
  }
}

module.exports = {
  extractTokenUsage,
  addTokenUsage,
  emptyTokenUsage,
  normalizeTokenUsage,
  contextSnapshot,
  mergeUsageWithTotals,
  resolveLaneContext,
  fallbackContextWindow,
  resolveContextWindow,
  CONTEXT_RUNTIME,
  CONTEXT_MODEL_META,
  CONTEXT_FALLBACK,
  CONTEXT_ESTIMATED,
  CONTEXT_UNKNOWN,
}