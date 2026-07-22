import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, ArrowRight, ExternalLink, Eye, Hand, Loader2, RefreshCw, X, Globe,
} from 'lucide-react'

export function BrowserView({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<BrowserTabState | null>(null)
  const [action, setAction] = useState<BrowserActionState | null>(null)
  const [address, setAddress] = useState('')
  const placeholderRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | undefined>(undefined)
  const lastBoundsRef = useRef<string>('')

  useEffect(() => {
    const api = window.agentDock?.browser
    if (!api) return
    const unsubState = api.onState((next) => {
      setState(next)
      if (next) setAddress(next.url === 'about:blank' ? '' : next.url)
    })
    const unsubAction = api.onAction((next) => setAction(next))
    const unsubRequest = api.onRequestBounds(() => sendBounds())
    api.getState().then((current) => {
      if (current) {
        setState(current)
        setAddress(current.url === 'about:blank' ? '' : current.url)
      }
    })
    return () => { unsubState(); unsubAction(); unsubRequest() }
  }, [])

  const sendBounds = () => {
    const el = placeholderRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const bounds = { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
    if (key === lastBoundsRef.current) return
    lastBoundsRef.current = key
    window.agentDock?.browser.setBounds(bounds)
  }

  useEffect(() => {
    const el = placeholderRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(sendBounds)
    })
    observer.observe(el)
    sendBounds()
    return () => { observer.disconnect(); if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [])

  const navigate = async () => {
    if (!address.trim()) return
    try { await window.agentDock?.browser.navigate(address) }
    catch (error) { setState((current) => current ? { ...current, lastError: error instanceof Error ? error.message : String(error) } : current) }
  }

  const openExternal = () => window.agentDock?.browser.openExternal()
  const close = async () => {
    await window.agentDock?.browser.hide()
    onClose()
  }
  const cancelAgent = () => window.agentDock?.browser.cancelAgentAction()

  const agentActive = action?.actor === 'agent' && (action.status === 'started')

  return <section className="browser-view">
    <div className="browser-chrome">
      <div className="browser-nav">
        <button className="icon-button" onClick={() => window.agentDock?.browser.back()} disabled={!state?.canGoBack} aria-label="Back"><ArrowLeft size={16} /></button>
        <button className="icon-button" onClick={() => window.agentDock?.browser.forward()} disabled={!state?.canGoForward} aria-label="Forward"><ArrowRight size={16} /></button>
        <button className="icon-button" onClick={() => state?.loading ? window.agentDock?.browser.stop() : window.agentDock?.browser.reload()} aria-label={state?.loading ? 'Stop' : 'Reload'}>
          {state?.loading ? <X size={16} /> : <RefreshCw size={16} />}
        </button>
      </div>
      <div className="browser-address-wrap">
        <Globe size={13} className="browser-address-icon" />
        <input className="browser-address" value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void navigate() } }} placeholder="Enter a URL or search the web" spellCheck={false} />
        {state?.loading && <Loader2 size={13} className="browser-loading-spin" />}
      </div>
      <div className="browser-actions">
        <button className="icon-button" onClick={openExternal} disabled={!state?.url || state.url === 'about:blank'} aria-label="Open in external browser"><ExternalLink size={15} /></button>
        <button className="icon-button" onClick={close} aria-label="Hide browser"><X size={17} /></button>
      </div>
    </div>
    {agentActive && <div className="browser-agent-bar">
      <span><Eye size={13} /> Agent is {action?.tool ? `running ${action.tool}` : 'controlling'} the browser</span>
      <span className="browser-agent-summary">{action?.summary}</span>
      <button className="browser-cancel" onClick={cancelAgent}><Hand size={13} /> Cancel</button>
    </div>}
    {state?.lastError && <div className="browser-error">{state.lastError}</div>}
    <div className="browser-placeholder" ref={placeholderRef}>
      {!state?.url || state.url === 'about:blank' ? <div className="browser-empty">
        <Globe size={40} />
        <h2>Embedded browser</h2>
        <p>Enter a URL above, or ask an agent to open the browser to inspect a web page.</p>
      </div> : null}
    </div>
  </section>
}