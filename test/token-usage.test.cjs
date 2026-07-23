const test = require('node:test')
const assert = require('node:assert/strict')

const tokenUsage = require('../electron/token-usage.cjs')
const lanes = require('../electron/lanes.cjs')

const { extractTokenUsage, addTokenUsage, emptyTokenUsage, normalizeTokenUsage, fallbackContextWindow, resolveContextWindow } = tokenUsage

// --- Codex: real turn.completed variant ---

test('codex: turn.completed yields session totals and estimated context = input_tokens', () => {
  const raw = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 12000, output_tokens: 800, cached_input_tokens: 4000, reasoning_output_tokens: 200 },
  })
  const usage = extractTokenUsage('codex', raw, { model: 'gpt-5.6-sol' })
  assert.equal(usage.inputTokens, 12000)
  assert.equal(usage.outputTokens, 800)
  assert.equal(usage.cachedInputTokens, 4000)
  assert.equal(usage.reasoningTokens, 200)
  assert.equal(usage.totalTokens, 12800)
  // context = input_tokens (accumulated context), NOT input + output
  assert.equal(usage.contextTokens, 12000)
  assert.equal(usage.contextSource, 'estimated')
  // window from keyed fallback (no runtime window reported)
  assert.equal(usage.contextWindow, 400000)
  assert.equal(usage.contextWindowSource, 'fallback')
})

test('codex: token_count runtime event supersedes turn.completed for context', () => {
  const raw = [
    { type: 'token_count', usedTokens: 95000, contextWindow: 400000 },
    { type: 'turn.completed', usage: { input_tokens: 12000, output_tokens: 800 } },
  ].map(JSON.stringify).join('\n')
  const usage = extractTokenUsage('codex', raw, { model: 'gpt-5.6-sol' })
  assert.equal(usage.contextTokens, 95000)
  assert.equal(usage.contextSource, 'runtime')
  assert.equal(usage.contextWindow, 400000)
  assert.equal(usage.contextWindowSource, 'runtime')
  // session totals still from turn.completed
  assert.equal(usage.inputTokens, 12000)
  assert.equal(usage.outputTokens, 800)
})

test('codex: multiple token_count events pick the last authoritative one', () => {
  const raw = [
    { type: 'token_count', usedTokens: 10000, contextWindow: 400000 },
    { type: 'token_count', usedTokens: 50000, contextWindow: 400000 },
  ].map(JSON.stringify).join('\n')
  const usage = extractTokenUsage('codex', raw, { model: 'gpt-5.6-sol' })
  assert.equal(usage.contextTokens, 50000)
})

// --- Claude: real result variant ---

test('claude: result context = input + cache_read, never output or cache_creation', () => {
  const raw = JSON.stringify({
    type: 'result',
    usage: { input_tokens: 50000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 5000, output_tokens: 4000 },
  })
  const usage = extractTokenUsage('claude', raw, { model: 'sonnet' })
  assert.equal(usage.inputTokens, 50000)
  assert.equal(usage.cachedInputTokens, 35000) // cache_read + cache_creation for totals
  assert.equal(usage.outputTokens, 4000)
  assert.equal(usage.totalTokens, 89000)
  // live context = input + cache_read only
  assert.equal(usage.contextTokens, 80000)
  assert.equal(usage.contextSource, 'estimated')
  assert.equal(usage.contextWindow, 200000)
  assert.equal(usage.contextWindowSource, 'fallback')
})

test('claude: modelUsage.contextWindow supersedes fallback as runtime window', () => {
  const raw = JSON.stringify({
    type: 'result',
    usage: { input_tokens: 1000, output_tokens: 500 },
    modelUsage: { 'claude-sonnet-4': { contextWindow: 1000000 } },
  })
  const usage = extractTokenUsage('claude', raw, { model: 'sonnet' })
  assert.equal(usage.contextWindow, 1000000)
  assert.equal(usage.contextWindowSource, 'runtime')
})

// --- OpenCode: step aggregation ---

