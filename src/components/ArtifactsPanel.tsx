import { useEffect, useState } from 'react'
import { Download, FileCode, ShieldCheck } from 'lucide-react'
import { DiffView } from './Markdown'

function exportArtifact(name: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name.replace(/[\\/]/g, '_')
  anchor.click()
  URL.revokeObjectURL(url)
}

export function ArtifactsPanel({ run }: { run: RunReceipt | null }) {
  const [entries, setEntries] = useState<ArtifactEntry[]>([])
  const [manifest, setManifest] = useState<RunManifest | null>(null)
  const [selectedPath, setSelectedPath] = useState<string>('')
  const [content, setContent] = useState<string | null>(null)
  const [pretty, setPretty] = useState(true)
  const [verify, setVerify] = useState<{ ok: boolean; mismatches?: Array<Record<string, unknown>> } | null>(null)

  useEffect(() => {
    if (!run || !window.agentDock) { setEntries([]); setManifest(null); setSelectedPath(''); return }
    Promise.all([
      window.agentDock.listRunArtifacts(run.runId),
      window.agentDock.getRunManifest(run.runId),
    ]).then(([files, m]) => {
      setEntries(files)
      setManifest(m)
      const defaultPath = files.find((f) => f.path === 'final/summary.md')?.path || files[0]?.path || ''
      setSelectedPath(defaultPath)
    }).catch(() => { setEntries([]); setManifest(null) })
    setVerify(null)
  }, [run?.runId])

  useEffect(() => {
    if (!run || !selectedPath || !window.agentDock) { setContent(null); return }
    window.agentDock.readRunArtifact(run.runId, selectedPath).then(setContent).catch(() => setContent(null))
  }, [run?.runId, selectedPath])

  const runVerify = async () => {
    if (!run || !window.agentDock) return
    const result = await window.agentDock.verifyRunManifest(run.runId)
    setVerify(result)
  }

  if (!run) return <div className="artifacts-empty">Select a run to inspect its artifacts.</div>

  const displayContent = content ?? ''
  const isJson = selectedPath.endsWith('.json')
  const rendered = pretty && isJson
    ? (() => { try { return JSON.stringify(JSON.parse(displayContent), null, 2) } catch { return displayContent } })()
    : displayContent

  return <div className="artifacts-panel">
    <div className="artifacts-toolbar">
      <span className="artifacts-runid" title={run.runId}>{run.mode} · {run.runId.slice(0, 8)}</span>
      <span className="artifacts-spacer" />
      {isJson && <button className={pretty ? 'active' : ''} onClick={() => setPretty((v) => !v)}><FileCode size={12} /> {pretty ? 'Pretty' : 'Raw'}</button>}
      <button onClick={runVerify}><ShieldCheck size={12} /> Verify manifest</button>
      {content != null && <button onClick={() => exportArtifact(`${run.runId}-${selectedPath.split('/').pop()}`, displayContent)}><Download size={12} /> Export</button>}
    </div>
    {verify && <div className={`artifacts-verify ${verify.ok ? 'ok' : 'fail'}`}>{verify.ok ? 'Manifest hashes verified — all files match.' : `Mismatch: ${JSON.stringify(verify.mismatches ?? verify)}`}</div>}
    <div className="artifacts-body">
      <div className="artifacts-file-list">
        {entries.length === 0 && <div className="artifacts-empty">No artifact files recorded.</div>}
        {entries.map((entry) => <button key={entry.path} className={entry.path === selectedPath ? 'active' : ''} onClick={() => setSelectedPath(entry.path)}>
          <span>{entry.path}</span><small>{entry.size}B</small>
        </button>)}
      </div>
      {content != null && /\.(diff|patch)$/.test(selectedPath)
        ? <DiffView diff={rendered} className="artifacts-content" />
        : <pre className="artifacts-content">{content != null ? rendered : 'No content.'}</pre>}
    </div>
    {manifest && <div className="artifacts-manifest-note">manifest v{manifest.version} · kind {manifest.kind} · generated {new Date(manifest.generated).toLocaleString()}</div>}
  </div>
}
