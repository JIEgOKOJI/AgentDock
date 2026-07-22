import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Boxes, Cpu, DollarSign, GitFork, Save, Shield, Users, Wrench } from 'lucide-react'

export function defaultOrchestrationConfig(): OrchestrationConfig {
  return {
    isolated: false,
    intent: 'agent',
    gates: { testCommand: '', protectedPaths: '' },
    repair: { attempts: 1, untilClean: false },
    maxUsd: '',
    delegate: { enabled: false, maxSubRuns: 8, maxBestOfN: 3 },
    race: { enabled: false, n: 2, providers: [], reviewers: 2, review: false, autoAdopt: false, minScore: 0 },
    council: { enabled: false, providers: [] },
  }
}

function presetsKey(workspace: string) {
  return `agentdock.orchestration.${workspace}`
}

export function loadOrchestrationPreset(workspace: string): OrchestrationConfig {
  try {
    const raw = localStorage.getItem(presetsKey(workspace))
    if (!raw) return defaultOrchestrationConfig()
    return { ...defaultOrchestrationConfig(), ...JSON.parse(raw) }
  } catch {
    return defaultOrchestrationConfig()
  }
}

export function validateOrchestrationConfig(config: OrchestrationConfig, installed: Record<ProviderId, boolean>): string[] {
  const issues: string[] = []
  const readOnly = config.intent !== 'agent'
  if (readOnly && (config.isolated || config.race.enabled || config.delegate.enabled || config.repair.untilClean || config.repair.attempts > 1)) {
    issues.push('Plan/Ask intent is read-only — isolated writes, race, repair, and delegation are disabled for this turn.')
  }
  const installedCount = (Object.keys(installed) as ProviderId[]).filter((id) => installed[id]).length
  if (config.race.enabled) {
    if (config.race.n < 2) issues.push('Race requires at least 2 candidates.')
    if (config.race.providers.length && config.race.providers.length < 2) issues.push('Select at least 2 providers for a race, or leave empty to auto-select.')
    if (!config.race.providers.length && installedCount < 2) issues.push('Race needs at least 2 installed provider CLIs.')
    if (config.race.autoAdopt && !config.gates.testCommand.trim()) issues.push('Auto-adopt without a test gate is unsafe — set a test command or disable auto-adopt.')
  }
  if (config.council.enabled && config.council.providers.length === 1) issues.push('Council needs at least 2 providers (or leave empty to auto-select all installed).')
  if (config.repair.untilClean && !config.gates.testCommand.trim()) issues.push('Until-clean has no stop policy without a test gate — set a test command so repair has something to converge on.')
  if (config.maxUsd.trim() && (Number.isNaN(Number(config.maxUsd)) || Number(config.maxUsd) < 0)) issues.push('Max USD must be a non-negative number.')
  return issues
}

export function buildGatesRequest(config: OrchestrationConfig) {
  const testCommand = config.gates.testCommand.trim() ? config.gates.testCommand.trim().split(/\s+/) : null
  const protectedPaths = config.gates.protectedPaths.split(',').map((p) => p.trim()).filter(Boolean)
  return { testCommand, protectedPaths }
}

export function buildRunRequestExtras(config: OrchestrationConfig) {
  const readOnly = config.intent !== 'agent'
  const gates = buildGatesRequest(config)
  return {
    isolated: !readOnly && config.isolated,
    gates: (gates.testCommand || gates.protectedPaths.length) ? gates : undefined,
    repair: !readOnly && (config.repair.attempts > 1 || config.repair.untilClean) ? { attempts: config.repair.attempts, untilClean: config.repair.untilClean } : undefined,
    maxUsd: config.maxUsd.trim() ? Number(config.maxUsd) : undefined,
    delegate: !readOnly && config.delegate.enabled ? { maxSubRuns: config.delegate.maxSubRuns, maxBestOfN: config.delegate.maxBestOfN } : undefined,
  }
}

