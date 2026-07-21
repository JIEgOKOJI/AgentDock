const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const providerOrder = ['codex', 'claude', 'opencode']
const sourcePreference = { agents: 0, claude: 1, opencode: 2, codex: 3 }

function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) } catch {}
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'")
  return trimmed
}

function frontmatterField(frontmatter, name) {
  const lines = frontmatter.split(/\r?\n/)
  const index = lines.findIndex((line) => new RegExp(`^${name}\\s*:`).test(line))
  if (index < 0) return ''
  const value = lines[index].replace(new RegExp(`^${name}\\s*:\\s*`), '')
  if (!/^[>|][-+]?\s*$/.test(value)) return unquote(value)
  const chunks = []
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const match = lines[cursor].match(/^\s+(.*)$/)
    if (!match) break
    chunks.push(match[1].trim())
  }
  return chunks.join(value.startsWith('|') ? '\n' : ' ').trim()
}

function parseSkillFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8')
  const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || ''
  const directoryName = path.basename(path.dirname(filePath))
  return {
    name: frontmatterField(frontmatter, 'name') || directoryName,
    description: frontmatterField(frontmatter, 'description') || 'No description provided.',
  }
}

function findRepositoryRoot(workspace) {
  let current = path.resolve(workspace)
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(workspace)
    current = parent
  }
}

function projectSkillRoots(workspace) {
  const start = path.resolve(workspace)
  const root = findRepositoryRoot(start)
  const roots = []
  let current = start
  while (true) {
    roots.push(path.join(current, '.agents', 'skills'))
    if (current === root) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots
}

function hashSkillDirectory(directory) {
  const hash = crypto.createHash('sha256')
  const visit = (current, relative = '') => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      const childRelative = path.join(relative, entry.name).replace(/\\/g, '/')
      hash.update(`${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}:${childRelative}\0`)
      if (entry.isDirectory()) visit(absolute, childRelative)
      else if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(absolute))
      else hash.update(fs.readFileSync(absolute))
    }
  }
  visit(directory)
  return hash.digest('hex')
}

function readSkillRoot(root, scope, providers, sourceType) {
  if (!fs.existsSync(root)) return []
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) return []
    const skillPath = path.join(root, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillPath)) return []
    try {
      const metadata = parseSkillFile(skillPath)
      return [{ ...metadata, scope, path: skillPath, root, providers, sourceType, hash: hashSkillDirectory(path.dirname(skillPath)), modifiedAt: fs.statSync(skillPath).mtimeMs }]
    } catch {
      return []
    }
  })
}

function projectConfigurationRoots(workspace) {
  const bases = projectSkillRoots(workspace).map((root) => path.dirname(path.dirname(root)))
  return bases.flatMap((base) => [
    { root: path.join(base, '.agents', 'skills'), providers: ['codex', 'opencode'], sourceType: 'agents' },
    { root: path.join(base, '.claude', 'skills'), providers: ['claude', 'opencode'], sourceType: 'claude' },
    { root: path.join(base, '.opencode', 'skills'), providers: ['opencode'], sourceType: 'opencode' },
  ])
}

function skillCopies(workspace, home, codexHome = path.join(home, '.codex')) {
  const roots = [
    ...projectConfigurationRoots(workspace).map((entry) => ({ ...entry, scope: 'project' })),
    { root: path.join(home, '.agents', 'skills'), providers: ['codex', 'opencode'], sourceType: 'agents', scope: 'global' },
    { root: path.join(home, '.claude', 'skills'), providers: ['claude', 'opencode'], sourceType: 'claude', scope: 'global' },
    { root: path.join(home, '.config', 'opencode', 'skills'), providers: ['opencode'], sourceType: 'opencode', scope: 'global' },
    { root: path.join(codexHome, 'skills'), providers: ['codex'], sourceType: 'codex', scope: 'global' },
  ]
  const seen = new Set()
  return roots.flatMap((entry) => {
    const resolved = path.resolve(entry.root)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) return []
    seen.add(key)
    return readSkillRoot(resolved, entry.scope, entry.providers, entry.sourceType)
  })
}

function listSkills(workspace, home, codexHome = path.join(home, '.codex')) {
  const groups = new Map()
  for (const copy of skillCopies(workspace, home, codexHome)) {
    const projectBase = copy.scope === 'project' ? path.resolve(path.dirname(path.dirname(copy.root))) : ''
    const key = copy.scope === 'project' ? `project:${projectBase}:${copy.name}` : `global:${copy.name}`
    const group = groups.get(key) || []
    group.push(copy)
    groups.set(key, group)
  }
  return [...groups.entries()].map(([id, copies]) => {
    copies.sort((left, right) => sourcePreference[left.sourceType] - sourcePreference[right.sourceType] || left.path.localeCompare(right.path))
    const source = copies[0]
    return {
      id,
      name: source.name,
      description: source.description,
      scope: source.scope,
      path: source.path,
      root: source.root,
      providers: providerOrder.filter((provider) => copies.some((copy) => copy.providers.includes(provider))),
      copies: copies.map(({ path: copyPath, root, sourceType, hash, providers }) => ({ path: copyPath, root, sourceType, hash, providers })),
      synced: new Set(copies.map((copy) => copy.hash)).size <= 1,
      modifiedAt: Math.max(...copies.map((copy) => copy.modifiedAt)),
    }
  }).sort((left, right) => left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope))
}

function skillRoot(scope, workspace, home) {
  if (scope === 'global') return path.join(home, '.agents', 'skills')
  if (scope === 'project') return path.join(path.resolve(workspace), '.agents', 'skills')
  throw new Error(`Unknown skill scope: ${scope}`)
}

function isInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function skillTemplate(name) {
  return `---\nname: ${name}\ndescription: Describe what this skill does and when Codex should use it.\n---\n\n# ${name}\n\nAdd the workflow instructions here.\n`
}

function shareTargetPaths(skill, workspace, home) {
  const source = skill.copies.find((copy) => path.resolve(copy.path) === path.resolve(skill.path)) || skill.copies[0]
  const base = skill.scope === 'global' ? home : path.dirname(path.dirname(source.root))
  const canonical = [path.join(base, '.agents', 'skills', skill.name), path.join(base, '.claude', 'skills', skill.name)]
  const existing = skill.copies.map((copy) => path.dirname(copy.path))
  return [...new Set([...canonical, ...existing].map((target) => path.resolve(target)))]
}

function globalSkillPrompt(prompt, skills, enabledIds) {
  const enabled = new Set(Array.isArray(enabledIds) ? enabledIds : [])
  const selected = skills.filter((skill) => skill.scope === 'global' && enabled.has(skill.id))
  if (!selected.length) return prompt
  const entries = selected.map((skill) => `- ${skill.name}: ${JSON.stringify(skill.path)}`).join('\n')
  return `<agentdock_global_skills>\nThe user enabled the following global skills for every CLI. Before handling the user request, read every listed SKILL.md completely and follow its instructions for this turn. Treat these skills as explicitly invoked by the user.\n${entries}\n</agentdock_global_skills>\n\n${prompt}`
}

module.exports = { findRepositoryRoot, globalSkillPrompt, hashSkillDirectory, isInside, listSkills, parseSkillFile, projectSkillRoots, shareTargetPaths, skillCopies, skillRoot, skillTemplate }
