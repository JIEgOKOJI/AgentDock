import { useEffect, useRef, useState } from 'react'
import {
  Check, ChevronRight, KeyRound, Plus, RefreshCw, Trash2, X, Zap,
} from 'lucide-react'

type ProviderId = 'codex' | 'claude' | 'opencode'

const providerLabels: Record<ProviderId, string> = {
  codex: 'Codex',
  claude: 'Claude',
  opencode: 'OpenCode',
}

const envVarFor: Record<ProviderId, string> = {
  codex: 'CODEX_HOME',
  claude: 'CLAUDE_CONFIG_DIR',
  opencode: 'OPENCODE_CONFIG_DIR',
}

const defaultConfigDirFor: Record<ProviderId, string> = {
  codex: '~/.codex',
  claude: '~/.claude',
  opencode: '~/.config/opencode',
}

const emptyDraft = (provider: ProviderId): { id: string; name: string; provider: ProviderId; configDir: string; enabled: boolean } => ({
  id: '',
  name: '',
  provider,
  configDir: defaultConfigDirFor[provider],
  enabled: true,
})

export function ProfilesView() {
  const [profiles, setProfiles] = useState<CredentialProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string; provider: ProviderId; configDir: string; enabled: boolean } | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      if (!window.agentDock) throw new Error('Profiles are available in the Electron app.')
      setProfiles(await window.agentDock.listProfiles())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  const startCreate = () => {
    setNotice('')
    setError('')
    setEditing(emptyDraft('codex'))
  }

  const startEdit = (profile: CredentialProfile) => {
    setNotice('')
    setError('')
    setEditing({ id: profile.id, name: profile.name, provider: profile.provider, configDir: profile.configDir, enabled: profile.enabled })
  }

  const save = async () => {
    if (!editing) return
    if (!editing.name.trim()) { setError('Profile name is required.'); return }
    if (!editing.configDir.trim()) { setError('Configuration directory is required.'); return }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      if (!window.agentDock) throw new Error('Profiles are available in the Electron app.')
      const id = editing.id || `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      await window.agentDock.upsertProfile({ id, name: editing.name.trim(), provider: editing.provider, configDir: editing.configDir.trim(), enabled: editing.enabled })
      setEditing(null)
      setNotice(`${editing.name.trim()} saved. Login through the provider CLI to authenticate inside the profile directory.`)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (profile: CredentialProfile) => {
    if (!window.confirm(`Delete profile "${profile.name}"?\nThe configuration directory on disk is not touched.`)) return
    setError('')
    setNotice('')
    try {
      if (!window.agentDock) throw new Error('Profiles are available in the Electron app.')
      const ok = await window.agentDock.removeProfile(profile.id)
      if (ok) {
        setProfiles((items) => items.filter((item) => item.id !== profile.id))
        setNotice(`${profile.name} removed.`)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const toggle = async (profile: CredentialProfile, enabled: boolean) => {
    setError('')
    setNotice('')
    try {
      if (!window.agentDock) throw new Error('Profiles are available in the Electron app.')
      await window.agentDock.toggleProfile({ id: profile.id, enabled })
      setProfiles((items) => items.map((item) => item.id === profile.id ? { ...item, enabled } : item))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const byProvider = (provider: ProviderId) => profiles.filter((profile) => profile.provider === provider)

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <h1>Credential profiles</h1>
          <p>Run several accounts side by side, each in its own isolated configuration directory.</p>
        </div>
        <button className="primary-button" onClick={startCreate} disabled={Boolean(editing)}><Plus size={15} />New profile</button>
      </div>

      {error && <div className="skills-message error">{error}</div>}
      {notice && <div className="skills-message success">{notice}</div>}

      {loading ? <div className="skills-message">Loading profiles…</div> : (
        <div className="profile-providers">
          {(['codex', 'claude', 'opencode'] as ProviderId[]).map((provider) => (
            <div className="profile-provider-block" key={provider}>
              <div className="profile-provider-head">
                <span className="profile-provider-name">{providerLabels[provider]}</span>
                <code>{envVarFor[provider]}</code>
              </div>
              {byProvider(provider).length ? (
                <div className="profile-list">
                  {byProvider(provider).map((profile) => (
                    <div className={`profile-row ${profile.enabled ? '' : 'disabled'}`} key={profile.id}>
                      <div className="profile-row-icon"><KeyRound size={16} /></div>
                      <div className="profile-row-info">
                        <strong>{profile.name}{profile.auto && <span className="profile-auto-badge">auto-detected</span>}</strong>
                        <code title={profile.configDir}>{profile.configDir}</code>
                      </div>
                      <div className="profile-row-actions">
                        <label className="default-skill-toggle" title={profile.enabled ? 'Disable profile' : 'Enable profile'}>
                          <b>{profile.enabled ? 'Enabled' : 'Disabled'}</b>
                          <input type="checkbox" checked={profile.enabled} onChange={(event) => void toggle(profile, event.target.checked)} />
                          <i />
                        </label>
                        <button className="profile-action" onClick={() => startEdit(profile)}>Edit <ChevronRight size={13} /></button>
                        <button className="profile-action danger" onClick={() => void remove(profile)} title="Delete profile" disabled={profile.auto}><Trash2 size={13} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : <div className="profile-empty">No {providerLabels[provider]} profiles yet. Profile logins happen through the vendor CLI, scoped to the profile directory.</div>}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="mcp-editor-overlay" onClick={(event) => { if (event.target === event.currentTarget && !saving) setEditing(null) }}>
          <div className="mcp-editor" onClick={(event) => event.stopPropagation()}>
            <div className="mcp-editor-head">
              <h2>{editing.id ? 'Edit profile' : 'New credential profile'}</h2>
              <button className="icon-button" onClick={() => !saving && setEditing(null)} disabled={saving}><X size={18} /></button>
            </div>
            <div className="mcp-editor-body">
              <label>
                <span className="mcp-field-label">Profile name</span>
                <input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder="Work account" disabled={saving} autoFocus />
              </label>
              <label>
                <span className="mcp-field-label">Provider</span>
                <select value={editing.provider} onChange={(event) => setEditing({ ...editing, provider: event.target.value as ProviderId, configDir: defaultConfigDirFor[event.target.value as ProviderId] })} disabled={saving || Boolean(editing.id)}>
                  {(['codex', 'claude', 'opencode'] as ProviderId[]).map((provider) => <option key={provider} value={provider}>{providerLabels[provider]}</option>)}
                </select>
              </label>
              <label className="mcp-form-full">
                <span className="mcp-field-label">Configuration directory</span>
                <input value={editing.configDir} onChange={(event) => setEditing({ ...editing, configDir: event.target.value })} placeholder={defaultConfigDirFor[editing.provider]} disabled={saving} />
                <div className="mcp-form-hint">Set as <code>{envVarFor[editing.provider]}</code> when launching this provider. Login through <code>{providerLabels[editing.provider]} CLI</code> after creating the profile to authenticate inside this directory.</div>
              </label>
              <label className="mcp-enabled-toggle">
                <input type="checkbox" checked={editing.enabled} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} disabled={saving} />
                <i />
                <span>Enabled</span>
              </label>
            </div>
            <div className="mcp-editor-foot">
              <button className="mcp-tool-button" onClick={() => !saving && setEditing(null)} disabled={saving}>Cancel</button>
              <button className="mcp-tool-button primary" onClick={() => void save()} disabled={saving}>{saving ? <RefreshCw className="spin" size={13} /> : <Check size={13} />} Save profile</button>
            </div>
          </div>
        </div>
      )}

      <div className="info-strip">
        <span><Zap size={18} /></span>
        <div>
          <strong>Isolated accounts</strong>
          <p>Each profile points at its own configuration directory. AgentDock sets the provider&apos;s config-dir environment variable for every run, so multiple subscriptions can coexist without logout/login cycles.</p>
        </div>
        <button onClick={() => void refresh()}><RefreshCw size={15} /></button>
      </div>
    </section>
  )
}