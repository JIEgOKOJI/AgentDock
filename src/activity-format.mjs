const clean = (value) => String(value || '').trim()

const unquote = (value) => {
  const text = clean(value)
  if (text.length > 1 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) return text.slice(1, -1)
  return text
}

const short = (value, limit = 62) => {
  const text = unquote(value).replace(/\\(["'])/g, '$1').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

const fileName = (value) => {
  const path = unquote(value).replace(/[),;]+$/, '')
  return path.split(/[\\/]/).filter(Boolean).at(-1) || short(path)
}

function shellPayload(value) {
  let command = clean(value)
  const powerShell = command.match(/(?:^|\s)-(?:command|c)\s+([\s\S]+)$/i)
  if (powerShell && /(?:powershell|pwsh)(?:\.exe)?["']?\s/i.test(command.slice(0, powerShell.index + 1))) command = unquote(powerShell[1])
  const posix = command.match(/(?:^|[\\/\s])(?:bash|zsh|sh)(?:\.exe)?["']?\s+(?:-[a-z]*c)\s+([\s\S]+)$/i)
  if (posix) command = unquote(posix[1])
  return command.trim()
}

function argumentAfter(command, executable) {
  const tail = command.replace(executable, '').trim()
  const tokens = tail.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g) || []
  const optionsWithValues = new Set(['-a', '-b', '-c', '-g', '--glob', '-t', '--type', '-m', '--max-count', '--encoding', '-filter', '-include', '-exclude', '-path', '-literalpath'])
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (optionsWithValues.has(token.toLowerCase())) { index += 1; continue }
    if (!token.startsWith('-')) return unquote(token)
  }
  return ''
}

export function describeCommand(value) {
  const original = clean(value)
  const command = shellPayload(original)
  const lower = command.toLowerCase()

  if (/\*\*\*\s*begin patch|\bapply_patch\b|\bgit\s+apply\b/i.test(command)) return { kind: 'edit', label: 'Editing files', target: '' }

  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b/i.test(command)) return { kind: 'test', label: 'Running tests', target: '' }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:vite|tsc|cargo|go|dotnet|mvn|gradle)\s+build\b/i.test(command)) return { kind: 'build', label: 'Building project', target: '' }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add)\b|\b(?:pip|pip3)\s+install\b|\b(?:brew|apt|apt-get|winget|choco)\s+install\b/i.test(command)) return { kind: 'install', label: 'Installing dependencies', target: '' }

  const git = command.match(/\bgit\s+(status|diff|log|show|branch|checkout|switch|add|commit|push|pull|fetch|merge)\b/i)
  if (git) {
    const labels = { status: 'Checking Git status', diff: 'Reviewing Git changes', log: 'Reading Git history', show: 'Inspecting Git revision', branch: 'Listing Git branches', checkout: 'Switching Git branch', switch: 'Switching Git branch', add: 'Staging changes', commit: 'Creating commit', push: 'Pushing changes', pull: 'Pulling changes', fetch: 'Fetching changes', merge: 'Merging changes' }
    return { kind: 'git', label: labels[git[1].toLowerCase()] || 'Using Git', target: '' }
  }

  if (/\b(?:rg|ripgrep)\s+--files\b|\bget-childitem\b|\bfind\s+\.?.*\s-type\s+f\b|(?:^|[;&|]\s*)(?:ls|dir)(?:\s|$)/i.test(command)) return { kind: 'list', label: 'Listing files', target: '' }

  const searchExecutable = command.match(/(?:^|[;&|]\s*)(rg|ripgrep|grep|findstr|select-string)\b/i)
  if (searchExecutable) {
    const query = argumentAfter(command.slice(searchExecutable.index), new RegExp(`^[\\s;&|]*(?:${searchExecutable[1]})\\b`, 'i'))
    return { kind: 'search', label: 'Searching project', target: query ? `“${short(query, 44)}”` : '' }
  }

  const readExecutable = command.match(/(?:^|[;&|]\s*)(get-content|cat|type|head|tail)\b/i)
  if (readExecutable) {
    const target = argumentAfter(command.slice(readExecutable.index), new RegExp(`^[\\s;&|]*(?:${readExecutable[1]})\\b`, 'i'))
    return { kind: 'read', label: 'Reading file', target: target ? fileName(target) : '' }
  }

  const create = command.match(/\b(?:new-item|mkdir|md)\b[^\r\n]*?(["'][^"']+["']|[^\s]+)?$/i)
  if (create) return { kind: 'edit', label: 'Creating folder', target: create[1] ? fileName(create[1]) : '' }
  if (/\b(?:remove-item|rm|del|rmdir)\b/i.test(command)) return { kind: 'delete', label: 'Deleting files', target: '' }
  if (/\b(?:copy-item|cp)\b/i.test(command)) return { kind: 'edit', label: 'Copying files', target: '' }
  if (/\b(?:move-item|mv)\b/i.test(command)) return { kind: 'edit', label: 'Moving files', target: '' }
  if (/\b(?:curl|wget|invoke-webrequest)\b/i.test(command)) return { kind: 'network', label: 'Fetching from the web', target: '' }

  const executable = command.match(/^(?:["']?[^\s"']+["']?\s+)*(?:&\s+)?([\w.-]+)(?:\s|$)/)?.[1]
  return { kind: 'command', label: 'Running command', target: executable ? short(executable, 32) : '' }
}

export function describeActivity(activity) {
  if (activity.type === 'files') {
    const files = activity.files || []
    return { kind: 'edit', label: files.length === 1 ? 'Edited file' : `Edited ${files.length} files`, target: files.length === 1 ? fileName(files[0].path) : '' }
  }
  if (activity.type === 'command') return describeCommand(activity.detail || activity.title)

  const name = clean(activity.title).toLowerCase()
  const target = (() => {
    try {
      const input = JSON.parse(activity.detail || '{}')
      return input.path || input.file_path || input.filePath || input.pattern || input.query || ''
    } catch { return '' }
  })()
  if (/^(read|view|open)$/.test(name)) return { kind: 'read', label: 'Reading file', target: target ? fileName(target) : '' }
  if (/^(grep|search|select-string)$/.test(name)) return { kind: 'search', label: 'Searching project', target: target ? `“${short(target, 44)}”` : '' }
  if (/^(glob|list|find)$/.test(name)) return { kind: 'list', label: 'Listing files', target: target ? short(target, 44) : '' }
  if (/^(webfetch|websearch|fetch)$/.test(name)) return { kind: 'network', label: 'Using the web', target: '' }
  return { kind: 'tool', label: 'Using tool', target: short(activity.title, 44) }
}
