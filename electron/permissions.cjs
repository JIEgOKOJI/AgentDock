const PERMISSION_MODES = new Set(['ask', 'auto', 'full'])

function normalizePermissionMode(value) {
  return PERMISSION_MODES.has(value) ? value : 'auto'
}

function mergeOpenCodeConfig(baseValue, permission) {
  let config = {}
  if (baseValue) {
    try {
      const parsed = JSON.parse(baseValue)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed
    } catch {}
  }
  return JSON.stringify({ ...config, permission })
}

function permissionLaunchOptions(provider, requestedMode, baseEnv = process.env) {
  const mode = normalizePermissionMode(requestedMode)
  if (provider === 'codex') {
    if (mode === 'full') return { mode, args: ['--dangerously-bypass-approvals-and-sandbox'], env: baseEnv }
    return {
      mode,
      args: ['--sandbox', 'workspace-write', '-c', `approval_policy="${mode === 'ask' ? 'untrusted' : 'on-request'}"`],
      env: baseEnv,
    }
  }

  if (provider === 'claude') {
    return {
      mode,
      args: mode === 'full' ? ['--dangerously-skip-permissions'] : ['--permission-mode', mode === 'ask' ? 'manual' : 'auto'],
      env: baseEnv,
    }
  }

  if (provider === 'opencode') {
    const permission = mode === 'ask'
      ? { edit: 'ask', bash: 'ask', webfetch: 'ask', websearch: 'ask', external_directory: 'ask' }
      : mode === 'full'
        ? 'allow'
        : { '*': 'allow', external_directory: 'ask', doom_loop: 'ask' }
    return {
      mode,
      args: mode === 'full' ? ['--dangerously-skip-permissions'] : [],
      env: { ...baseEnv, OPENCODE_CONFIG_CONTENT: mergeOpenCodeConfig(baseEnv.OPENCODE_CONFIG_CONTENT, permission) },
    }
  }

  return { mode, args: [], env: baseEnv }
}

function readOnlyPermissionOptions(provider, baseEnv = process.env) {
  if (provider === 'codex') {
    return { mode: 'ask', args: ['--sandbox', 'read-only', '-c', 'approval_policy="untrusted"'], env: baseEnv }
  }
  if (provider === 'claude') {
    return { mode: 'ask', args: ['--permission-mode', 'manual'], env: baseEnv }
  }
  if (provider === 'opencode') {
    const permission = { edit: 'ask', bash: 'ask', webfetch: 'ask', websearch: 'ask', external_directory: 'ask' }
    return { mode: 'ask', args: [], env: { ...baseEnv, OPENCODE_CONFIG_CONTENT: mergeOpenCodeConfig(baseEnv.OPENCODE_CONFIG_CONTENT, permission) } }
  }
  return { mode: 'ask', args: [], env: baseEnv }
}

function isReadOnlyIntent(intent) {
  return intent === 'ask' || intent === 'plan'
}

function effectivePermissionOptions(provider, intent, requestedMode, baseEnv = process.env) {
  if (isReadOnlyIntent(intent)) return readOnlyPermissionOptions(provider, baseEnv)
  return permissionLaunchOptions(provider, requestedMode, baseEnv)
}

module.exports = { normalizePermissionMode, permissionLaunchOptions, readOnlyPermissionOptions, isReadOnlyIntent, effectivePermissionOptions }
