import { useState } from 'react'
import { Award, Check, ChevronRight, RefreshCw, ShieldAlert } from 'lucide-react'
import { DiffView } from './Markdown'

export interface RaceResultView {
  raceId: string
  winner: RaceCandidate | null
  scores: Array<{ candidateId: string; score: number; provider: string }>
  candidates: RaceCandidate[]
  reason?: string
}

function CandidateCard({ candidate, isWinner, sessionId, onAdopted }: { candidate: RaceCandidate; isWinner: boolean; sessionId: string; onAdopted: (candidateId: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [adopted, setAdopted] = useState(false)

  const adopt = async () => {
    if (!window.agentDock) return
    setBusy(true)
    setError('')
    try {
      const result = await window.agentDock.adoptRunPatch({ runId: candidate.runId, sessionId, patch: candidate.patch, baseTreeHash: candidate.baseTreeHash })
      if (!result.ok) throw new Error(result.error === 'adoption_conflict' ? 'Live workspace changed since this candidate ran — cannot safely adopt.' : result.error || 'Adopt failed')
      setAdopted(true)
      onAdopted(candidate.candidateId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const reviews = candidate.reviews?.length ? candidate.reviews : (candidate.review ? [candidate.review] : [])

  return <div className={`compare-card ${isWinner ? 'winner' : ''} ${candidate.failClosed ? 'fail-closed' : ''}`}>
    <div className="compare-card-head">
      {isWinner && <Award size={14} />}
      <strong>{candidate.provider}</strong>
      <span className="compare-score">score {candidate.score}</span>
      <span className="compare-spacer" />
      <span className={`compare-exit ${candidate.exitCode === 0 ? 'ok' : 'fail'}`}>exit {candidate.exitCode ?? '—'}</span>
    </div>
    {candidate.failClosed && <div className="compare-fail-closed"><ShieldAlert size={12} /> {candidate.spawnError || 'Candidate could not run in an isolated envelope (fail-closed)'}</div>}
    {candidate.gateResult && <div className="compare-gates" data-overall={candidate.gateResult.overall}>
      gates: {candidate.gateResult.overall}{candidate.gateResult.needsApproval ? ' · needs approval' : ''}
    </div>}
    {reviews.length > 0 && <div className="compare-reviews">{reviews.map((review, i) => <span key={i} className={`compare-review compare-review-${review.verdict}`}>{review.verdict}{review.quality ? ` (${review.quality})` : ''}</span>)}</div>}
    <p className="compare-summary">{candidate.summary.slice(0, 220) || 'No summary produced.'}</p>
    <button className="compare-diff-toggle" onClick={() => setExpanded((v) => !v)}><ChevronRight size={12} style={{ transform: expanded ? 'rotate(90deg)' : 'none' }} /> {expanded ? 'Hide diff' : 'View diff'} ({candidate.filesChanged.length} files)</button>
    {expanded && (candidate.patch ? <DiffView diff={candidate.patch} className="compare-diff" /> : <pre className="compare-diff">No patch produced.</pre>)}
    {error && <div className="compare-error">{error}</div>}
    <div className="compare-actions">
      {adopted ? <span className="compare-adopted"><Check size={13} /> Adopted</span> : <button onClick={() => void adopt()} disabled={busy || !candidate.patch || candidate.failClosed}>{busy ? <RefreshCw className="spin" size={13} /> : null} Adopt this candidate</button>}
    </div>
  </div>
}

export function CompareView({ result, sessionId, onAdopted }: { result: RaceResultView; sessionId: string; onAdopted: (candidateId: string) => void }) {
  return <div className="compare-view">
    <div className="compare-head">
      <strong>Race {result.raceId.slice(0, 8)}</strong>
      <span>{result.winner ? `Winner: ${result.winner.provider}` : `No winner${result.reason ? ` — ${result.reason.replace(/_/g, ' ')}` : ''}`}</span>
    </div>
    <div className="compare-grid">
      {result.candidates.map((candidate) => <CandidateCard key={candidate.candidateId} candidate={candidate} isWinner={result.winner?.candidateId === candidate.candidateId} sessionId={sessionId} onAdopted={onAdopted} />)}
    </div>
  </div>
}
