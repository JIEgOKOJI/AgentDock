const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agentDock', {
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  getMcpServers: () => ipcRenderer.invoke('mcp:list'),
  getManagedMcpServers: (workspace) => ipcRenderer.invoke('mcp:managed-list', { workspace }),
  upsertManagedMcpServer: (request) => ipcRenderer.invoke('mcp:managed-upsert', request),
  removeManagedMcpServer: (id) => ipcRenderer.invoke('mcp:managed-remove', id),
  toggleManagedMcpServer: (request) => ipcRenderer.invoke('mcp:managed-toggle', request),
  importManagedMcpServers: (workspace) => ipcRenderer.invoke('mcp:managed-import', { workspace }),
  syncManagedMcpServers: (request) => ipcRenderer.invoke('mcp:managed-sync', request),
  checkManagedMcpServer: (serverInput) => ipcRenderer.invoke('mcp:managed-check', serverInput),
  exportManagedMcpServers: (ids) => ipcRenderer.invoke('mcp:managed-export', { ids }),
  importMcpPayload: (request) => ipcRenderer.invoke('mcp:managed-import-payload', request),
  exportMcpToFile: (ids) => ipcRenderer.invoke('mcp:managed-export-save', { ids }),
  getMcpConflicts: (workspace) => ipcRenderer.invoke('mcp:managed-conflicts', { workspace }),
  listSkills: (workspace) => ipcRenderer.invoke('skills:list', workspace),
  getDefaultGlobalSkills: () => ipcRenderer.invoke('skills:defaults'),
  setDefaultGlobalSkill: (request) => ipcRenderer.invoke('skills:set-default', request),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  patchSettings: (request) => ipcRenderer.invoke('settings:patch', request),
  createSkill: (request) => ipcRenderer.invoke('skills:create', request),
  openSkill: (request) => ipcRenderer.invoke('skills:open', request),
  shareSkill: (request) => ipcRenderer.invoke('skills:share', request),
  getProviderLimits: (provider, profileId) => ipcRenderer.invoke('provider:limits', { provider, profileId }),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  upsertProfile: (request) => ipcRenderer.invoke('profiles:upsert', request),
  removeProfile: (id) => ipcRenderer.invoke('profiles:remove', id),
  toggleProfile: (request) => ipcRenderer.invoke('profiles:toggle', request),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getLaneState: (sessionId, provider, profileId) => ipcRenderer.invoke('lanes:state', { sessionId, provider, profileId }),
  listRuns: (sessionId) => ipcRenderer.invoke('runs:list', sessionId),
  readRunArtifact: (runId, artifactPath) => ipcRenderer.invoke('runs:read-artifact', { runId, path: artifactPath }),
  prepareContinuity: (request) => ipcRenderer.invoke('continuity:prepare', request),
  saveCheckpoint: (request) => ipcRenderer.invoke('continuity:checkpoint', request),
  createSession: (request) => ipcRenderer.invoke('sessions:create', request),
  updateSession: (request) => ipcRenderer.invoke('sessions:update', request),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  chooseAttachments: () => ipcRenderer.invoke('attachments:choose'),
  chooseWorkspaceAttachments: (workspace) => ipcRenderer.invoke('attachments:choose-workspace', workspace),
  readGitInfo: (workspace) => ipcRenderer.invoke('git:info', workspace),
  checkoutBranch: (workspace, branch) => ipcRenderer.invoke('git:checkout', { workspace, branch }),
  createBranch: (workspace, branch) => ipcRenderer.invoke('git:create-branch', { workspace, branch }),
  configureProvider: (provider) => ipcRenderer.invoke('provider:configure', provider),
  runAgent: (request) => ipcRenderer.invoke('agent:run', request),
  stopAgent: (runId) => ipcRenderer.invoke('agent:stop', runId),
  browser: {
    getState: () => ipcRenderer.invoke('browser:get-state'),
    open: (url) => ipcRenderer.invoke('browser:open', url),
    show: () => ipcRenderer.invoke('browser:show'),
    hide: () => ipcRenderer.invoke('browser:hide'),
    navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
    back: () => ipcRenderer.invoke('browser:back'),
    forward: () => ipcRenderer.invoke('browser:forward'),
    reload: () => ipcRenderer.invoke('browser:reload'),
    stop: () => ipcRenderer.invoke('browser:stop'),
    setBounds: (bounds) => ipcRenderer.invoke('browser:set-bounds', bounds),
    openExternal: () => ipcRenderer.invoke('browser:open-external'),
    cancelAgentAction: () => ipcRenderer.invoke('browser:cancel-agent-action'),
    onState: (listener) => {
      const wrapped = (_event, state) => listener(state)
      ipcRenderer.on('browser:state', wrapped)
      return () => ipcRenderer.removeListener('browser:state', wrapped)
    },
    onAction: (listener) => {
      const wrapped = (_event, action) => listener(action)
      ipcRenderer.on('browser:action', wrapped)
      return () => ipcRenderer.removeListener('browser:action', wrapped)
    },
    onRequestBounds: (listener) => {
      const wrapped = () => listener()
      ipcRenderer.on('browser:request-bounds', wrapped)
      return () => ipcRenderer.removeListener('browser:request-bounds', wrapped)
    },
  },
  onAgentEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload)
    ipcRenderer.on('agent:event', wrapped)
    return () => ipcRenderer.removeListener('agent:event', wrapped)
  },
})
