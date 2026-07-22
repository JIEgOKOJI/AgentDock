import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check, ChevronDown, ChevronRight, CircleDot, Download, PlugZap, Plus, RefreshCw,
  Search, Settings, Trash2, Upload, Wrench, X, Zap, AlertTriangle,
} from 'lucide-react'

type ProviderId = 'codex' | 'claude' | 'opencode'

const providerLabels: Record<ProviderId, string> = {
  codex: 'Codex',
  claude: 'Claude',
  opencode: 'OpenCode',
}

const emptyServer: ManagedMcpServer = {
  id: '',
  name: '',
  description: '',
  transport: 'stdio',
  command: '',
  args: [],
  url: '',
  env: {},
  headers: {},
  cwd: '',
  providers: [],
  scope: 'global',
  workspace: '',
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
}

export function McpManagerView({ workspace }: { workspace: string }) {
  const [servers, setServers] = useState<ManagedMcpServer[]>([])
  const [conflicts, setConflicts] = useState<McpConflict[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [filterProvider, setFilterProvider] = useState<ProviderId | 'all'>('all')
  const [filterScope, setFilterScope] = useState<'all' | 'global' | 'workspace'>('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<ManagedMcpServer | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [checking, setChecking] = useState<string | null>(null)
  const [health, setHealth] = useState<Record<string, McpHealthResult>>({})
  const [syncing, setSyncing] = useState(false)

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      if (!window.agentDock) throw new Error('MCP management is available in the Electron app.')
      const [list, detected] = await Promise.all([
        window.agentDock.getManagedMcpServers(workspace),
        window.agentDock.getMcpConflicts(workspace),
      ])
      setServers(list)
      setConflicts(detected)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [workspace])

  const visibleServers = servers.filter((server) => {
    if (filterProvider !== 'all' && !server.providers.includes(filterProvider)) return false
    if (filterScope !== 'all' && server.scope !== filterScope) return false
    const needle = query.trim().toLowerCase()
    if (!needle) return true
    return `${server.name} ${server.description} ${server.command} ${server.url}`.toLowerCase().includes(needle)
  })

  const save = async (server: Partial<ManagedMcpServer> & { name: string }) => {
    setError('')
    setNotice('')
    try {
      const saved = await window.agentDock?.upsertManagedMcpServer({ ...server, workspace: server.scope === 'workspace' ? workspace : '' })
      if (saved) {
        setServers((items) => {
          const index = items.findIndex((item) => item.id === saved.id)
          return index >= 0 ? items.map((item) => (item.id === saved.id ? saved : item)) : [...items, saved]
        })
        setNotice(`${saved.name} saved. Run "Apply changes" to sync CLI configs.`)
        setShowEditor(false)
        setEditing(null)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const remove = async (id: string, name: string) => {
    setError('')
    setNotice('')
    try {
      const ok = await window.agentDock?.removeManagedMcpServer(id)
      if (ok) {
        setServers((items) => items.filter((item) => item.id !== id))
        setHealth((current) => { const next = { ...current }; delete next[id]; return next })
        setNotice(`${name} removed.`)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const toggleEnabled = async (server: ManagedMcpServer, enabled: boolean) => {
    setError('')
    setNotice('')
    try {
      const updated = await window.agentDock?.toggleManagedMcpServer({ id: server.id, enabled })
      if (updated) {
        setServers((items) => items.map((item) => (item.id === updated.id ? updated : item)))
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const checkHealth = async (server: ManagedMcpServer) => {
    setChecking(server.id)
    try {
      const result = await window.agentDock?.checkManagedMcpServer(server)
      if (result) setHealth((current) => ({ ...current, [server.id]: result }))
    } catch (reason) {
      setHealth((current) => ({ ...current, [server.id]: { ok: false, detail: reason instanceof Error ? reason.message : String(reason) } }))
    } finally {
      setChecking(null)
    }
  }

  const importConfigs = async () => {
    setError('')
    setNotice('')
    try {
      const result = await window.agentDock?.importManagedMcpServers(workspace)
      if (result) {
        setNotice(`Imported ${result.added} new server${result.added === 1 ? '' : 's'}, merged ${result.merged}.`)
        await refresh()
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const applyChanges = async () => {
    setError('')
    setNotice('')
    setSyncing(true)
    try {
      const result = await window.agentDock?.syncManagedMcpServers({ workspace })
      if (result) {
        const backups = result.results.filter((item) => item.backup).length
        setNotice(`Synced to ${result.results.length} CLI config${result.results.length === 1 ? '' : 's'}. ${backups} backup${backups === 1 ? '' : 's'} created.`)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSyncing(false)
    }
  }

  const exportToFile = async () => {
    setError('')
    setNotice('')
    try {
      const result = await window.agentDock?.exportMcpToFile()
      if (result && !result.canceled) setNotice(`Exported to ${result.path}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const importFromFile = async () => {
    setError('')
    setNotice('')
    try {
      const fileInput = document.createElement('input')
      fileInput.type = 'file'
      fileInput.accept = '.json,application/json'
      fileInput.onchange = async () => {
        const file = fileInput.files?.[0]
        if (!file) return
        const text = await file.text()
        try {
          const payload = JSON.parse(text)
          const result = await window.agentDock?.importMcpPayload({ payload })
          if (result) {
            setNotice(`Imported ${result.added} server${result.added === 1 ? '' : 's'}, merged ${result.merged}.`)
            await refresh()
          }
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }
      fileInput.click()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const openEditor = (server: ManagedMcpServer | null) => {
    setEditing(server)
    setShowEditor(true)
  }

  return <section className="page">
    <div className="page-heading">
      <div>
        <h1>MCP servers</h1>
        <p>One catalog for every CLI agent — add, edit, sync, and verify MCP servers without editing config files by hand.</p>
      </div>
      <div className="mcp-heading-actions">
        <button className="primary-button" onClick={() => openEditor(null)}><Plus size={15} />Add server</button>
      </div>
    </div>

    <div className="mcp-toolbar">
      <div className="search-box"><Search size={15} /><input placeholder="Search servers" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="mcp-filter-group">
        <span className="mcp-filter-label">CLI</span>
        {(['all', 'codex', 'claude', 'opencode'] as const).map((provider) => (
          <button key={provider} className={`filter ${filterProvider === provider ? 'active' : ''}`} onClick={() => setFilterProvider(provider)}>
            {provider === 'all' ? 'All' : providerLabels[provider]}
          </button>
        ))}
      </div>
      <div className="mcp-filter-group">
        <span className="mcp-filter-label">Scope</span>
        {(['all', 'global', 'workspace'] as const).map((scope) => (
          <button key={scope} className={`filter ${filterScope === scope ? 'active' : ''}`} onClick={() => setFilterScope(scope)}>
            {scope === 'all' ? 'All' : scope === 'global' ? 'Global' : 'Workspace'}
          </button>
        ))}
      </div>
      <div className="mcp-toolbar-spacer" />
      <div className="mcp-toolbar-actions">
        <button className="mcp-tool-button" onClick={() => void importConfigs()} title="Import from existing CLI configs"><Upload size={14} /> Import</button>
        <button className="mcp-tool-button" onClick={() => void importFromFile()} title="Import from JSON file"><Upload size={14} /> From file</button>
        <button className="mcp-tool-button" onClick={() => void exportToFile()} title="Export to JSON file"><Download size={14} /> Export</button>
        <button className="primary-button" onClick={() => void applyChanges()} disabled={syncing} title="Write changes to CLI config files"><RefreshCw size={14} className={syncing ? 'spin' : ''} /> Apply changes</button>
      </div>
    </div>

    {error && <div className="skills-message error">{error}</div>}
    {notice && <div className="skills-message success">{notice}</div>}

    {conflicts.length > 0 && <div className="mcp-conflict-banner">
      <AlertTriangle size={16} />
      <div>
        <strong>{conflicts.length} conflict{conflicts.length === 1 ? '' : 's'} detected</strong>
        <p>{conflicts.length === 1 ? 'A server was found in a CLI config' : 'Some servers were found in CLI configs'} that differ{conflicts.length === 1 ? 's' : ''} from the managed catalog or exist{conflicts.length === 1 ? 's' : ''} only in the CLI. Apply changes to synchronize.</p>
      </div>
    </div>}

    {loading ? <div className="skills-message">Loading MCP servers…</div> : visibleServers.length ? (
      <div className="mcp-server-list">
        {visibleServers.map((server) => {
          const serverHealth = health[server.id]
          return <div className={`mcp-server-row ${server.enabled ? '' : 'disabled'}`} key={server.id}>
            <div className="mcp-server-head">
              <span className={`mcp-server-icon ${server.enabled ? 'on' : ''}`}><PlugZap size={18} /></span>
              <div className="mcp-server-info">
                <strong>{server.name}</strong>
                <small>{server.description || (server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}` : server.url)}</small>
              </div>
              <div className="mcp-server-providers">
                {(Object.keys(providerLabels) as ProviderId[]).map((id) => (
                  <span key={id} className={server.providers.includes(id) ? 'available' : ''} title={`${providerLabels[id]} ${server.providers.includes(id) ? 'active' : 'inactive'}`}>{providerLabels[id]}</span>
                ))}
              </div>
              <span className="mcp-scope-badge">{server.scope === 'global' ? 'Global' : 'Workspace'}</span>
              <span className={`status ${server.enabled ? 'ok' : ''}`}>{server.enabled ? 'Enabled' : 'Disabled'}</span>
              {serverHealth && <span className={`mcp-health ${serverHealth.ok ? 'ok' : 'fail'}`} title={serverHealth.detail}>{serverHealth.ok ? 'Reachable' : 'Unavailable'}</span>}
            </div>
            <div className="mcp-server-foot">
              <span className="mcp-transport">{server.transport === 'stdio' ? <><Wrench size={11} /> stdio</> : <><CircleDot size={11} /> {server.transport}</>}</span>
              <label className="default-skill-toggle" title="Toggle server availability">
                <b>Enabled</b>
                <input type="checkbox" checked={server.enabled} onChange={(event) => void toggleEnabled(server, event.target.checked)} />
                <i />
              </label>
              <div className="mcp-server-actions">
                <button className="mcp-server-action" onClick={() => void checkHealth(server)} disabled={checking === server.id} title="Check availability">
                  {checking === server.id ? <RefreshCw className="spin" size={13} /> : <CircleDot size={13} />} Check
                </button>
                <button className="mcp-server-action" onClick={() => openEditor(server)} title="Edit server"><Settings size={13} /> Edit</button>
                <button className="mcp-server-action danger" onClick={() => void remove(server.id, server.name)} title="Remove server"><Trash2 size={13} /> Remove</button>
              </div>
            </div>
          </div>
        })}
      </div>
    ) : <div className="skills-message">{servers.length ? 'No servers match this filter.' : 'No MCP servers configured yet. Add one or import from existing CLI configs.'}</div>}

    {showEditor && <McpServerEditor
      server={editing}
      workspace={workspace}
      onSave={save}
      onClose={() => { setShowEditor(false); setEditing(null) }}
    />}
  </section>
}

function McpServerEditor({ server, workspace, onSave, onClose }: {
  server: ManagedMcpServer | null
  workspace: string
  onSave: (server: Partial<ManagedMcpServer> & { name: string }) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<ManagedMcpServer>(() => (server ? { ...emptyServer, ...server } : { ...emptyServer, providers: ['codex'] } as ManagedMcpServer))
  const [envText, setEnvText] = useState(() => Object.entries(server?.env ?? {}).map(([key, val]) => `${key}=${val}`).join('\n'))
  const [headerText, setHeaderText] = useState(() => Object.entries(server?.headers ?? {}).map(([key, val]) => `${key}=${val}`).join('\n'))
  const [argsText, setArgsText] = useState(() => (server?.args ?? []).join('\n'))
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) onClose() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [onClose])

  const update = <K extends keyof typeof form>(key: K, value: typeof form[K]) => setForm((current) => ({ ...current, [key]: value }))

  const submit = () => {
    if (!form.name.trim()) return
    const env: Record<string, string> = {}
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex > 0) env[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim()
    }
    const headers: Record<string, string> = {}
    for (const line of headerText.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex > 0) headers[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim()
    }
    onSave({
      ...form,
      name: form.name.trim(),
      env,
      headers,
      args: argsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      workspace: form.scope === 'workspace' ? workspace : '',
    })
  }

  const isRemote = form.transport === 'sse' || form.transport === 'http'

  return <div className="mcp-editor-overlay" ref={root}>
    <div className="mcp-editor">
      <div className="mcp-editor-head">
        <h2>{server ? 'Edit MCP server' : 'Add MCP server'}</h2>
        <button className="icon-button" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="mcp-editor-body">
        <div className="mcp-form-row">
          <label>Name<input value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="e.g. filesystem" /></label>
          <label>Description<input value={form.description} onChange={(event) => update('description', event.target.value)} placeholder="What this server provides" /></label>
        </div>
        <div className="mcp-form-row">
          <label>Transport type
            <select value={form.transport} onChange={(event) => update('transport', event.target.value as McpTransport)}>
              <option value="stdio">stdio (local process)</option>
              <option value="sse">SSE (server-sent events)</option>
              <option value="http">HTTP (streamable)</option>
            </select>
          </label>
          <label>Scope
            <select value={form.scope} onChange={(event) => update('scope', event.target.value as ManagedMcpServer['scope'])}>
              <option value="global">Global (all workspaces)</option>
              <option value="workspace">Workspace only</option>
            </select>
          </label>
        </div>
        {form.scope === 'workspace' && <div className="mcp-form-hint">This server will only be written to configs when the workspace <code>{workspace}</code> is active.</div>}
        {!isRemote && <>
          <div className="mcp-form-row">
            <label>Command<input value={form.command} onChange={(event) => update('command', event.target.value)} placeholder="e.g. npx, node, python" /></label>
            <label>Working directory<input value={form.cwd} onChange={(event) => update('cwd', event.target.value)} placeholder="Optional" /></label>
          </div>
          <label className="mcp-form-full">Arguments (one per line)
            <textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/tmp'} rows={4} />
          </label>
          <label className="mcp-form-full">Environment variables (KEY=value, one per line)
            <textarea value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={'API_KEY=secret\nNODE_ENV=production'} rows={4} />
          </label>
        </>}
        {isRemote && <>
          <label className="mcp-form-full">Server URL
            <input value={form.url} onChange={(event) => update('url', event.target.value)} placeholder="https://example.com/mcp" />
          </label>
          <label className="mcp-form-full">Headers (KEY=value, one per line)
            <textarea value={headerText} onChange={(event) => setHeaderText(event.target.value)} placeholder={'Authorization=Bearer token'} rows={3} />
          </label>
        </>}
        <div className="mcp-form-row">
          <div className="mcp-form-full">
            <span className="mcp-field-label">Active for CLIs</span>
            <div className="mcp-provider-toggles">
              {(Object.keys(providerLabels) as ProviderId[]).map((id) => (
                <label key={id} className={`mcp-provider-chip ${form.providers.includes(id) ? 'on' : ''}`}>
                  <input type="checkbox" checked={form.providers.includes(id)} onChange={(event) => {
                    const next = event.target.checked ? [...form.providers, id] : form.providers.filter((item) => item !== id)
                    update('providers', next)
                  }} />
                  <Zap size={12} /> {providerLabels[id]}
                </label>
              ))}
            </div>
          </div>
        </div>
        <label className="default-skill-toggle mcp-enabled-toggle">
          <b>Enabled</b>
          <input type="checkbox" checked={form.enabled} onChange={(event) => update('enabled', event.target.checked)} />
          <i />
        </label>
      </div>
      <div className="mcp-editor-foot">
        <button className="mcp-tool-button" onClick={onClose}>Cancel</button>
        <button className="primary-button" onClick={submit} disabled={!form.name.trim()}><Check size={15} />{server ? 'Save changes' : 'Create server'}</button>
      </div>
    </div>
  </div>
}
