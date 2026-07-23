// Type declarations for the token-usage-stats ESM facade.

export interface UsageTotals {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  runCount: number
  firstTs: number | null
  lastTs: number | null
  hasInput: boolean
  hasCached: boolean
  hasOutput: boolean
  hasReasoning: boolean
  hasTotal: boolean
}

export interface UsageProfile extends UsageTotals {
  profileId: string
}

export interface UsageModel extends UsageTotals {
  model: string
  profiles: UsageProfile[]
}

export interface UsageProvider extends UsageTotals {
  provider: string
  models: UsageModel[]
}

export interface UsageStats {
  grandTotal: UsageTotals
  providers: UsageProvider[]
}

export interface UsageFilter {
  provider?: string
  model?: string
  profileId?: string
  from?: string
  to?: string
}

export interface NormalizedUsageRecord {
  ts: number | null
  provider: string
  model: string
  profileId: string
  usage: import('./vite-env.d.ts').TokenUsage | null
  hasUsage: boolean
  hasInput: boolean
  hasCached: boolean
  hasOutput: boolean
  hasReasoning: boolean
  hasTotal: boolean
}

export function normalizeUsageRecord(entry: unknown): NormalizedUsageRecord | null
export function aggregateUsage(records: NormalizedUsageRecord[], options?: UsageFilter): UsageStats
export function uniqueValues(records: NormalizedUsageRecord[], field: 'provider' | 'model' | 'profileId'): string[]

export const UNKNOWN_MODEL: string
export const UNKNOWN_PROFILE: string