test('opencode: totals sum across steps; context from last step only', () => {
  const raw = [
    { type: 'step_finish', part: { tokens: { input: 1000, output: 200, cache: { read: 500, write: 100 }, reasoning: 50 } } },
    { type: 'step_finish', part: { tokens: { input: 3000, output: 400, cache: { read: 1500, write: 0 }, reasoning: 100 } } },
  ].map(JSON.stringify).join('\n')
  const usage = extractTokenUsage('opencode', raw, { modelContextWindow: 200000 })
  assert.equal(usage.inputTokens, 4000)
  assert.equal(usage.outputTokens, 600)
  assert.equal(usage.cachedInputTokens, 2100)
  assert.equal(usage.reasoningTokens, 150)
  // context = last step input + cache_read
  assert.equal(usage.contextTokens, 4500)
  assert.equal(usage.contextWindow, 200000)
})

test('opencode: handles both step_finish and step-finish event names', () => {
  const raw = [
    { type: 'step-finish', part: { tokens: { input: 500, output: 100, cache: { read: 0, write: 0 }, reasoning: 0 } } },
    { type: 'step_finish', part: { tokens: { input: 2000, output: 300, cache: { read: 800, write: 0 }, reasoning: 0 } } },
  ].map(JSON.stringify).join('\n')
  const usage = extractTokenUsage('opencode', raw, { modelContextWindow: 200000 })
  assert.equal(usage.inputTokens, 2500)
  assert.equal(usage.contextTokens, 2800)
})

// --- Aggregation: session totals vs live context ---

test('addTokenUsage: session totals sum; context reflects latest turn', () => {
  const total = emptyTokenUsage()
  const turn1 = extractTokenUsage('codex', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10000, output_tokens: 500 } }), { model: 'gpt-5.6-sol' })
  const turn2 = extractTokenUsage('codex', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20000, output_tokens: 800 } }), { model: 'gpt-5.6-sol' })
  const after1 = addTokenUsage(total, turn1)
  const after2 = addTokenUsage(after1, turn2)
  assert.equal(after2.inputTokens, 30000) // summed
  assert.equal(after2.outputTokens, 1300) // summed
  assert.equal(after2.totalTokens, 31300)
  assert.equal(after2.contextTokens, 20000) // latest turn only
})

test('addTokenUsage: null contextTokens on a turn preserves null on total', () => {
  const total = emptyTokenUsage()
  const turn = { ...emptyTokenUsage(), inputTokens: 100, contextTokens: null, contextSource: 'unknown' }
  const after = addTokenUsage(total, turn)
  assert.equal(after.contextTokens, null)
  assert.equal(after.contextSource, 'unknown')
})

// --- Restore: legacy session context is unknown, not the session sum ---

test('normalizeTokenUsage legacy: coerces old contextTokens sum to unknown', () => {
  const legacy = normalizeTokenUsage({
    inputTokens: 50000, outputTokens: 5000, totalTokens: 55000,
    contextTokens: 55000, contextWindow: 200000, // old schema: contextTokens was the session sum
  }, { legacy: true })
  assert.equal(legacy.inputTokens, 50000)
  assert.equal(legacy.totalTokens, 55000) // session totals preserved
  assert.equal(legacy.contextTokens, null) // not the live fill
  assert.equal(legacy.contextSource, 'unknown')
  assert.equal(legacy.contextWindow, 200000)
})

test('normalizeTokenUsage non-legacy: preserves contextTokens with provenance', () => {
  const value = normalizeTokenUsage({
    inputTokens: 100, outputTokens: 50, totalTokens: 150,
    contextTokens: 80000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime',
  })
  assert.equal(value.contextTokens, 80000)
  assert.equal(value.contextSource, 'runtime')
})

test('normalizeTokenUsage: undefined for non-object input', () => {
  assert.equal(normalizeTokenUsage(null), undefined)
  assert.equal(normalizeTokenUsage(undefined), undefined)
})

// --- Fallback table ---

test('fallbackContextWindow: returns vetted windows for known models', () => {
  assert.equal(fallbackContextWindow('codex', 'gpt-5.6-sol'), 400000)
  assert.equal(fallbackContextWindow('claude', 'sonnet'), 200000)
  assert.equal(fallbackContextWindow('codex', 'unknown-model'), null)
})

