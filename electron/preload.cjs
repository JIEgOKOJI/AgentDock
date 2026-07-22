const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agentDock', {
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  getMcpServers: () => ipcRenderer.invoke('mcp:list'),
  listSkills: (workspace) => ipcRenderer.invoke('skills:list', workspace),
  getDefaultGlobalSkills: () => ipcRenderer.invoke('skills:defaults'),
  setDefaultGlobalSkill: (request) => ipcRenderer.invoke('skills:set-default', request),
  createSkill: (request) => ipcRenderer.invoke('skills:create', request),
  openSkill: (request) => ipcRenderer.invoke('skills:open', request),
  shareSkill: (request) => ipcRenderer.invoke('skills:share', request),
  getProviderLimits: (provider) => ipcRenderer.invoke('provider:limits', provider),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
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
