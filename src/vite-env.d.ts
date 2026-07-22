/// <reference types="vite/client" />

type ProviderId = 'codex' | 'claude' | 'opencode'
type PermissionMode = 'ask' | 'auto' | 'full'

interface ModelOption {
  id: string
  label: string
  description?: string
  contextWindow?: number
  reasoning: string[]
  defaultReasoning: string
}

interface TokenUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  contextTokens: number
  contextWindow: number | null
}

interface RateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
  label?: string
  resetText?: string
}

interface ProviderLimits {
  available: boolean
  planType: string | null
  limitName: string | null
  primary: RateLimitWindow | null
  secondary: RateLimitWindow | null
  windows?: RateLimitWindow[]
  error?: string
}

interface ProviderRuntime {
  installed: boolean
  path: string | null
  version: string | null
  models: ModelOption[]
  agents: string[]
}

interface McpServerInfo {
  name: string
  providers: ProviderId[]
  enabled: boolean
  detail: string
}

type McpTransport = 'stdio' | 'sse' | 'http'

interface ManagedMcpServer {
  id: string
  name: string
  description: string
  transport: McpTransport
  command: string
  args: string[]
  url: string
  env: Record<string, string>
  headers: Record<string, string>
  cwd: string
  providers: ProviderId[]
  scope: 'global' | 'workspace'
  workspace: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

interface McpSyncResult {
  results: Array<{ provider: ProviderId; path: string; backup: string | null; count: number }>
  backupDir: string
}

interface McpImportResult {
  added: number
  merged: number
  imported: ManagedMcpServer[]
}

interface McpHealthResult {
  ok: boolean
  detail: string
  statusCode?: number
}

interface McpConflict {
  name: string
  managed: { command: string; url: string; transport: McpTransport } | null
  cli: { command: string; url: string; transport: McpTransport; providers: ProviderId[] }
}

interface SkillInfo {
  id: string
  name: string
  description: string
  scope: 'global' | 'project'
  path: string
  root: string
  providers: ProviderId[]
  copies: Array<{
    path: string
    root: string
    sourceType: 'agents' | 'claude' | 'opencode' | 'codex'
    hash: string
    providers: ProviderId[]
  }>
  synced: boolean
  modifiedAt: number
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  provider?: ProviderId
  pending?: boolean
  activities?: AgentActivity[]
  files?: FileChangeSummary[]
}

interface FileChangeSummary { path: string; additions: number; deletions: number; diff?: string }
interface AgentActivity {
  id: string
  type: 'thinking' | 'command' | 'files' | 'tool'
  title: string
  detail?: string
  output?: string
  status?: string
  files?: FileChangeSummary[]
}

interface GitInfo {
  isRepo: boolean
  currentBranch: string
  branches: string[]
}

interface ChatSession {
  id: string
  title: string
  workspace: string
  provider: ProviderId
  model: string
  reasoning: string
  agent: string
  permissionMode: PermissionMode
  profileId?: string
  messages: ChatMessage[]
  attachments?: string[]
  git?: GitInfo
  usage?: TokenUsage
  cliSessionId?: string
  lastPrompt?: string
  lastExitCode?: number | null
  lastRunFailed?: boolean
  createdAt: number
  updatedAt: number
}

interface AgentEvent {
  runId: string
  type: 'stdout' | 'stderr' | 'error' | 'exit'
  data: string
}

interface CredentialProfile {
  id: string
  name: string
  provider: ProviderId
  configDir: string
  envVar: string
  enabled: boolean
  auto?: boolean
  createdAt: number
  updatedAt: number
}

interface BrowserTabState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  visible: boolean
  revision: number
  lastError?: string
}

interface BrowserActionState {
  actor: 'user' | 'agent'
  tool?: string
  status: 'started' | 'completed' | 'failed'
  startedAt: number
  summary: string
}

interface BrowserRect { x: number; y: number; width: number; height: number }