test('resolveContextWindow: runtime supersedes metadata supersedes fallback', () => {
  assert.deepEqual(resolveContextWindow('codex', 'gpt-5.6-sol', 500000, 400000), { window: 500000, source: 'runtime' })
  assert.deepEqual(resolveContextWindow('codex', 'gpt-5.6-sol', null, 400000), { window: 400000, source: 'model-meta' })
  assert.deepEqual(resolveContextWindow('codex', 'gpt-5.6-sol', null, null), { window: 400000, source: 'fallback' })
  assert.deepEqual(resolveContextWindow('codex', 'unknown-model', null, null), { window: null, source: 'unknown' })
})

// --- Per-lane usage persistence ---

test('lanes: setLaneState persists usage and normalizeLaneState restores it', () => {
  const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, contextTokens: 80000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime', cachedInputTokens: 0, reasoningTokens: 0 }
  const lanesMap = lanes.setLaneState({}, 'codex', 'work', { cliSessionId: 'abc', usage })
  const restored = lanes.normalizeLaneState(lanes.getLaneState(lanesMap, 'codex', 'work'))
  assert.ok(restored.usage)
  assert.equal(restored.usage.contextTokens, 80000)
  assert.equal(restored.usage.contextSource, 'runtime')
  assert.equal(restored.cliSessionId, 'abc')
})

test('lanes: normalizeLaneState drops non-object usage gracefully', () => {
  const restored = lanes.normalizeLaneState({ cliSessionId: 'x', usage: 'not-an-object' })
  assert.equal(restored.usage, undefined)
  assert.equal(restored.cliSessionId, 'x')
})

// --- Model switch: unknown context, not 0 ---

test('codex: unknown model with no fallback yields null contextWindow and unknown source', () => {
  const raw = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 100 } })
  const usage = extractTokenUsage('codex', raw, { model: 'totally-unknown-model' })
  assert.equal(usage.contextWindow, null)
  assert.equal(usage.contextWindowSource, 'unknown')
  // context is estimated from input_tokens
  assert.equal(usage.contextTokens, 1000)
  assert.equal(usage.contextSource, 'estimated')
})

test('no usage events: extractTokenUsage returns null (no false 0%)', () => {
  assert.equal(extractTokenUsage('codex', '', { model: 'gpt-5.6-sol' }), null)
  assert.equal(extractTokenUsage('codex', 'not json at all', { model: 'gpt-5.6-sol' }), null)
})

// --- Lane context snapshot: totals vs context separation (req #1) ---

