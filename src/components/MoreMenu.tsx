import { useEffect, useRef } from 'react'
import { Globe, MoreHorizontal, X } from 'lucide-react'

export function MoreMenu({ open, onClose, onOpenBrowser, browserOpen }: {
  open: boolean
  onClose: () => void
  onOpenBrowser: () => void
  browserOpen: boolean
}) {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) onClose() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [open, onClose])

  if (!open) return null

  return <div className="more-menu" ref={root} role="menu">
    <button className="more-menu-item" role="menuitem" onClick={() => { onOpenBrowser(); onClose() }}>
      <Globe size={15} />
      <span>{browserOpen ? 'Show embedded browser' : 'Open embedded browser'}</span>
    </button>
  </div>
}

export function MoreMenuTrigger({ onClick, open }: { onClick: () => void; open: boolean }) {
  return <button className={`icon-button more-trigger ${open ? 'active' : ''}`} aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={onClick}>
    {open ? <X size={18} /> : <MoreHorizontal size={18} />}
  </button>
}