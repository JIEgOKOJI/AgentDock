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
  onAgentEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload)
    ipcRenderer.on('agent:event', wrapped)
    return () => ipcRenderer.removeListener('agent:event', wrapped)
  },
})
