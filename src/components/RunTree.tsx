import { useMemo } from 'react'
import { CircleStop } from 'lucide-react'

interface TreeNode {
  run: RunReceipt
  children: TreeNode[]
}

function buildTree(runs: RunReceipt[]): TreeNode[] {
  const byId = new Map(runs.map((run) => [run.runId, { run, children: [] as TreeNode[] }]))
  const roots: TreeNode[] = []
  for (const node of byId.values()) {
    if (node.run.parentRunId && byId.has(node.run.parentRunId)) byId.get(node.run.parentRunId)!.children.push(node)
    else roots.push(node)
  }
  return roots.sort((a, b) => b.run.finishedAt - a.run.finishedAt)
}

function runAge(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function runDuration(run: RunReceipt) {
  if (!run.startedAt || !run.finishedAt || run.finishedAt <= run.startedAt) return ''
  const seconds = Math.round((run.finishedAt - run.startedAt) / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function Node({ node, selected, onSelect, activeRunId, onStop, depth }: { node: TreeNode; selected: string | undefined; onSelect: (run: RunReceipt) => void; activeRunId: string | null; onStop: (runId: string) => void; depth: number }) {
  const isActive = node.run.runId === activeRunId
  const duration = runDuration(node.run)
  return <div className="run-tree-node" style={{ '--depth': depth } as React.CSSProperties}>
    <button className={`run-tree-row ${selected === node.run.runId ? 'active' : ''}`} onClick={() => onSelect(node.run)} title={`${new Date(node.run.finishedAt).toLocaleString()}${duration ? ` · ran ${duration}` : ''}`}>
      <span className="run-tree-mode">{node.run.mode}</span>
      <span className="run-outcome" data-outcome={node.run.outcome}>{node.run.outcome}</span>
      <span className="run-tree-provider">{node.run.provider}</span>
      <span className="run-tree-prompt">{node.run.prompt.slice(0, 60) || node.run.runId.slice(0, 8)}</span>
      <span className="run-tree-spacer" />
      <span className="run-tree-time">{duration && <em>{duration}</em>}{runAge(node.run.finishedAt)}</span>
      {isActive && <button className="run-tree-stop" onClick={(e) => { e.stopPropagation(); onStop(node.run.runId) }} title="Stop"><CircleStop size={13} /></button>}
    </button>
    {node.children.length > 0 && <div className="run-tree-children">
      {node.children.map((child) => <Node key={child.run.runId} node={child} selected={selected} onSelect={onSelect} activeRunId={activeRunId} onStop={onStop} depth={depth + 1} />)}
    </div>}
  </div>
}

export function RunTree({ runs, selectedRunId, onSelect, activeRunId, onStopTree }: { runs: RunReceipt[]; selectedRunId: string | undefined; onSelect: (run: RunReceipt) => void; activeRunId: string | null; onStopTree: (rootRunId: string, childIds: string[]) => void }) {
  const tree = useMemo(() => buildTree(runs), [runs])
  const onStop = (runId: string) => {
    const node = tree.find((root) => root.run.runId === runId)
    const childIds = node ? node.children.map((child) => child.run.runId) : []
    onStopTree(runId, childIds)
  }
  if (!tree.length) return <div className="run-tree-empty">No runs recorded yet for this session.</div>
  return <div className="run-tree">
    {tree.map((node) => <Node key={node.run.runId} node={node} selected={selectedRunId} onSelect={onSelect} activeRunId={activeRunId} onStop={onStop} depth={0} />)}
  </div>
}
