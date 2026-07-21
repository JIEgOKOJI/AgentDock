const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { globalSkillPrompt, listSkills, parseSkillFile, projectSkillRoots, shareTargetPaths, skillTemplate } = require('../electron/skills.cjs')

test('parses skill metadata and discovers project and global scopes', (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-skills-'))
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const home = path.join(temp, 'home')
  const codexHome = path.join(home, '.codex')
  const repo = path.join(temp, 'repo')
  const nested = path.join(repo, 'packages', 'app')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.agents', 'skills', 'review'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.claude', 'skills', 'review'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.opencode', 'skills', 'deploy'), { recursive: true })
  fs.mkdirSync(path.join(home, '.agents', 'skills', 'release'), { recursive: true })
  fs.mkdirSync(path.join(codexHome, 'skills', 'legacy'), { recursive: true })
  fs.mkdirSync(nested, { recursive: true })
  const review = '---\nname: review\ndescription: >-\n  Review code\n  carefully.\n---\n'
  fs.writeFileSync(path.join(repo, '.agents', 'skills', 'review', 'SKILL.md'), review)
  fs.writeFileSync(path.join(repo, '.claude', 'skills', 'review', 'SKILL.md'), review)
  fs.writeFileSync(path.join(repo, '.opencode', 'skills', 'deploy', 'SKILL.md'), skillTemplate('deploy'))
  fs.writeFileSync(path.join(home, '.agents', 'skills', 'release', 'SKILL.md'), skillTemplate('release'))
  fs.writeFileSync(path.join(codexHome, 'skills', 'legacy', 'SKILL.md'), skillTemplate('legacy'))

  assert.deepEqual(projectSkillRoots(nested), [path.join(nested, '.agents', 'skills'), path.join(repo, 'packages', '.agents', 'skills'), path.join(repo, '.agents', 'skills')])
  assert.equal(parseSkillFile(path.join(repo, '.agents', 'skills', 'review', 'SKILL.md')).description, 'Review code carefully.')
  const skills = listSkills(nested, home, codexHome)
  assert.deepEqual(skills.map(({ name, scope }) => ({ name, scope })), [{ name: 'deploy', scope: 'project' }, { name: 'legacy', scope: 'global' }, { name: 'release', scope: 'global' }, { name: 'review', scope: 'project' }])
  const shared = skills.find((skill) => skill.name === 'review')
  assert.deepEqual(shared.providers, ['codex', 'claude', 'opencode'])
  assert.equal(shared.copies.length, 2)
  assert.equal(shared.synced, true)
  assert.deepEqual(shareTargetPaths(shared, nested, home), [path.join(repo, '.agents', 'skills', 'review'), path.join(repo, '.claude', 'skills', 'review')])
  assert.deepEqual(skills.find((skill) => skill.name === 'deploy').providers, ['opencode'])
})

test('marks same-name copies with different contents as unsynchronized', (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-skills-conflict-'))
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const repo = path.join(temp, 'repo')
  const home = path.join(temp, 'home')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.agents', 'skills', 'review'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.claude', 'skills', 'review'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.agents', 'skills', 'review', 'SKILL.md'), skillTemplate('review'))
  fs.writeFileSync(path.join(repo, '.claude', 'skills', 'review', 'SKILL.md'), `${skillTemplate('review')}\nClaude-only change\n`)

  const skill = listSkills(repo, home).find((item) => item.name === 'review')
  assert.equal(skill.synced, false)
  assert.equal(skill.path, path.join(repo, '.agents', 'skills', 'review', 'SKILL.md'))
})

test('keeps same-name project skills at different directory levels separate', (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-skills-levels-'))
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const repo = path.join(temp, 'repo')
  const nested = path.join(repo, 'packages', 'app')
  const home = path.join(temp, 'home')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.agents', 'skills', 'review'), { recursive: true })
  fs.mkdirSync(path.join(nested, '.agents', 'skills', 'review'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.agents', 'skills', 'review', 'SKILL.md'), skillTemplate('review'))
  fs.writeFileSync(path.join(nested, '.agents', 'skills', 'review', 'SKILL.md'), `${skillTemplate('review')}\nNested workflow\n`)

  const skills = listSkills(nested, home).filter((skill) => skill.name === 'review')
  assert.equal(skills.length, 2)
  assert.equal(skills.every((skill) => skill.synced), true)
})

test('prepends enabled global skills to every CLI prompt', () => {
  const skills = [
    { id: 'global:review', name: 'review', scope: 'global', path: 'C:\\Users\\me\\.agents\\skills\\review\\SKILL.md' },
    { id: 'global:deploy', name: 'deploy', scope: 'global', path: '/home/me/.agents/skills/deploy/SKILL.md' },
    { id: 'project:repo:local', name: 'local', scope: 'project', path: '/repo/.agents/skills/local/SKILL.md' },
  ]
  const prompt = globalSkillPrompt('Fix the bug', skills, ['global:review', 'project:repo:local'])
  assert.match(prompt, /explicitly invoked by the user/)
  assert.match(prompt, /global skills[\s\S]*review/)
  assert.doesNotMatch(prompt, /local\/SKILL\.md/)
  assert.ok(prompt.endsWith('Fix the bug'))
  assert.equal(globalSkillPrompt('No change', skills, []), 'No change')
})
