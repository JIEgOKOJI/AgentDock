type ProviderId = 'codex' | 'claude' | 'opencode'
type ContextSource = 'runtime' | 'model-meta' | 'fallback' | 'estimated' | 'unknown'

interface TokenUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  contextTokens: number | null
  contextWindow: number | null
  contextSource: ContextSource
  contextWindowSource: ContextSource
}

interface ExtractOptions {
  model?: string
  modelContextWindow?: number
  contextWindow?: number
}

export declare function extractTokenUsage(provider: ProviderId, raw: string, options?: ExtractOptions): TokenUsage | null
export declare function addTokenUsage(total: TokenUsage, turn: TokenUsage): TokenUsage
export declare function emptyTokenUsage(): TokenUsage
export declare function normalizeTokenUsage(value: unknown, options?: { legacy?: boolean }): TokenUsage | undefined
export declare function contextSnapshot(usage: unknown): { contextTokens: number | null; contextWindow: number | null; contextSource: ContextSource; contextWindowSource: ContextSource } | null
export declare function mergeUsageWithTotals(totals: unknown, context: unknown): TokenUsage | undefined

interface LaneStateUsage {
  usage?: TokenUsage
}

interface ModelMeta {
  id: string
  contextWindow?: number | null
  contextWindowSource?: string
}

interface ResolveLaneContextOptions {
  lanes: Record<string, LaneStateUsage>
  provider: ProviderId
  profileId: string | null
  model: string
  availableModels: ModelMeta[]
  currentUsage: TokenUsage | null
  switchingModel?: boolean
}

export declare function resolveLaneContext(options: ResolveLaneContextOptions): TokenUsage
export declare function fallbackContextWindow(provider: ProviderId, model: string): number | null
export declare function resolveContextWindow(provider: ProviderId, model: string, runtimeWindow: number | null, modelMetaWindow: number | null): { window: number | null; source: ContextSource }
export declare const CONTEXT_RUNTIME: ContextSource
export declare const CONTEXT_MODEL_META: ContextSource
export declare const CONTEXT_FALLBACK: ContextSource
export declare const CONTEXT_ESTIMATED: ContextSource
export declare const CONTEXT_UNKNOWN: ContextSource