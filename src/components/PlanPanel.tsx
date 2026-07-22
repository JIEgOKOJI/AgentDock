import { useEffect, useMemo, useState } from 'react'
import { BrainCircuit, Check, ChevronRight, History, RefreshCw, ShieldAlert } from 'lucide-react'

type AnswerMap = Record<string, string | string[]>

function answerToText(kind: OpenQuestion['kind'], value: string | string[] | undefined): string {
  if (value == null) return ''
  if (Array.isArray(value)) return value.join(', ')
  return value
}

export function PlanPanel({
  sessionId,
  provider,
  runId,
  refreshToken,
  onImplement,
  onRePlan,
}: {
  sessionId: string | null
  provider: ProviderId
  runId: string | null
  refreshToken: number
  onImplement: (prompt: string) => void
  onRePlan: () => void
}) {
  const [contract, setContract] = useState<PlanContract | null>(null)
  const [answers, setAnswers] = useState<AnswerMap>({})
  const [history, setHistory] = useState<RunReceipt[]>([])
  const [saving, setSaving] = useState(false)
  const [implementing, setImplementing] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const load = async () => {
    if (!sessionId || !window.agentDock) { setContract(null); return }
    try {
      const [plan, runs] = await Promise.all([
        window.agentDock.readPlan({ sessionId }),
        window.agentDock.listRuns(sessionId),
      ])
      setContract(plan)
      setHistory(runs.filter((run) => run.planHash))
      if (plan) {
        const initial: AnswerMap = {}
        for (const question of plan.openQuestions) {
          if (question.value) initial[question.id] = question.kind === 'multi' ? question.value.split(', ').filter(Boolean) : question.value
        }
        setAnswers(initial)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  useEffect(() => { void load() }, [sessionId, refreshToken])

  const unanswered = useMemo(() => {
    if (!contract) return []
    return contract.openQuestions.filter((question) => question.required !== false && !answerToText(question.kind, answers[question.id]).trim())
  }, [contract, answers])

  const setAnswer = (question: OpenQuestion, value: string) => {
    setAnswers((current) => {
      if (question.kind !== 'multi') return { ...current, [question.id]: value }
      const list = Array.isArray(current[question.id]) ? [...(current[question.id] as string[])] : []
      const index = list.indexOf(value)
      if (index >= 0) list.splice(index, 1)
      else list.push(value)
      return { ...current, [question.id]: list }
    })
  }

  const saveAnswers = async () => {
    if (!contract || !sessionId || !window.agentDock) return null
    setSaving(true)
    setError('')
    try {
      const payload = contract.openQuestions.map((question) => ({ text: question.text, value: answerToText(question.kind, answers[question.id]) })).filter((entry) => entry.value)
      const result = await window.agentDock.adoptPlan({ sessionId, planText: contract.content, answers: payload })
      if (!result) throw new Error('Failed to save answers')
      await load()
      return result
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return null
    } finally {
      setSaving(false)
    }
  }

  const implement = async () => {
    if (!contract || !sessionId || !window.agentDock) return
    setImplementing(true)
    setError('')
    try {
      const saved = unanswered.length === 0 ? await saveAnswers() : null
      const effectiveHash = saved?.hash ?? contract.hash
      const effectiveReadiness = saved?.readiness ?? contract.readiness
      if (unanswered.length) throw new Error(`Answer ${unanswered.length} required question${unanswered.length === 1 ? '' : 's'} before implementing.`)
      if (effectiveReadiness !== 'ready') throw new Error(`Plan is not ready (${effectiveReadiness.replace(/_/g, ' ')}). Re-plan or resolve open questions.`)
      const verified = await window.agentDock.verifyPlanHash({ sessionId, hash: effectiveHash })
      if (!verified) throw new Error('Plan contract changed on disk since it was last read — re-plan before implementing.')
      onImplement(`Implement the accepted plan recorded at ${contract.path} (contract hash: ${effectiveHash}). Read that file for the full plan and provided answers, then implement it.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setImplementing(false)
    }
  }

  if (!contract) return null

  const busy = Boolean(runId) || saving || implementing

  return <div className="plan-panel">
    <div className="plan-panel-head">
      <BrainCircuit size={16} />
      <strong>Plan</strong>
      <span className={`plan-readiness plan-readiness-${contract.readiness}`}>{contract.readiness.replace(/_/g, ' ')}</span>
      <span className="plan-hash" title={contract.path}>{contract.hash}</span>
      <span className="plan-panel-spacer" />
      <button className="plan-panel-toggle" onClick={() => setShowHistory((value) => !value)}><History size={13} /> History ({history.length})</button>
      <button className="plan-panel-toggle" onClick={() => setExpanded((value) => !value)}><ChevronRight size={13} style={{ transform: expanded ? 'rotate(90deg)' : 'none' }} /> {expanded ? 'Collapse' : 'Expand'}</button>
    </div>

    {showHistory && <div className="plan-history">
      {history.length === 0 && <div className="plan-history-empty">No prior plan revisions recorded yet.</div>}
      {history.sort((a, b) => b.finishedAt - a.finishedAt).map((run) => <div key={run.runId} className={`plan-history-row ${run.planHash === contract.hash ? 'current' : ''}`}>
        <span className="plan-hash">{run.planHash}</span>
        <span>{new Date(run.finishedAt).toLocaleString()}</span>
        <span data-outcome={run.outcome}>{run.outcome}</span>
        {run.planHash === contract.hash && <em><Check size={11} /> current</em>}
      </div>)}
    </div>}

    {expanded && <pre className="plan-content">{contract.content}</pre>}

    {contract.openQuestions.length > 0 && <div className="plan-questions-form">
      <div className="plan-questions-title">Open questions ({contract.openQuestions.length})</div>
      {contract.openQuestions.map((question) => <div key={question.id} className="plan-question-row">
        <div className="plan-question-label"><span className={`plan-question-kind plan-question-${question.kind}`}>{question.kind}</span>{question.text}{question.required !== false && <span className="plan-question-required">*</span>}</div>
        {question.kind === 'text' && <textarea value={answerToText(question.kind, answers[question.id])} onChange={(e) => setAnswer(question, e.target.value)} disabled={busy} placeholder="Your answer…" />}
        {question.kind === 'single' && <div className="plan-question-options">
          {(question.options?.length ? question.options : ['Yes', 'No']).map((option) => <label key={option}><input type="radio" name={question.id} checked={answers[question.id] === option} onChange={() => setAnswer(question, option)} disabled={busy} /><span>{option}</span></label>)}
        </div>}
        {question.kind === 'multi' && <div className="plan-question-options">
          {(question.options?.length ? question.options : []).map((option) => <label key={option}><input type="checkbox" checked={Array.isArray(answers[question.id]) && (answers[question.id] as string[]).includes(option)} onChange={() => setAnswer(question, option)} disabled={busy} /><span>{option}</span></label>)}
        </div>}
      </div>)}
      <div className="plan-question-actions">
        <button onClick={() => void saveAnswers()} disabled={busy}>{saving ? <RefreshCw className="spin" size={13} /> : <Check size={13} />} Accept plan</button>
      </div>
    </div>}

    {error && <div className="plan-panel-error"><ShieldAlert size={13} /> {error}</div>}

    <div className="plan-panel-actions">
      <button className="plan-implement" onClick={() => void implement()} disabled={busy}>{implementing ? <RefreshCw className="spin" size={14} /> : <BrainCircuit size={14} />} Implement with {provider}</button>
      <button className="plan-replan" onClick={onRePlan} disabled={busy}>Re-plan</button>
    </div>
  </div>
}
