const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readProfiles, writeProfiles, normalizeProfile, profileEnvOverlay, findProfile, readyProfilesForProvider, providerConfigEnv, defaultConfigDir, detectDefaultProfiles, mergeProfiles } = require('../electron/profiles.cjs')

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-profiles-'))
  return { dir, home: dir }
}

test('providerConfigEnv maps providers to their config-dir env vars', () => {
  assert.equal(providerConfigEnv('codex'), 'CODEX_HOME')
  assert.equal(providerConfigEnv('claude'), 'CLAUDE_CONFIG_DIR')
  assert.equal(providerConfigEnv('opencode'), 'OPENCODE_CONFIG_DIR')
  assert.equal(providerConfigEnv('unknown'), null)
})

test('defaultConfigDir resolves under the provided home directory', () => {
  const home = '/home/user'
  assert.equal(defaultConfigDir('codex', home), path.join(home, '.codex'))
  assert.equal(defaultConfigDir('claude', home), path.join(home, '.claude'))
  assert.equal(defaultConfigDir('opencode', home), path.join(home, '.config', 'opencode'))
})

test('normalizeProfile rejects invalid providers and missing ids', () => {
  const home = '/home/user'
  assert.equal(normalizeProfile({ id: 'p1', provider: 'unknown' }, home), null)
  assert.equal(normalizeProfile({ provider: 'codex' }, home), null)
})

test('normalizeProfile falls back to the default config dir when none is set', () => {
  const profile = normalizeProfile({ id: 'p1', provider: 'claude' }, '/home/user')
  assert.equal(profile.configDir, path.join('/home/user', '.claude'))
  assert.equal(profile.envVar, 'CLAUDE_CONFIG_DIR')
  assert.equal(profile.enabled, true)
})

