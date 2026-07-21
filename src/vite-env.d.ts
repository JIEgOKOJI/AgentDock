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
  messages: ChatMessage[]
  attachments?: string[]
  git?: GitInfo
  usage?: TokenUsage
  createdAt: number
  updatedAt: number
}

interface AgentEvent {
  runId: string
  type: 'stdout' | 'stderr' | 'error' | 'exit'
  data: string
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
    listSkills(workspace: string): Promise<SkillInfo[]>
    getDefaultGlobalSkills(): Promise<string[]>
    setDefaultGlobalSkill(request: { workspace: string; id: string; enabled: boolean }): Promise<string[]>
    createSkill(request: { workspace: string; scope: SkillInfo['scope'] }): Promise<string | null>
    openSkill(request: { workspace: string; path: string }): Promise<boolean>
    shareSkill(request: { workspace: string; id: string; path: string }): Promise<{ canceled: boolean; updated: number; backups: string[] }>
    getProviderLimits(provider: ProviderId): Promise<ProviderLimits>
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
    runAgent(request: { provider: ProviderId; model: string; reasoning: string; agent: string; permissionMode: PermissionMode; prompt: string; workspace: string; attachments: string[] }): Promise<{ runId: string }>
    stopAgent(runId: string): Promise<boolean>
    onAgentEvent(listener: (event: AgentEvent) => void): () => void
  }
}
