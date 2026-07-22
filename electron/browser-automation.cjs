'use strict'

// Browser automation over Chrome DevTools Protocol attached to the embedded
// browser view's webContents. Provides snapshot (refs + role/name), screenshot,
// and actions (click, type, select, press, scroll, wait). Refs are revision-aware
// so navigation invalidates stale element handles.

const DEFAULT_TIMEOUT_MS = 15000

class AutomationError extends Error {
  constructor(code, message) {
    super(message || code)
    this.code = code
    this.name = 'AutomationError'
  }
}

function createBrowserAutomation(browserManager) {
  let attached = false
  let nextRefId = 1
  let refMap = new Map()
  let currentRevision = 0
  let mutexChain = Promise.resolve()
  let cancelRequested = false

  function serialize() {
    return mutexChain
  }

  function runExclusive(task) {
    const next = mutexChain.then(() => task())
    mutexChain = next.catch(() => {})
    return next
  }

  async function cdpSend(method, params = {}) {
    const webContents = browserManager.getWebContents()
    if (!webContents) throw new AutomationError('NO_BROWSER', 'No embedded browser is open')
    await ensureAttached(webContents)
    return new Promise((resolve, reject) => {
      webContents.debugger.sendCommand(method, params, (error, result) => {
        if (error) reject(new AutomationError('CDP_ERROR', error.message || String(error)))
        else resolve(result)
      })
    })
  }

  async function ensureAttached(webContents) {
    if (attached) return
    const target = webContents
    if (!target.debugger.isAttached()) {
      await new Promise((resolve, reject) => {
        target.debugger.attach('1.3', () => {
          if (target.debugger.isAttached()) resolve()
          else reject(new AutomationError('CDP_ERROR', 'Failed to attach debugger'))
        })
      })
    }
    attached = true
  }

  function detach() {
    const webContents = browserManager.getWebContents()
    if (webContents && webContents.debugger.isAttached()) {
      try { webContents.debugger.detach() } catch {}
    }
    attached = false
    refMap = new Map()
    nextRefId = 1
  }

  function invalidateRefs() {
    refMap = new Map()
    nextRefId = 1
    currentRevision = browserManager.getRevision()
  }

  function checkRevision() {
    const rev = browserManager.getRevision()
    if (rev !== currentRevision) {
      invalidateRefs()
    }
  }

  function makeRef(backendNodeId, frameId) {
    const id = `e${nextRefId++}`
    refMap.set(id, { revision: currentRevision, backendNodeId, frameId })
    return id
  }

  function resolveRef(ref) {
    checkRevision()
    const entry = refMap.get(ref)
    if (!entry) throw new AutomationError('STALE_REF', `Element ref ${ref} is no longer valid. Run browser_snapshot.`)
    if (entry.revision !== currentRevision) {
      refMap.delete(ref)
      throw new AutomationError('STALE_REF', `Element ref ${ref} is stale after navigation.`)
    }
    return entry
  }

  async function waitForDocument(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = browserManager.getState()
      if (state && !state.loading) return
      await new Promise((r) => setTimeout(r, 80))
    }
    throw new AutomationError('TIMEOUT', 'Navigation did not finish in time')
  }

  async function snapshot() {
    return runExclusive(async () => {
      const state = browserManager.getState()
      if (!state) throw new AutomationError('NO_BROWSER', 'No embedded browser is open')
      checkRevision()
      await waitForDocument(8000)
      const result = await cdpSend('Accessibility.getFullAXTree')
      const nodes = (result && Array.isArray(result.nodes)) ? result.nodes : []
      const refs = []
      const interesting = new Set(['button', 'link', 'textbox', 'combobox', 'menuitem', 'tab', 'checkbox', 'radio', 'searchbox', 'slider', 'switch', 'treeitem', 'listitem', 'option'])
      for (const node of nodes) {
        const role = node.role ? node.role.value : null
        if (!role) continue
        if (!interesting.has(role)) continue
        const name = node.name ? node.name.value : ''
        const backendNodeId = node.backendDOMNodeId
        if (!backendNodeId) continue
        const ref = makeRef(backendNodeId, node.frameId || null)
        refs.push({ ref, role, name, })
      }
      return {
        url: state.url,
        title: state.title,
        revision: currentRevision,
        elements: refs,
      }
    })
  }

  async function screenshot() {
    return runExclusive(async () => {
      const state = browserManager.getState()
      if (!state) throw new AutomationError('NO_BROWSER', 'No embedded browser is open')
      const result = await cdpSend('Page.captureScreenshot', { format: 'png' })
      if (!result || !result.data) throw new AutomationError('CDP_ERROR', 'No screenshot data')
      return { data: result.data, mimeType: 'image/png' }
    })
  }

  async function resolveNodeId(ref) {
    const entry = resolveRef(ref)
    const resolved = await cdpSend('DOM.resolveNode', { backendNodeId: entry.backendNodeId })
    if (!resolved || !resolved.objectId) throw new AutomationError('ELEMENT_NOT_FOUND', `Could not resolve element ${ref}`)
    return resolved.objectId
  }

  async function click(ref) {
    return runExclusive(async () => {
      checkRevision()
      const objectId = await resolveNodeId(ref)
      await cdpSend('DOM.focus', { objectId })
      await cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed', x: 0, y: 0, button: 'left', clickCount: 1 })
      await cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 0, y: 0, button: 'left', clickCount: 1 })
      return { ok: true }
    })
  }

  async function type(ref, text) {
    return runExclusive(async () => {
      checkRevision()
      const objectId = await resolveNodeId(ref)
      await cdpSend('DOM.focus', { objectId })
      await cdpSend('Input.insertText', { text: String(text) })
      return { ok: true }
    })
  }

  async function fill(ref, text) {
    return runExclusive(async () => {
      checkRevision()
      const objectId = await resolveNodeId(ref)
      await cdpSend('DOM.focus', { objectId })
      await cdpSend('Input.insertText', { text: String(text) })
      return { ok: true }
    })
  }

  async function select(ref, value) {
    return runExclusive(async () => {
      checkRevision()
      const objectId = await resolveNodeId(ref)
      await cdpSend('DOM.focus', { objectId })
      await cdpSend('Input.dispatchKeyEvent', { type: 'char', text: String(value) })
      return { ok: true }
    })
  }

  async function pressKey(key) {
    return runExclusive(async () => {
      const keyMap = { Enter: '\r', Tab: '\t', Escape: '\u001b' }
      const text = keyMap[key] || key
      await cdpSend('Input.dispatchKeyEvent', { type: 'char', text: String(text) })
      return { ok: true }
    })
  }

  async function scroll(direction = 'down', amount = 1) {
    return runExclusive(async () => {
      const factor = Math.max(1, Math.min(Number(amount) || 1, 50))
      const delta = direction === 'up' ? -400 * factor : direction === 'left' ? -400 * factor : 400 * factor
      const axis = direction === 'left' || direction === 'right' ? 'deltaX' : 'deltaY'
      await cdpSend('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 100, y: 100, button: 'none',
        [axis]: delta,
      })
      return { ok: true }
    })
  }

  async function wait(condition = 'load', timeoutMs = DEFAULT_TIMEOUT_MS) {
    return runExclusive(async () => {
      cancelRequested = false
      const deadline = Date.now() + (timeoutMs || DEFAULT_TIMEOUT_MS)
      while (Date.now() < deadline) {
        if (cancelRequested) throw new AutomationError('USER_CANCELLED', 'Wait was cancelled')
        const state = browserManager.getState()
        if (!state) throw new AutomationError('NO_BROWSER', 'No embedded browser is open')
        if (condition === 'load' && !state.loading) return { ok: true }
        if (condition === 'networkidle' && !state.loading) {
          await new Promise((r) => setTimeout(r, 500))
          const after = browserManager.getState()
          if (after && !after.loading) return { ok: true }
        }
        await new Promise((r) => setTimeout(r, 120))
      }
      throw new AutomationError('TIMEOUT', `Wait for ${condition} timed out`)
    })
  }

  function cancel() {
    cancelRequested = true
  }

  return {
    snapshot,
    screenshot,
    click,
    type,
    fill,
    select,
    pressKey,
    scroll,
    wait,
    cancel,
    detach,
    invalidateRefs,
  }
}

module.exports = { createBrowserAutomation, AutomationError, DEFAULT_TIMEOUT_MS }