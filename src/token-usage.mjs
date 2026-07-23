// ESM facade re-exporting the shared token-usage module. The canonical logic
// lives in electron/token-usage.cjs (CommonJS, shared with the main process).
// Vite/esbuild interop converts the CJS module for the browser bundle.
import * as shared from '../electron/token-usage.cjs'

export const extractTokenUsage = shared.extractTokenUsage
export const addTokenUsage = shared.addTokenUsage
export const emptyTokenUsage = shared.emptyTokenUsage
export const normalizeTokenUsage = shared.normalizeTokenUsage
export const contextSnapshot = shared.contextSnapshot
export const mergeUsageWithTotals = shared.mergeUsageWithTotals
export const resolveLaneContext = shared.resolveLaneContext
export const fallbackContextWindow = shared.fallbackContextWindow
export const resolveContextWindow = shared.resolveContextWindow
export const CONTEXT_RUNTIME = shared.CONTEXT_RUNTIME
export const CONTEXT_MODEL_META = shared.CONTEXT_MODEL_META
export const CONTEXT_FALLBACK = shared.CONTEXT_FALLBACK
export const CONTEXT_ESTIMATED = shared.CONTEXT_ESTIMATED
export const CONTEXT_UNKNOWN = shared.CONTEXT_UNKNOWN