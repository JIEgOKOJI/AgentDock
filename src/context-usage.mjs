import { COMPONENT_CATEGORIES, CONTEXT_STATUS_REPORTED, CONTEXT_STATUS_ESTIMATED, CONTEXT_STATUS_UNKNOWN, estimateTokens } from '../electron/context-usage-shared.cjs'

function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8)
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function simpleHash(text) {
  if (text == null || typeof text !== 'string') return null
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i)
    hash = hash & 0xffffffff
  }
  return Math.abs(hash).toString(16).padStart(16, '0')
}

function makePreview(text, maxLength = 300) {
  if (text == null || typeof text !== 'string') return { preview: '', truncated: false, hash: null }
  const normalized = text.replace(/\s+/g, ' ').trim()
  const truncated = normalized.length > maxLength
  const preview = truncated ? normalized.slice(0, maxLength) : normalized
  return { preview, truncated, hash: simpleHash(text) }
}

function createContextItem({ category, source, runId = null, agent = null, text, status, tokens }) {
  const tokenInfo = tokens != null ? { tokens, status: status || CONTEXT_STATUS_REPORTED } : estimateTokens(text)
  const preview = makePreview(text)
  return {
    id: `${category}-${generateId()}`,
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

export {
  COMPONENT_CATEGORIES,
  CONTEXT_STATUS_REPORTED,
  CONTEXT_STATUS_ESTIMATED,
  CONTEXT_STATUS_UNKNOWN,
  estimateTokens,
  makePreview,
  createContextItem,
}