interface BrowserApi {
  getState(): Promise<BrowserTabState | null>
  open(url?: string): Promise<BrowserTabState>
  show(): Promise<void>
  hide(): Promise<void>
  navigate(url: string): Promise<BrowserTabState>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  stop(): Promise<void>
  setBounds(bounds: BrowserRect): Promise<void>
  openExternal(): Promise<void>
  cancelAgentAction(): Promise<boolean>
  onState(listener: (state: BrowserTabState) => void): () => void
  onAction(listener: (action: BrowserActionState) => void): () => void
  onRequestBounds(listener: () => void): () => void
}

interface AppSettings {
  defaultGlobalSkills: string[]
  contextHandoff: boolean
  limitAction: 'fail' | 'ask' | 'rotate'
}

interface Window {
  agentDock?: {
    getSystemInfo(): Promise<{
      platform: string
      home: string
      cwd: string
      providers: Record<ProviderId, ProviderRuntime>
    }>
    getMcpServers(): Promise<McpServerInfo[]>
    getManagedMcpServers(workspace?: string): Promise<ManagedMcpServer[]>
    upsertManagedMcpServer(request: Partial<ManagedMcpServer> & { name: string }): Promise<ManagedMcpServer>
    removeManagedMcpServer(id: string): Promise<boolean>
    toggleManagedMcpServer(request: { id: string; enabled: boolean }): Promise<ManagedMcpServer | null>
    importManagedMcpServers(workspace?: string): Promise<McpImportResult>
    syncManagedMcpServers(request: { providers?: ProviderId[]; workspace?: string }): Promise<McpSyncResult>
    checkManagedMcpServer(serverInput: Partial<ManagedMcpServer>): Promise<McpHealthResult>
    exportManagedMcpServers(ids?: string[]): Promise<{ version: number; exportedAt: number; servers: ManagedMcpServer[] }>
    importMcpPayload(request: { payload?: { servers: ManagedMcpServer[] }; path?: string }): Promise<{ added: number; merged: number }>
    exportMcpToFile(ids?: string[]): Promise<{ canceled: boolean; path?: string }>
    getMcpConflicts(workspace?: string): Promise<McpConflict[]>
    listSkills(workspace: string): Promise<SkillInfo[]>
    getDefaultGlobalSkills(): Promise<string[]>
    setDefaultGlobalSkill(request: { workspace: string; id: string; enabled: boolean }): Promise<string[]>
    getSettings(): Promise<AppSettings>
    patchSettings(request: Partial<AppSettings>): Promise<AppSettings>
    createSkill(request: { workspace: string; scope: SkillInfo['scope'] }): Promise<string | null>
    openSkill(request: { workspace: string; path: string }): Promise<boolean>
    shareSkill(request: { workspace: string; id: string; path: string }): Promise<{ canceled: boolean; updated: number; backups: string[] }>
    getProviderLimits(provider: ProviderId, profileId?: string): Promise<ProviderLimits>
    listProfiles(): Promise<CredentialProfile[]>
    upsertProfile(request: { id: string; name?: string; provider: ProviderId; configDir?: string; enabled?: boolean }): Promise<CredentialProfile>
    removeProfile(id: string): Promise<boolean>
    toggleProfile(request: { id: string; enabled: boolean }): Promise<CredentialProfile | null>
    listSessions(): Promise<ChatSession[]>
    createSession(request: Partial<ChatSession> & { workspace: string }): Promise<ChatSession>
    updateSession(request: ChatSession): Promise<ChatSession>
    chooseWorkspace(): Promise<string | null>
    chooseAttachments(): Promise<string[]>
    chooseWorkspaceAttachments(): Promise<string[]>
    readGitInfo(workspace: string): Promise<GitInfo>
    checkoutBranch(workspace: string, branch: string): Promise<boolean>
    createBranch(workspace: string, branch: string): Promise<boolean>
    configureProvider(provider: ProviderId): Promise<boolean>
    runAgent(request: {
      provider: ProviderId
      model: string
      reasoning: string
      agent: string
      permissionMode: PermissionMode
      prompt: string
      workspace: string
      attachments: string[]
      mode?: 'run' | 'restart' | 'resume' | 'retry'
      cliSessionId?: string
      lastPrompt?: string
      profileId?: string
    }): Promise<{ runId: string }>
    stopAgent(runId: string): Promise<boolean>
    browser: BrowserApi
    onAgentEvent(listener: (event: AgentEvent) => void): () => void
  }
}
