// ESM facade re-exporting token-usage aggregation helpers for the renderer.
import * as shared from '../electron/token-usage-stats.cjs'

export const normalizeUsageRecord = shared.normalizeUsageRecord
export const aggregateUsage = shared.aggregateUsage
export const uniqueValues = shared.uniqueValues
export const UNKNOWN_MODEL = shared.UNKNOWN_MODEL
export const UNKNOWN_PROFILE = shared.UNKNOWN_PROFILE
