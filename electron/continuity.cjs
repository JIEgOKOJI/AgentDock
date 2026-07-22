const path = require('node:path')
const fs = require('node:fs')

const CONTINUITY_VERSION = 1

function continuityDir(userData, sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  return path.join(userData, 'lanes', safe, 'context')
}

function checkpointPath(userData, sessionId, provider, profileId) {
  const profile = profileId || 'default'
  const providerSafe = String(provider).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
  const profileSafe = String(profile).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
  return path.join(continuityDir(userData, sessionId), `${providerSafe}-${profileSafe}-checkpoint.md`)
}

function threadPath(userData, sessionId) {
  return path.join(continuityDir(userData, sessionId), 'THREAD.md')
}

function ensureContinuityDir(userData, sessionId) {
  const dir = continuityDir(userData, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeCheckpoint(userData, sessionId, provider, profileId, content) {
  if (!content) return
  try {
    ensureContinuityDir(userData, sessionId)
    fs.writeFileSync(checkpointPath(userData, sessionId, provider, profileId), content, 'utf8')
  } catch {}
}

function readCheckpoint(userData, sessionId, provider, profileId) {
  try {
    return fs.readFileSync(checkpointPath(userData, sessionId, provider, profileId), 'utf8')
  } catch {
    return null
  }
}

function writeThread(userData, sessionId, content) {
  if (!content) return null
  try {
    ensureContinuityDir(userData, sessionId)
    const filePath = threadPath(userData, sessionId)
    fs.writeFileSync(filePath, content, 'utf8')
    return filePath
  } catch {
    return null
  }
}

function readThread(userData, sessionId) {
  try {
    return fs.readFileSync(threadPath(userData, sessionId), 'utf8')
  } catch {
    return null
  }
}

function buildContinuationPacket({ fromLane, toLane, checkpoint, threadPath, deltaSummary, sessionId }) {
  const lines = []
  lines.push(`# Continuation packet`)
  lines.push(``)
  lines.push(`> Session: ${sessionId}`)
  lines.push(`> Switching from ${fromLane} to ${toLane}`)
  lines.push(`> Generated: ${new Date().toISOString()}`)
  lines.push(``)
  if (checkpoint) {
    lines.push(`## Lane checkpoint (${fromLane})`)
    lines.push(``)
    lines.push(checkpoint)
    lines.push(``)
  }
  if (deltaSummary) {
    lines.push(`## Delta since last checkpoint`)
    lines.push(``)
    lines.push(deltaSummary)
    lines.push(``)
  }
  lines.push(`## Instruction`)
  lines.push(``)
  lines.push(`Continue the work described above. The full thread history is available at:`)
  lines.push(``)
  lines.push(`${threadPath}`)
  lines.push(``)
  lines.push(`Read that file if you need more detail about what happened before this continuation.`)
  return lines.join('\n')
}

function continuityEventPayload(fromLane, toLane, threadFilePath, reason) {
  return {
    type: 'agentdock.session.continuity',
    from: fromLane,
    to: toLane,
    threadFile: threadFilePath,
    reason: reason || 'lane_switch',
    ts: Date.now(),
  }
}

function laneLabel(provider, profileId) {
  return `${provider}:${profileId || 'default'}`
}

function buildThreadFromMessages(messages, sessionId) {
  const lines = [`# Thread — session ${sessionId}`, ``, `> Auto-generated continuation thread. Files are the source of truth.`, ``]
  for (const message of messages) {
    if (message.id === 'hello') continue
    const role = message.role === 'user' ? 'User' : (message.provider ? message.provider : 'assistant')
    lines.push(`## ${role}`)
    lines.push(``)
    lines.push(String(message.content || '').slice(0, 8000))
    lines.push(``)
    if (Array.isArray(message.activities) && message.activities.length) {
      const titles = message.activities.filter((a) => a.type !== 'thinking').map((a) => `- [${a.type}] ${a.title}`).slice(0, 20)
      if (titles.length) {
        lines.push(`### Activities`)
        lines.push(titles.join('\n'))
        lines.push(``)
      }
    }
    if (Array.isArray(message.files) && message.files.length) {
      lines.push(`### Files changed`)
      lines.push(message.files.map((f) => `- ${f.path} (+${f.additions}/-${f.deletions})`).join('\n'))
      lines.push(``)
    }
  }
  return lines.join('\n')
}

module.exports = {
  CONTINUITY_VERSION,
  continuityDir,
  checkpointPath,
  threadPath,
  ensureContinuityDir,
  writeCheckpoint,
  readCheckpoint,
  writeThread,
  readThread,
  buildContinuationPacket,
  continuityEventPayload,
  laneLabel,
  buildThreadFromMessages,
}