test('contextSnapshot: extracts only context fields, drops totals', () => {
  const snap = tokenUsage.contextSnapshot({
    inputTokens: 50000, outputTokens: 5000, totalTokens: 55000,
    contextTokens: 80000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime',
    cachedInputTokens: 0, reasoningTokens: 0,
  })
  assert.deepEqual(snap, { contextTokens: 80000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime' })
})

test('contextSnapshot: returns null when no context is present', () => {
  assert.equal(tokenUsage.contextSnapshot({ inputTokens: 100, outputTokens: 50 }), null)
  assert.equal(tokenUsage.contextSnapshot(null), null)
})

test('mergeUsageWithTotals: totals from session, context from lane (req #1)', () => {
  const sessionTotals = { inputTokens: 50000, outputTokens: 5000, totalTokens: 55000, contextTokens: 55000, contextWindow: null }
  const laneContext = { contextTokens: 80000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime' }
  const merged = tokenUsage.mergeUsageWithTotals(sessionTotals, laneContext)
  assert.equal(merged.inputTokens, 50000)
  assert.equal(merged.totalTokens, 55000) // session totals preserved, NOT lane's
  assert.equal(merged.contextTokens, 80000) // lane context, NOT session sum
  assert.equal(merged.contextSource, 'runtime')
  assert.equal(merged.contextWindow, 200000)
})

test('mergeUsageWithTotals: lane totals never overwrite session totals (A→B→A)', () => {
  // After turns in lane A (totals 30000) then lane B (totals 20000), lane A's
  // stored totals (30000) must NOT replace the current session totals when
  // switching back to A. Session totals are authoritative.
  const currentSessionTotals = { inputTokens: 50000, outputTokens: 5000, totalTokens: 55000 }
  const laneA_staleTotals = { inputTokens: 30000, outputTokens: 3000, totalTokens: 33000, contextTokens: 40000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime' }
  const merged = tokenUsage.mergeUsageWithTotals(currentSessionTotals, laneA_staleTotals)
  assert.equal(merged.totalTokens, 55000) // session totals, NOT lane A's stale 33000
  assert.equal(merged.contextTokens, 40000) // lane A's context restored
})

test('mergeUsageWithTotals: legacy session without lane yields unknown context (req #7)', () => {
  const legacyTotals = { inputTokens: 50000, outputTokens: 5000, totalTokens: 55000, contextTokens: 55000 }
  const merged = tokenUsage.mergeUsageWithTotals(legacyTotals, null)
  assert.equal(merged.totalTokens, 55000) // totals preserved
  // legacy contextTokens was the session sum — coerced to unknown
  assert.equal(merged.contextTokens, null)
  assert.equal(merged.contextSource, 'unknown')
})

test('mergeUsageWithTotals: empty inputs return undefined', () => {
  assert.equal(tokenUsage.mergeUsageWithTotals(null, null), undefined)
})

// --- resolveLaneContext: provider/profile/model transitions (req #2,#3,#5) ---

const models = (ids) => ids.map((id) => ({ id, contextWindow: 200000, contextWindowSource: 'model-meta' }))

test('resolveLaneContext: provider switch restores matching lane context (A→B→A)', () => {
  const lanesA = { 'codex:p1': { usage: { contextTokens: 70000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime' } } }
  const currentUsage = { inputTokens: 50000, outputTokens: 5000, totalTokens: 55000 }
  const resolved = tokenUsage.resolveLaneContext({
    lanes: lanesA, provider: 'codex', profileId: 'p1', model: 'gpt-5.6-sol',
    availableModels: models(['gpt-5.6-sol']), currentUsage, switchingModel: false,
  })
  assert.equal(resolved.contextTokens, 70000)
  assert.equal(resolved.contextSource, 'runtime')
  assert.equal(resolved.totalTokens, 55000) // totals preserved across lane switch
})

test('resolveLaneContext: provider switch to lane with no snapshot yields unknown (not old fill)', () => {
  const resolved = tokenUsage.resolveLaneContext({
    lanes: {}, provider: 'claude', profileId: null, model: 'sonnet',
    availableModels: models(['sonnet']), currentUsage: { inputTokens: 100, totalTokens: 100 }, switchingModel: false,
  })
  assert.equal(resolved.contextTokens, null)
  assert.equal(resolved.contextSource, 'unknown')
  assert.equal(resolved.contextWindow, 200000) // from model meta
  assert.equal(resolved.totalTokens, 100)
})

test('resolveLaneContext: model switch ALWAYS invalidates context (lane not keyed by model)', () => {
  const lanesA = { 'codex:p1': { usage: { contextTokens: 70000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime' } } }
  const resolved = tokenUsage.resolveLaneContext({
    lanes: lanesA, provider: 'codex', profileId: 'p1', model: 'gpt-5.6-mini',
    availableModels: models(['gpt-5.6-sol', 'gpt-5.6-mini']), currentUsage: { inputTokens: 50, totalTokens: 50 }, switchingModel: true,
  })
  assert.equal(resolved.contextTokens, null)
  assert.equal(resolved.contextSource, 'unknown')
  assert.equal(resolved.contextWindow, 200000) // new model's window
})

test('resolveLaneContext: profile switch restores matching lane context', () => {
  const lanesB = { 'codex:p2': { usage: { contextTokens: 30000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime' } } }
  const resolved = tokenUsage.resolveLaneContext({
    lanes: lanesB, provider: 'codex', profileId: 'p2', model: 'gpt-5.6-sol',
    availableModels: models(['gpt-5.6-sol']), currentUsage: { inputTokens: 100, totalTokens: 100 }, switchingModel: false,
  })
  assert.equal(resolved.contextTokens, 30000)
  assert.equal(resolved.contextSource, 'runtime')
})

test('resolveLaneContext: profile switch to unknown profile yields unknown context (not previous)', () => {
  const resolved = tokenUsage.resolveLaneContext({
    lanes: { 'codex:p1': { usage: { contextTokens: 70000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime' } } },
    provider: 'codex', profileId: 'p2', model: 'gpt-5.6-sol',
    availableModels: models(['gpt-5.6-sol']), currentUsage: { inputTokens: 100, totalTokens: 100 }, switchingModel: false,
  })
  assert.equal(resolved.contextTokens, null)
  assert.equal(resolved.contextSource, 'unknown')
})

// --- Full transition simulation: model A→B and provider A/profile X→B/default ---

test('transition: model A → model B does not show model A context', () => {
  // After running in model A, lane stores context. Switching to model B must
  // invalidate (switchingModel=true). Then simulating the next turn in model B
  // sets new context. Switching back to model A also invalidates.
  const lanes = { 'codex:p1': { usage: { contextTokens: 90000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime' } } }
  const sessionUsage = { inputTokens: 60000, outputTokens: 6000, totalTokens: 66000 }
  // Step 1: switch to model B
  const afterB = tokenUsage.resolveLaneContext({
    lanes, provider: 'codex', profileId: 'p1', model: 'gpt-5.6-mini',
    availableModels: models(['gpt-5.6-sol', 'gpt-5.6-mini']), currentUsage: sessionUsage, switchingModel: true,
  })
  assert.equal(afterB.contextTokens, null)
  assert.equal(afterB.totalTokens, 66000) // session totals preserved
  // Step 2: switch back to model A — also invalidates (not the lane snapshot)
  const backA = tokenUsage.resolveLaneContext({
    lanes, provider: 'codex', profileId: 'p1', model: 'gpt-5.6-sol',
    availableModels: models(['gpt-5.6-sol', 'gpt-5.6-mini']), currentUsage: afterB, switchingModel: true,
  })
  assert.equal(backA.contextTokens, null)
  assert.equal(backA.contextSource, 'unknown')
  assert.equal(backA.totalTokens, 66000)
})

test('transition: provider A/profile X → provider B/default restores B default lane', () => {
  // Provider A with profile X has a lane snapshot. Switching to provider B
  // (where X is not a B profile) falls back to default profile. The default
  // lane of B should be restored, not A/X's context. This catches the bug
  // where chooseProvider applied the lane with the OLD profile id first.
  const lanes = {
    'codex:X': { usage: { contextTokens: 80000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime' } },
    'claude:': { usage: { contextTokens: 40000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime' } },
  }
  const sessionUsage = { inputTokens: 80000, totalTokens: 80000 }
  // Simulate chooseProvider('claude'): final profile is null (X not in claude),
  // apply lane claude:default (not codex:X).
  const resolved = tokenUsage.resolveLaneContext({
    lanes, provider: 'claude', profileId: null, model: 'sonnet',
    availableModels: models(['sonnet']), currentUsage: sessionUsage, switchingModel: false,
  })
  assert.equal(resolved.contextTokens, 40000) // claude default lane restored, NOT codex:X's 80000
  assert.equal(resolved.contextSource, 'runtime')
  assert.equal(resolved.totalTokens, 80000)
})

test('transition: provider A/profile X → provider B/default with no B lane yields unknown', () => {
  const lanes = { 'codex:X': { usage: { contextTokens: 80000, contextWindow: 200000, contextSource: 'runtime', contextWindowSource: 'runtime' } } }
  const resolved = tokenUsage.resolveLaneContext({
    lanes, provider: 'claude', profileId: null, model: 'sonnet',
    availableModels: models(['sonnet']), currentUsage: { inputTokens: 100, totalTokens: 100 }, switchingModel: false,
  })
  assert.equal(resolved.contextTokens, null)
  assert.equal(resolved.contextSource, 'unknown')
})