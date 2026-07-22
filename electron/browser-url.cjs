'use strict'

const DENY_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'about:', 'blob:'])
const ALLOW_SCHEMES = new Set(['http:', 'https:'])

function normalizeUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, error: 'INVALID_URL', url: null }
  }
  const value = input.trim()
  let candidate = value
  // Detect localhost and bare IP:port before scheme detection, since
  // "localhost:5173" parses as a URL with scheme "localhost".
  if (/^localhost(:\d+)?(\/.*)?$/i.test(candidate) || /^127\.0\.0\.1(:\d+)?(\/.*)?$/.test(candidate) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(candidate)) {
    candidate = `http://${candidate}`
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(candidate)) {
      candidate = `https://${candidate}`
    } else {
      return { ok: false, error: 'INVALID_URL', url: null }
    }
  }
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    return { ok: false, error: 'INVALID_URL', url: null }
  }
  if (!ALLOW_SCHEMES.has(parsed.protocol)) {
    if (DENY_SCHEMES.has(parsed.protocol)) {
      return { ok: false, error: 'INVALID_URL', url: null }
    }
    return { ok: false, error: 'INVALID_URL', url: null }
  }
  return { ok: true, error: null, url: parsed.href }
}

function normalizeBounds(raw, windowBounds) {
  const width = Math.round(Number(raw?.width))
  const height = Math.round(Number(raw?.height))
  const x = Math.round(Number(raw?.x))
  const y = Math.round(Number(raw?.y))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, bounds: null }
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, bounds: null }
  }
  const maxX = Math.max(0, windowBounds.width - 1)
  const maxY = Math.max(0, windowBounds.height - 1)
  const clampedWidth = Math.min(width, windowBounds.width)
  const clampedHeight = Math.min(height, windowBounds.height)
  const clampedX = Math.max(0, Math.min(x, maxX))
  const clampedY = Math.max(0, Math.min(y, maxY))
  return { ok: true, bounds: { x: clampedX, y: clampedY, width: clampedWidth, height: clampedHeight } }
}

module.exports = { normalizeUrl, normalizeBounds, DENY_SCHEMES, ALLOW_SCHEMES }