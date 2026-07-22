'use strict'

const { WebContentsView } = require('electron')
const { normalizeUrl } = require('./browser-url.cjs')

const PARTITION = 'persist:agentdock-browser'

function createBrowserManager() {
  const listeners = new Set()
  const actionListeners = new Set()
  let view = null
  let window = null
  let visible = false
  let revision = 0
  let lastUrl = ''
  let lastError = null

  const emit = () => {
    const state = getState()
    for (const listener of listeners) {
      try { listener(state) } catch {}
    }
  }

  const emitAction = (action) => {
    for (const listener of actionListeners) {
      try { listener(action) } catch {}
    }
  }

  function getState() {
    if (!view) return null
    const webContents = view.webContents
    return {
      id: 'default',
      url: lastUrl || webContents.getURL() || 'about:blank',
      title: webContents.getTitle() || '',
      loading: webContents.isLoading(),
      canGoBack: webContents.navigationHistory.canGoBack(),
      canGoForward: webContents.navigationHistory.canGoForward(),
      visible,
      revision,
      lastError: lastError || undefined,
    }
  }

  function attachEventHandlers(webContents) {
    webContents.on('did-start-loading', () => emit())
    webContents.on('did-stop-loading', () => emit())
    webContents.on('did-navigate', (_e, url) => { lastUrl = url; revision += 1; emit() })
    webContents.on('did-navigate-in-page', (_e, url) => { lastUrl = url; revision += 1; emit() })
    webContents.on('page-title-updated', () => emit())
    webContents.on('did-fail-load', (_e, errorCode, errorDescription, url) => {
      if (errorCode === -3) return
      lastError = errorDescription || `Load failed (${errorCode})`
      if (url) lastUrl = url
      emit()
    })
    webContents.on('render-process-gone', (_e, details) => {
      lastError = `Render process gone: ${details?.reason || 'unknown'}`
      emit()
    })
  }

  function ensureView() {
    if (view) return view
    view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: PARTITION,
      },
    })
    view.setBackgroundColor('#0d1016')
    attachEventHandlers(view.webContents)
    view.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(false)
    })
    view.webContents.session.setPermissionCheckHandler(() => false)
    view.webContents.on('did-attach-webview', () => emit())
    return view
  }

  function setBounds(rect) {
    if (!view || !window) return
    view.setBounds(rect)
  }

  function showView() {
    if (!window) return
    ensureView()
    if (!visible) {
      window.contentView.addChildView(view)
      visible = true
      emit()
    }
  }

  function hideView() {
    if (!view || !window) return
    if (visible) {
      window.contentView.removeChildView(view)
      visible = false
      emit()
    }
  }

  function isVisible() { return visible }

  async function navigate(url) {
    ensureView()
    const normalized = normalizeUrl(url)
    if (!normalized.ok) {
      lastError = 'Invalid URL'
      emit()
      throw new Error(normalized.error)
    }
    lastError = null
    lastUrl = normalized.url
    revision += 1
    showView()
    await view.webContents.loadURL(normalized.url)
    return getState()
  }

  async function open(url) {
    ensureView()
    showView()
    if (url) return navigate(url)
    if (!view.webContents.getURL() || view.webContents.getURL() === 'about:blank') {
      return getState()
    }
    return getState()
  }

  function back() { if (view && view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack() }
  function forward() { if (view && view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward() }
  function reload() { if (view) view.webContents.reload() }
  function stop() { if (view) view.webContents.stop() }

  function getWebContents() { return view ? view.webContents : null }

  function getRevision() { return revision }

  function attach(hostWindow) {
    window = hostWindow
  }

  async function destroy() {
    const contents = view ? view.webContents : null
    if (contents) {
      try { if (contents.isDevToolsOpened()) contents.closeDevTools() } catch {}
      try { contents.detachDebugger && contents.detachDebugger() } catch {}
    }
    if (window && view && visible) {
      try { window.contentView.removeChildView(view) } catch {}
    }
    try { if (contents) contents.destroy() } catch {}
    view = null
    visible = false
    window = null
    lastError = null
  }

  function onState(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function onAction(listener) {
    actionListeners.add(listener)
    return () => actionListeners.delete(listener)
  }

  function notifyAction(action) { emitAction(action) }

  return {
    attach,
    ensureView,
    setBounds,
    showView,
    hideView,
    isVisible,
    navigate,
    open,
    back,
    forward,
    reload,
    stop,
    getState,
    getWebContents,
    getRevision,
    destroy,
    onState,
    onAction,
    notifyAction,
  }
}

module.exports = { createBrowserManager, PARTITION }