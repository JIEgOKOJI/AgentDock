const asText = (value) => typeof value === 'string' ? value.trim() : ''
const lines = (value) => asText(value) ? String(value).split(/\r?\n/) : []
const blocks = (event) => Array.isArray(event?.message?.content) ? event.message.content : []
const editTool = (name) => /^(?:edit|write|multiedit|notebookedit|apply_patch|patch)$/i.test(name || '')

function textDiff(before, after) {
  const removed = lines(before).map((line) => `-${line}`)
  const added = lines(after).map((line) => `+${line}`)
  if (!removed.length && !added.length) return ''
  return ['--- before', '+++ after', ...removed, ...added].join('\n')
}

export function parseAgentTranscript(provider, raw) {
  const answers = [], activities = [], finalFiles = [], seenActivities = new Set(), sourceActivities = new Map()
  const typedEvents = []
  let position = 0
  let lastActionPosition = -1
  let explicitSummary = ''
  let cliSessionId = ''

  const answer = (value, explicit = false) => {
    const text = asText(value)
    if (!text) return
    const previous = answers.at(-1)
    if (previous?.text === text) return
    if (previous && text.includes(previous.text)) answers.pop()
    else if (previous?.text.includes(text)) return
    answers.push({ text, position })
    if (explicit) explicitSummary = text
  }

  const activity = (item, sourceId = '') => {
    if (sourceId && sourceActivities.has(sourceId)) {
      const index = sourceActivities.get(sourceId)
      activities[index] = { ...activities[index], ...item, id: activities[index].id }
      if (item.type !== 'thinking') lastActionPosition = position
      return
    }
    const key = `${item.type}|${item.title}|${item.detail || ''}|${item.output || ''}|${JSON.stringify(item.files || [])}`
    if (seenActivities.has(key)) return
    seenActivities.add(key)
    activities.push({ id: `activity-${activities.length + 1}`, status: 'completed', ...item })
    if (sourceId) sourceActivities.set(sourceId, activities.length - 1)
    if (item.type !== 'thinking') lastActionPosition = position
  }

  const changedFile = (input) => {
    const path = input.file_path || input.filePath || input.path || input.notebook_path
    if (!path) return null
    const before = input.old_string ?? input.oldString ?? ''
    const after = input.new_string ?? input.newString ?? input.content ?? ''
    return {
      path: String(path),
      additions: lines(after).length,
      deletions: lines(before).length,
      diff: textDiff(before, after),
    }
  }

  const collectTypedEvent = (payload) => {
    if (!payload || typeof payload.type !== 'string' || !payload.type.startsWith('agentdock.')) return
    typedEvents.push({ ...payload, position })
  }

  for (const line of String(raw || '').split(/\r?\n/).filter(Boolean)) {
    position += 1
    let event
    try { event = JSON.parse(line) } catch { if (!line.startsWith('{')) answer(line); continue }

    if (event.type && event.type.startsWith('agentdock.')) {
      collectTypedEvent(event)
      if (event.type === 'agentdock.file_changes') {
        finalFiles.splice(0, finalFiles.length, ...(event.changes || []).filter((file) => file?.path).map((file) => ({
          path: String(file.path), additions: Number(file.additions) || 0, deletions: Number(file.deletions) || 0, diff: asText(file.diff),
        })))
      }
      continue
    }

    if (!cliSessionId) {
      if (provider === 'codex' && event.type === 'thread.started' && typeof event.thread_id === 'string') {
        cliSessionId = event.thread_id
      } else if (provider === 'claude' && typeof event.session_id === 'string' && /^[0-9a-f-]{36}$/i.test(event.session_id)) {
        cliSessionId = event.session_id
      } else if (provider === 'opencode' && typeof event.sessionID === 'string' && event.sessionID.startsWith('ses_')) {
        cliSessionId = event.sessionID
      }
    }

    if (provider === 'codex') {
      const item = event.item || {}
      if (item.type === 'agent_message') answer(item.text)
      else if (item.type === 'reasoning') activity({ type: 'thinking', title: 'Reasoning', detail: item.text || item.summary || '' }, item.id)
      else if (item.type === 'command_execution') activity({ type: 'command', title: item.command || 'Command', detail: item.command || '', output: item.aggregated_output || '', status: item.status || 'completed' }, item.id)
      else if (item.type === 'file_change') {
        for (const change of item.changes || []) {
          const file = { path: change.path || change.file_path, additions: Number(change.additions) || 0, deletions: Number(change.deletions) || 0, diff: change.diff || change.patch || '' }
          if (file.path) activity({ type: 'files', title: change.kind || 'edit', files: [file] }, item.id ? `${item.id}:${file.path}` : '')
        }
      }
      if (event.type === 'message') answer(event.message?.content || event.text)
    } else if (provider === 'claude') {
      for (const block of blocks(event)) {
        if (block.type === 'text') answer(block.text)
        else if (block.type === 'thinking') activity({ type: 'thinking', title: 'Reasoning', detail: block.thinking || block.text || '' }, block.id)
        else if (block.type === 'tool_use') {
          const input = block.input || {}, name = block.name || 'Action'
          if (editTool(name)) {
            const file = changedFile(input)
            activity({ type: 'files', title: name, detail: file ? '' : JSON.stringify(input, null, 2), files: file ? [file] : [] }, block.id)
          } else if (/^(?:bash|shell|terminal|computer)$/i.test(name)) activity({ type: 'command', title: name, detail: input.command || input.cmd || JSON.stringify(input, null, 2), status: 'running' }, block.id)
          else activity({ type: 'tool', title: name, detail: Object.keys(input).length ? JSON.stringify(input, null, 2) : '' }, block.id)
        }
      }
      if (event.type === 'result') answer(event.result, true)
    } else {
      const part = event.part || event
      if (part.type === 'text') answer(part.text)
      else if (/reasoning/i.test(part.type || '')) activity({ type: 'thinking', title: 'Reasoning', detail: part.text || part.reasoning || '' }, part.id)
      else if (/tool/i.test(part.type || '')) {
        const input = part.state?.input || part.input || {}, name = part.tool || part.name || 'Action'
        if (editTool(name)) {
          const file = changedFile(input)
          activity({ type: 'files', title: name, detail: file ? '' : JSON.stringify(input, null, 2), output: part.state?.output || '', files: file ? [file] : [] }, part.id)
        } else if (input.command || input.cmd) activity({ type: 'command', title: name, detail: input.command || input.cmd, output: part.state?.output || '', status: part.state?.status || 'completed' }, part.id)
        else activity({ type: 'tool', title: name, detail: Object.keys(input).length ? JSON.stringify(input, null, 2) : '', output: part.state?.output || '' }, part.id)
      }
      if (!part.type) answer(event.text || event.content)
    }
  }

  const finalAnswers = answers.filter((item) => item.position > lastActionPosition)
  const content = explicitSummary || (finalAnswers.length ? finalAnswers : answers.slice(-1)).map((item) => item.text).join('\n\n')
  const outcome = typedEvents.find((event) => event.type === 'agentdock.run.outcome')?.outcome || null
  return { content, activities, finalFiles, cliSessionId, typedEvents, outcome }
}