const PROVIDER_LIST: ProviderId[] = ['codex', 'claude', 'opencode']

export function OrchestrationControls({
  workspace,
  installed,
  intent,
  config,
  onChange,
  onValidityChange,
}: {
  workspace: string
  installed: Record<ProviderId, boolean>
  intent: 'agent' | 'plan' | 'ask'
  config: OrchestrationConfig
  onChange: (config: OrchestrationConfig) => void
  onValidityChange?: (valid: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const readOnly = intent !== 'agent'
  const issues = useMemo(() => validateOrchestrationConfig({ ...config, intent }, installed), [config, intent, installed])

  useEffect(() => { onValidityChange?.(issues.length === 0) }, [issues])

  const patch = (partial: Partial<OrchestrationConfig>) => onChange({ ...config, ...partial })
  const savePreset = () => { try { localStorage.setItem(presetsKey(workspace), JSON.stringify(config)) } catch {} }

  const toggleProvider = (list: string[], id: ProviderId): string[] => list.includes(id) ? list.filter((p) => p !== id) : [...list, id]

  return <div className="orchestration-panel">
    <button className={`orchestration-toggle ${open ? 'open' : ''}`} onClick={() => setOpen((value) => !value)}>
      <Boxes size={14} /> Orchestration
      {(config.isolated || config.race.enabled || config.council.enabled || config.gates.testCommand || config.repair.attempts > 1 || config.repair.untilClean || config.maxUsd || config.delegate.enabled) && <span className="orchestration-badge">active</span>}
      {issues.length > 0 && <span className="orchestration-badge warn"><AlertTriangle size={11} /> {issues.length}</span>}
    </button>

    {open && <div className="orchestration-body">
      {readOnly && <div className="orchestration-note"><Shield size={13} /> Plan/Ask is read-only this turn — write-capable controls below are disabled.</div>}

      <div className="orchestration-row">
        <label className="orchestration-check"><input type="checkbox" checked={config.isolated} disabled={readOnly} onChange={(e) => patch({ isolated: e.target.checked })} /><Shield size={13} /><span>Isolated worktree</span><small>Run in a disposable git worktree; only adopt into the live workspace after gates pass.</small></label>
      </div>

      <div className="orchestration-section">
        <div className="orchestration-section-title"><Wrench size={13} /> Gates</div>
        <input placeholder="Test command, e.g. npm test" value={config.gates.testCommand} disabled={readOnly} onChange={(e) => patch({ gates: { ...config.gates, testCommand: e.target.value } })} />
        <input placeholder="Protected path globs, comma-separated (e.g. migrations/**, **/*.env)" value={config.gates.protectedPaths} disabled={readOnly} onChange={(e) => patch({ gates: { ...config.gates, protectedPaths: e.target.value } })} />
      </div>

      <div className="orchestration-section">
        <div className="orchestration-section-title"><Cpu size={13} /> Repair loop</div>
        <div className="orchestration-inline">
          <label>Attempts <input type="number" min={1} max={10} value={config.repair.attempts} disabled={readOnly || config.repair.untilClean} onChange={(e) => patch({ repair: { ...config.repair, attempts: Math.max(1, Math.min(10, Number(e.target.value) || 1)) } })} /></label>
          <label className="orchestration-check"><input type="checkbox" checked={config.repair.untilClean} disabled={readOnly} onChange={(e) => patch({ repair: { ...config.repair, untilClean: e.target.checked } })} /><span>Until clean</span></label>
        </div>
      </div>

      <div className="orchestration-section">
        <div className="orchestration-section-title"><DollarSign size={13} /> Budget & delegation</div>
        <div className="orchestration-inline">
          <label>Max USD <input type="number" min={0} step="0.01" placeholder="unlimited" value={config.maxUsd} onChange={(e) => patch({ maxUsd: e.target.value })} /></label>
          <label className="orchestration-check"><input type="checkbox" checked={config.delegate.enabled} disabled={readOnly} onChange={(e) => patch({ delegate: { ...config.delegate, enabled: e.target.checked } })} /><span>Allow delegation</span></label>
          {config.delegate.enabled && <>
            <label>Max sub-runs <input type="number" min={1} max={16} value={config.delegate.maxSubRuns} disabled={readOnly} onChange={(e) => patch({ delegate: { ...config.delegate, maxSubRuns: Math.max(1, Math.min(16, Number(e.target.value) || 8)) } })} /></label>
            <label>Best-of-N cap <input type="number" min={2} max={5} value={config.delegate.maxBestOfN} disabled={readOnly} onChange={(e) => patch({ delegate: { ...config.delegate, maxBestOfN: Math.max(2, Math.min(5, Number(e.target.value) || 3)) } })} /></label>
          </>}
        </div>
      </div>

      <div className="orchestration-section">
        <div className="orchestration-section-title"><GitFork size={13} /> Best-of-N race</div>
        <label className="orchestration-check"><input type="checkbox" checked={config.race.enabled} disabled={readOnly} onChange={(e) => patch({ race: { ...config.race, enabled: e.target.checked } })} /><span>Race candidates instead of a single run</span></label>
        {config.race.enabled && <div className="orchestration-race-body">
          <div className="orchestration-inline">
            <label>N <input type="number" min={2} max={5} value={config.race.n} onChange={(e) => patch({ race: { ...config.race, n: Math.max(2, Math.min(5, Number(e.target.value) || 2)) } })} /></label>
            <label>Reviewers <input type="number" min={1} max={5} value={config.race.reviewers} onChange={(e) => patch({ race: { ...config.race, reviewers: Math.max(1, Math.min(5, Number(e.target.value) || 2)) } })} /></label>
            <label className="orchestration-check"><input type="checkbox" checked={config.race.review} onChange={(e) => patch({ race: { ...config.race, review: e.target.checked } })} /><span>Cross-family review</span></label>
            <label className="orchestration-check"><input type="checkbox" checked={config.race.autoAdopt} onChange={(e) => patch({ race: { ...config.race, autoAdopt: e.target.checked } })} /><span>Auto-adopt winner</span></label>
          </div>
          <div className="orchestration-providers">{PROVIDER_LIST.map((id) => <label key={id} className={`orchestration-provider-chip ${!installed[id] ? 'disabled' : ''}`}><input type="checkbox" checked={config.race.providers.includes(id)} disabled={!installed[id]} onChange={() => patch({ race: { ...config.race, providers: toggleProvider(config.race.providers, id) } })} /><span>{id}</span></label>)}</div>
        </div>}
      </div>

      <div className="orchestration-section">
        <div className="orchestration-section-title"><Users size={13} /> Council planning</div>
        <label className="orchestration-check"><input type="checkbox" checked={config.council.enabled} onChange={(e) => patch({ council: { ...config.council, enabled: e.target.checked } })} /><span>Draft the plan in parallel across providers, then merge</span></label>
        {config.council.enabled && <div className="orchestration-providers">{PROVIDER_LIST.map((id) => <label key={id} className={`orchestration-provider-chip ${!installed[id] ? 'disabled' : ''}`}><input type="checkbox" checked={config.council.providers.includes(id)} disabled={!installed[id]} onChange={() => patch({ council: { ...config.council, providers: toggleProvider(config.council.providers, id) } })} /><span>{id}</span></label>)}</div>}
      </div>

      {issues.length > 0 && <div className="orchestration-issues">{issues.map((issue) => <div key={issue} className="orchestration-issue"><AlertTriangle size={12} /> {issue}</div>)}</div>}

      <div className="orchestration-footer">
        <button onClick={savePreset}><Save size={12} /> Save as workspace preset</button>
      </div>
    </div>}
  </div>
}
