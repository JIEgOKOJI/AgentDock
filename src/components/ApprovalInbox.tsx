import { useEffect, useState } from 'react'
import { Check, RefreshCw, ShieldAlert, X } from 'lucide-react'
import { DiffView } from './Markdown'

function ApprovalRow({ run, sessionId, onResolved }: { run: RunReceipt; sessionId: string; onResolved: () => void }) {
  const [patch, setPatch] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    window.agentDock?.readRunArtifact(run.runId, 'final/patch.diff').then(setPatch).catch(() => setPatch(null))
  }, [run.runId])

  const approve = async () => {
    if (!window.agentDock || !patch) return
    setBusy(true)
    setError('')
    try {
      const result = await window.agentDock.adoptRunPatch({ runId: run.runId, sessionId, patch, baseTreeHash: run.baseTreeHash })
      if (!result.ok) throw new Error(result.error === 'adoption_conflict' ? 'Base tree changed since this patch was captured — cannot safely adopt.' : result.error || 'Adopt failed')
      onResolved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const reject = async () => {
    if (!window.agentDock) return
    setBusy(true)
    try {
      await window.agentDock.rejectRunApproval({ runId: run.runId })
      onResolved()
    } finally {
      setBusy(false)
    }
  }

  return <div className="approval-row">
    <div className="approval-row-head">
      <ShieldAlert size={14} />
      <strong>{run.provider}</strong>
      <span className="approval-mode">{run.mode}</span>
      <span className="approval-prompt">{run.prompt.slice(0, 90) || '(no prompt recorded)'}</span>
      <span className="approval-spacer" />
      <span>{new Date(run.finishedAt).toLocaleString()}</span>
    </div>
    {run.warnings?.length ? <div className="approval-warnings">{run.warnings.join(' · ')}</div> : null}
    <button className="approval-diff-toggle" onClick={() => setExpanded((v) => !v)}>{expanded ? 'Hide diff' : 'View diff'} ({patch ? patch.split('\n').length : 0} lines)</button>
    {expanded && (patch ? <DiffView diff={patch} className="approval-diff" /> : <pre className="approval-diff">No patch captured.</pre>)}
    {error && <div className="approval-error">{error}</div>}
    <div className="approval-actions">
      <button className="approval-approve" onClick={() => void approve()} disabled={busy || !patch}>{busy ? <RefreshCw className="spin" size={13} /> : <Check size={13} />} Approve & adopt</button>
      <button className="approval-reject" onClick={() => void reject()} disabled={busy}><X size={13} /> Reject</button>
    </div>
  </div>
}

export function ApprovalInbox({ sessionId, refreshToken }: { sessionId: string | null; refreshToken: number }) {
  const [pending, setPending] = useState<RunReceipt[]>([])

  const refresh = () => {
    if (!sessionId || !window.agentDock) { setPending([]); return }
    window.agentDock.listRuns(sessionId).then((runs) => setPending(runs.filter((r) => r.outcome === 'needs_human'))).catch(() => setPending([]))
  }

  useEffect(refresh, [sessionId, refreshToken])

  if (!pending.length) return null

  return <div className="approval-inbox">
    <div className="approval-inbox-head"><ShieldAlert size={15} /><strong>Approval needed</strong><span>{pending.length} run{pending.length === 1 ? '' : 's'} waiting — protected paths or failing gates blocked auto-adopt.</span></div>
    {pending.map((run) => <ApprovalRow key={run.runId} run={run} sessionId={sessionId!} onResolved={refresh} />)}
  </div>
}