test('writeProfiles then readProfiles round-trips profile definitions', () => {
  const { dir, home } = tempStore()
  try {
    const profile = normalizeProfile({ id: 'p1', name: 'Work', provider: 'claude', configDir: path.join(home, '.claude-work'), enabled: true }, home)
    writeProfiles(dir, [profile])
    const read = readProfiles(dir, home)
    assert.equal(read.length, 1)
    assert.equal(read[0].id, 'p1')
    assert.equal(read[0].name, 'Work')
    assert.equal(read[0].provider, 'claude')
    assert.equal(read[0].configDir, path.join(home, '.claude-work'))
    assert.equal(read[0].enabled, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('readProfiles returns an empty array when the store does not exist', () => {
  const { dir, home } = tempStore()
  try {
    assert.deepEqual(readProfiles(dir, home), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('profileEnvOverlay emits only the provider config-dir env var', () => {
  const profile = normalizeProfile({ id: 'p1', provider: 'codex', configDir: path.join(os.tmpdir(), 'codex-home') }, '/home/user')
  assert.deepEqual(profileEnvOverlay(profile), { CODEX_HOME: profile.configDir })
  assert.deepEqual(profileEnvOverlay(null), {})
})

test('findProfile returns enabled profiles by id and ignores disabled ones', () => {
  const home = '/home/user'
  const profiles = [
    normalizeProfile({ id: 'p1', provider: 'claude', enabled: true }, home),
    normalizeProfile({ id: 'p2', provider: 'claude', enabled: false }, home),
  ]
  assert.equal(findProfile(profiles, 'p1').id, 'p1')
  assert.equal(findProfile(profiles, 'p2'), null)
  assert.equal(findProfile(profiles, 'missing'), null)
  assert.equal(findProfile(profiles, null), null)
})

test('readyProfilesForProvider filters by provider and enabled flag', () => {
  const home = '/home/user'
  const profiles = [
    normalizeProfile({ id: 'p1', provider: 'claude', enabled: true }, home),
    normalizeProfile({ id: 'p2', provider: 'claude', enabled: false }, home),
    normalizeProfile({ id: 'p3', provider: 'codex', enabled: true }, home),
  ]
  const ready = readyProfilesForProvider(profiles, 'claude')
  assert.equal(ready.length, 1)
  assert.equal(ready[0].id, 'p1')
})

const { isProfileExhausted, nextReadyProfile } = require('../electron/profiles.cjs')

test('isProfileExhausted returns true when any usage window is at 100%', () => {
  assert.equal(isProfileExhausted({ available: true, primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null }, secondary: null }), true)
  assert.equal(isProfileExhausted({ available: true, windows: [{ usedPercent: 100, windowDurationMins: 300, resetsAt: null }] }), true)
})

test('isProfileExhausted returns false when limits are unavailable or under 100%', () => {
  assert.equal(isProfileExhausted(null), false)
  assert.equal(isProfileExhausted({ available: false, primary: null, secondary: null }), false)
  assert.equal(isProfileExhausted({ available: true, primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: null }, secondary: null }), false)
})

test('nextReadyProfile returns the first enabled profile of the same provider excluding the given id', () => {
  const home = '/home/user'
  const profiles = [
    normalizeProfile({ id: 'p1', provider: 'claude', enabled: true }, home),
    normalizeProfile({ id: 'p2', provider: 'claude', enabled: true }, home),
    normalizeProfile({ id: 'p3', provider: 'claude', enabled: false }, home),
  ]
  assert.equal(nextReadyProfile(profiles, 'claude', 'p1').id, 'p2')
  assert.equal(nextReadyProfile(profiles, 'claude', 'p2').id, 'p1')
  assert.equal(nextReadyProfile(profiles, 'claude', 'p3').id, 'p1')
  assert.equal(nextReadyProfile([], 'claude', 'p1'), null)
})

test('detectDefaultProfiles discovers provider config dirs that contain auth markers', () => {
  const { dir, home } = tempStore()
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}')
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}')
    const detected = detectDefaultProfiles(home)
    assert.equal(detected.length, 2)
    const claude = detected.find((profile) => profile.provider === 'claude')
    assert.equal(claude.id, 'default-claude')
    assert.equal(claude.auto, true)
    assert.equal(claude.configDir, path.join(home, '.claude'))
    const codex = detected.find((profile) => profile.provider === 'codex')
    assert.equal(codex.id, 'default-codex')
    assert.equal(codex.auto, true)
    assert.equal(detectDefaultProfiles(home).find((profile) => profile.provider === 'opencode'), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeProfiles appends detected defaults that are not already stored', () => {
  const home = '/home/user'
  const stored = [normalizeProfile({ id: 'p1', name: 'Work', provider: 'claude', configDir: path.join(home, '.claude-work'), enabled: true }, home)]
  const detected = [
    { id: 'default-claude', name: 'Default account', provider: 'claude', configDir: path.join(home, '.claude'), envVar: 'CLAUDE_CONFIG_DIR', enabled: true, auto: true, createdAt: 0, updatedAt: 0 },
    { id: 'default-codex', name: 'Default account', provider: 'codex', configDir: path.join(home, '.codex'), envVar: 'CODEX_HOME', enabled: true, auto: true, createdAt: 0, updatedAt: 0 },
  ]
  const merged = mergeProfiles(stored, detected)
  assert.equal(merged.length, 3)
  assert.equal(merged.find((profile) => profile.id === 'p1').name, 'Work')
  assert.equal(merged.find((profile) => profile.id === 'default-claude').auto, true)
  assert.equal(merged.find((profile) => profile.id === 'default-codex').auto, true)
})

test('mergeProfiles does not duplicate a detected default when the config dir is already stored', () => {
  const home = '/home/user'
  const stored = [normalizeProfile({ id: 'p1', name: 'Default account', provider: 'claude', configDir: path.join(home, '.claude'), enabled: true }, home)]
  const detected = [
    { id: 'default-claude', name: 'Default account', provider: 'claude', configDir: path.resolve(path.join(home, '.claude')), envVar: 'CLAUDE_CONFIG_DIR', enabled: true, auto: true, createdAt: 0, updatedAt: 0 },
  ]
  const merged = mergeProfiles(stored, detected)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'p1')
})