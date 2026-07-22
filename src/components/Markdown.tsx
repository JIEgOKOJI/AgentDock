import React from 'react'

// Minimal dependency-free markdown renderer for agent responses:
// code fences, inline code, bold, links, headings, bullet/numbered lists.
function InlineMd({ text }: { text: string }) {
  const nodes: React.ReactNode[] = []
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
  let last = 0
  let key = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    if (match[1] != null) nodes.push(<code key={key++}>{match[1]}</code>)
    else if (match[2] != null) nodes.push(<strong key={key++}>{match[2]}</strong>)
    else nodes.push(<a key={key++} href={match[4]} target="_blank" rel="noreferrer">{match[3]}</a>)
    last = match.index + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return <>{nodes}</>
}

const structural = /^(?:```|#{1,4}\s|\s*[-*]\s+\S|\s*\d+[.)]\s+\S)/

export function Markdown({ content }: { content: string }) {
  const lines = content.split(/\r?\n/)
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const code: string[] = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i += 1 }
      i += 1
      blocks.push(<pre className="md-code" key={key++}><code>{code.join('\n')}</code></pre>)
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/)
    if (heading) {
      blocks.push(<div className={`md-h md-h${heading[1].length}`} key={key++}><InlineMd text={heading[2]} /></div>)
      i += 1
      continue
    }
    const bullet = line.match(/^\s*[-*]\s+(\S.*)/)
    if (bullet) {
      const items: string[] = []
      while (i < lines.length) {
        const item = lines[i].match(/^\s*[-*]\s+(\S.*)/)
        if (!item) break
        items.push(item[1])
        i += 1
      }
      blocks.push(<ul className="md-list" key={key++}>{items.map((item, j) => <li key={j}><InlineMd text={item} /></li>)}</ul>)
      continue
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(\S.*)/)
    if (ordered) {
      const items: string[] = []
      while (i < lines.length) {
        const item = lines[i].match(/^\s*\d+[.)]\s+(\S.*)/)
        if (!item) break
        items.push(item[1])
        i += 1
      }
      blocks.push(<ol className="md-list" key={key++}>{items.map((item, j) => <li key={j}><InlineMd text={item} /></li>)}</ol>)
      continue
    }
    if (!line.trim()) { i += 1; continue }
    const paragraph: string[] = [line]
    i += 1
    while (i < lines.length && lines[i].trim() && !structural.test(lines[i])) {
      paragraph.push(lines[i])
      i += 1
    }
    blocks.push(<p key={key++}><InlineMd text={paragraph.join('\n')} /></p>)
  }
  return <div className="markdown">{blocks}</div>
}

export function DiffView({ diff, className = 'file-diff' }: { diff: string; className?: string }) {
  return <pre className={`${className} diff-view`}>{diff.split(/\r?\n/).map((line, index) => {
    const kind = /^(\+\+\+|---|diff |index )/.test(line) ? 'meta'
      : line.startsWith('@@') ? 'hunk'
        : line.startsWith('+') ? 'add'
          : line.startsWith('-') ? 'del' : ''
    return <span key={index} className={kind ? `diff-${kind}` : undefined}>{line || ' '}{'\n'}</span>
  })}</pre>
}
