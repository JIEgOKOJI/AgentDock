const path = require('node:path')
const fs = require('node:fs')

const PROFILE_STORE_VERSION = 1

function getProfilesStorePath(userData) {
  return path.join(userData, 'profiles.json')
}

function providerConfigEnv(provider) {
  if (provider === 'codex') return 'CODEX_HOME'
  if (provider === 'claude') return 'CLAUDE_CONFIG_DIR'
  if (provider === 'opencode') return 'OPENCODE_CONFIG_DIR'
  return null
}

function defaultConfigDir(provider, home) {
  if (provider === 'codex') return path.join(home, '.codex')
  if (provider === 'claude') return path.join(home, '.claude')
  if (provider === 'opencode') return path.join(home, '.config', 'opencode')
  return null
}

function normalizeProfile(value, home) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.provider !== 'string') return null
  const provider = value.provider
  if (!['codex', 'claude', 'opencode'].includes(provider)) return null
  const envVar = providerConfigEnv(provider)
  const fallback = defaultConfigDir(provider, home)
  const configDir = typeof value.configDir === 'string' && value.configDir.trim()
    ? path.resolve(value.configDir)
    : fallback
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 60) : 'Unnamed profile',
    provider,
    configDir,
    envVar,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
  }
}

function readProfiles(userData, home) {
  try {
    const store = JSON.parse(fs.readFileSync(getProfilesStorePath(userData), 'utf8'))
    if (store?.version !== PROFILE_STORE_VERSION || !Array.isArray(store.profiles)) return []
    return store.profiles.map((profile) => normalizeProfile(profile, home)).filter(Boolean)
  } catch {
    return []
  }
}

const DEFAULT_AUTH_MARKERS = {
  codex: ['auth.json', 'config.toml'],
  claude: ['.credentials.json', 'settings.json'],
  opencode: ['opencode.json', 'opencode.jsonc'],
}

function hasAuthMarker(configDir, provider) {
  const markers = DEFAULT_AUTH_MARKERS[provider]
  if (!markers) return false
  try {
    return markers.some((marker) => fs.existsSync(path.join(configDir, marker)))
  } catch {
    return false
  }
}

function detectDefaultProfiles(home) {
  const providers = ['codex', 'claude', 'opencode']
  const detected = []
  for (const provider of providers) {
    const configDir = path.resolve(defaultConfigDir(provider, home))
    if (hasAuthMarker(configDir, provider)) {
      detected.push({
        id: `default-${provider}`,
        name: 'Default account',
        provider,
        configDir,
        envVar: providerConfigEnv(provider),
        enabled: true,
        auto: true,
        createdAt: 0,
        updatedAt: 0,
      })
    }
  }
  return detected
}

function mergeProfiles(stored, detected) {
  const usedConfigDirs = new Set(stored.map((profile) => profile.configDir))
  const usedIds = new Set(stored.map((profile) => profile.id))
  const merged = [...stored]
  for (const profile of detected) {
    if (!usedConfigDirs.has(profile.configDir) && !usedIds.has(profile.id)) merged.push(profile)
  }
  return merged
}

function writeProfiles(userData, profiles) {
  const storePath = getProfilesStorePath(userData)
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  fs.writeFileSync(storePath, JSON.stringify({ version: PROFILE_STORE_VERSION, profiles }, null, 2), 'utf8')
}

function profileEnvOverlay(profile) {
  if (!profile || !profile.envVar) return {}
  return { [profile.envVar]: profile.configDir }
}

function findProfile(profiles, id) {
  if (!id) return null
  return profiles.find((profile) => profile.id === id && profile.enabled) || null
}

function readyProfilesForProvider(profiles, provider) {
  return profiles.filter((profile) => profile.provider === provider && profile.enabled)
}

function isProfileExhausted(limits) {
  if (!limits || !limits.available) return false
  const windows = limits.windows ?? [limits.secondary, limits.primary].filter((item) => item)
  return windows.some((window) => Boolean(window) && window.usedPercent >= 100)
}

// 6.5: Detect typed vendor-limit signal — only recognized quota exhaustion triggers rotation
function isTypedVendorLimitSignal(limits, exitCode) {
  // Non-zero exit code alone is NOT quota exhaustion
  if (!limits || !limits.available) return false
  if (!isProfileExhausted(limits)) return false
  // Only rotate when the vendor reports actual usage limits
  return true
}

// 6.5: Check if profile is ready based on fresh per-profile limits
function isProfileReady(profile, limits) {
  if (!profile || !profile.enabled) return false
  if (!limits) return true // No limits data — assume ready unless policy says otherwise
  if (!limits.available) return false // Unavailable limits = not ready
  if (isProfileExhausted(limits)) return false
  return true
}

// 6.5: Select next profile by fresh per-profile limits, not just enabled status
function nextReadyProfileByLimits(profiles, provider, excludeId, limitsByProfile) {
  const candidates = profiles.filter((profile) => profile.provider === provider && profile.enabled && profile.id !== excludeId)
  for (const candidate of candidates) {
    const limits = limitsByProfile?.[candidate.id]
    if (!limits || isProfileReady(candidate, limits)) return candidate
  }
  return null
}

function nextReadyProfile(profiles, provider, excludeId) {
  return profiles.find((profile) => profile.provider === provider && profile.enabled && profile.id !== excludeId) ?? null
}

module.exports = {
  PROFILE_STORE_VERSION,
  getProfilesStorePath,
  providerConfigEnv,
  defaultConfigDir,
  normalizeProfile,
  readProfiles,
  writeProfiles,
  profileEnvOverlay,
  findProfile,
  readyProfilesForProvider,
  isProfileExhausted,
  isTypedVendorLimitSignal,
  isProfileReady,
  nextReadyProfile,
  nextReadyProfileByLimits,
  detectDefaultProfiles,
  mergeProfiles,
}