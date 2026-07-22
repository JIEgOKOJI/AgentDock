const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeUrl, normalizeBounds, DENY_SCHEMES } = require('../electron/browser-url.cjs')

test('normalizeUrl adds http for localhost', () => {
  assert.equal(normalizeUrl('localhost:5173').url, 'http://localhost:5173/')
  assert.equal(normalizeUrl('127.0.0.1:3000').url, 'http://127.0.0.1:3000/')
})

test('normalizeUrl adds https for domains', () => {
  const result = normalizeUrl('example.com')
  assert.equal(result.ok, true)
  assert.equal(result.url, 'https://example.com/')
})

test('normalizeUrl keeps explicit https', () => {
  assert.equal(normalizeUrl('https://example.com/path').url, 'https://example.com/path')
})

test('normalizeUrl rejects javascript and data schemes', () => {
  assert.equal(normalizeUrl('javascript:alert(1)').ok, false)
  assert.equal(normalizeUrl('data:text/html,<x>').ok, false)
})

test('normalizeUrl rejects empty input', () => {
  assert.equal(normalizeUrl('').ok, false)
  assert.equal(normalizeUrl('   ').ok, false)
  assert.equal(normalizeUrl(null).ok, false)
})

test('normalizeBounds clamps within window', () => {
  const result = normalizeBounds({ x: -10, y: -5, width: 2000, height: 2000 }, { width: 1000, height: 800 })
  assert.deepEqual(result.bounds, { x: 0, y: 0, width: 1000, height: 800 })
})

test('normalizeBounds rejects non-positive dimensions', () => {
  assert.equal(normalizeBounds({ x: 0, y: 0, width: 0, height: 100 }, { width: 1000, height: 800 }).ok, false)
  assert.equal(normalizeBounds({ x: 0, y: 0, width: 100, height: -1 }, { width: 1000, height: 800 }).ok, false)
  assert.equal(normalizeBounds({ x: NaN, y: 0, width: 100, height: 100 }, { width: 1000, height: 800 }).ok, false)
})