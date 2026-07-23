/// <reference types="vite/client" />

type ProviderId = 'codex' | 'claude' | 'opencode'
type PermissionMode = 'ask' | 'auto' | 'full'

// Provenance for a context-window value. Runtime = reported by the CLI at run
// time; model-meta = derived from the resolved model catalog; fallback = a
// vetted per-model default; estimated = computed from token sums (not the
// actual window fill); unknown = no reliable source available.
type ContextSource = 'runtime' | 'model-meta' | 'fallback' | 'estimated' | 'unknown'

interface SessionContextSummary {
  components: Array<{
    id: string
    category: string
    source: string
    runId: string | null
    agent: string | null
    chars: number
    tokens: number | null
    status: 'reported' | 'estimated' | 'unknown'
    preview: string
    truncated: boolean
    hash: string | null
  }>
  byCategory: Record<string, { reported: number; estimated: number; unknown: number }>
  accumulatedUsage: TokenUsage
  invocationCount: number
  originalMessages: string[]
  unknownExplanation: string
  legacy?: boolean
  provider?: string
  model?: string
}

interface ModelOption {
  id: string
  label: string
  description?: string
  contextWindow?: number
  contextWindowSource?: ContextSource
  reasoning: string[]
  defaultReasoning: string
}

interface TokenUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  // null = unknown (do NOT render as 0%). A number = the most accurate fill of
  // the live context window for the latest authoritative turn.
  contextTokens: number | null
  contextWindow: number | null
  contextSource: ContextSource
  contextWindowSource: ContextSource
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
  builtin?: boolean
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
  at?: number
  activities?: AgentActivity[]
  files?: FileChangeSummary[]
}

interface FileChangeSummary { path: string; additions: number; deletions: number; diff?: string }
interface AgentActivity {
  id: string
  type: 'thinking' | 'command' | 'files' | 'tool' | 'message'
  title: string
  detail?: string
  output?: string
  status?: string
  position?: number
  files?: FileChangeSummary[]
}

interface GitInfo {
  isRepo: boolean
  currentBranch: string
  branches: string[]
}

interface LaneState {
  cliSessionId: string
  lastPrompt: string
  lastExitCode: number | null
  lastRunFailed: boolean
  usage?: TokenUsage
}

interface RunReceipt {
  runId: string
  sessionId: string
  provider: string
  profileId: string
  mode: string
  intent: 'agent' | 'plan' | 'ask'
  prompt: string
  exitCode: number | null
  outcome: 'success' | 'blocked' | 'needs_human' | 'cost_unverifiable' | 'exhausted_overshoot' | 'cancelled' | 'interrupted'
  filesChanged: Array<{ path: string; additions: number; deletions: number }>
  usage: TokenUsage | null
  cost?: { cost: number; type: string; unverifiable: boolean } | null
  budget?: { maxUsd: number | null; spend: number; remaining: number | null; exceeded?: boolean; reason?: string } | null
  warnings?: string[]
  baseTreeHash?: string
  cleanupWarning?: string
  parentRunId?: string
  kind?: string
  planHash?: string
  startedAt: number
  finishedAt: number
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
  lanes: Record<string, LaneState>
  createdAt: number
  updatedAt: number
}

interface AgentEvent {
  runId: string
  type: 'stdout' | 'stderr' | 'error' | 'exit'
  data: string
}

interface OpenQuestion {
  id: string
  kind: 'single' | 'multi' | 'text'
  text: string
  required?: boolean
  options?: string[]
  value?: string
}

interface PlanResult {
  readiness: 'ready' | 'needs_answers' | 'unverified'
  openQuestions: OpenQuestion[]
  hash: string
  planPath: string
}

interface PlanContract {
  hash: string
  answersHash: string
  path: string
  content: string
  raw: string
  openQuestions: OpenQuestion[]
  readiness: 'ready' | 'needs_answers' | 'unverified'
}

interface RaceCandidate {
  candidateId: string
  provider: string
  profileId: string
  runId: string
  baseTreeHash?: string | null
  exitCode: number | null
  patch: string
  summary: string
  filesChanged: Array<{ path: string; additions: number; deletions: number }>
  gateResult: { testPassed: boolean; overall: string; needsApproval: boolean } | null
  review: { verdict: 'approve' | 'reject' | 'needs_work'; quality: number; notes: string } | null
  reviews?: Array<{ verdict: 'approve' | 'reject' | 'needs_work'; quality: number; notes: string; reviewer?: string }>
  score: number
  failClosed?: boolean
  spawnError?: string | null
}

interface CouncilDraft {
  provider: string
  ok: boolean
  summary: string
  path: string | null
  hash?: string
  runId?: string
}

interface ArtifactEntry {
  path: string
  size: number
  contentType: string
  hash: string | null
}

interface RunManifest {
  version: number
  runId: string
  kind: string
  generated: string
  files: ArtifactEntry[]
}

type PipelineRole = 'formulate' | 'plan' | 'review' | 'implement' | 'verify' | 'custom'

interface PipelineStep {
  id: string
  role: PipelineRole
  provider: ProviderId
  model: string
  reasoning: string
  instruction: string
}

interface PipelineConfig {
  enabled: boolean
  autopilot: boolean
  maxFixRounds: number
  steps: PipelineStep[]
}

interface PipelineStepOutput {
  stepId: string
  role: PipelineRole
  provider: ProviderId
  model: string
  content: string
  verdict?: 'pass' | 'fail'
}

interface PipelineRunState {
  active: boolean
  stepIndex: number
  request: string
  outputs: PipelineStepOutput[]
  fixRounds: number
  awaitingContinue: boolean
  nextIndex: number | null
  error: string
}

interface OrchestrationConfig {
  isolated: boolean
  intent: 'agent' | 'plan' | 'ask'
  gates: { testCommand: string; protectedPaths: string }
  repair: { attempts: number; untilClean: boolean }
  maxUsd: string
  delegate: { enabled: boolean; maxSubRuns: number; maxBestOfN: number }
  race: { enabled: boolean; n: number; providers: string[]; reviewers: number; review: boolean; autoAdopt: boolean; minScore: number }
  council: { enabled: boolean; providers: string[] }
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

type PipelineTemplateOverrides = Partial<Record<Exclude<PipelineRole, 'custom'>, string>>

interface AppSettings {
  defaultGlobalSkills: string[]
  contextHandoff: boolean
  limitAction: 'fail' | 'ask' | 'rotate'
  pipelineTemplates: PipelineTemplateOverrides
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
    getLaneState(sessionId: string, provider: ProviderId, profileId?: string): Promise<LaneState>
    listRuns(sessionId?: string): Promise<RunReceipt[]>
    readRunArtifact(runId: string, artifactPath: string): Promise<string | null>
    listRunArtifacts(runId: string): Promise<ArtifactEntry[]>
    getRunManifest(runId: string): Promise<RunManifest | null>
    verifyRunManifest(runId: string): Promise<{ ok: boolean; mismatches?: Array<Record<string, unknown>>; reason?: string }>
    adoptRunPatch(request: { runId: string; sessionId: string; patch: string; baseTreeHash?: string | null }): Promise<{ ok: boolean; error?: string | null; adopted?: boolean; baseConflict?: boolean }>
    rejectRunApproval(request: { runId: string }): Promise<{ ok: boolean; error?: string }>
    getDelegateSubRunStatus(subRunId: string): Promise<{ state: string; kind: string; provider: string; startedAt: number; finishedAt: number | null } | null>
    getDelegateSubRunResult(subRunId: string): Promise<Record<string, unknown> | null>
    prepareContinuity(request: {
      sessionId: string
      fromProvider: ProviderId
      fromProfileId?: string
      toProvider: ProviderId
      toProfileId?: string
      messages: ChatMessage[]
    }): Promise<{ packetPath: string; threadFilePath: string; event: Record<string, unknown> & { type: string } } | null>
    saveCheckpoint(request: { sessionId: string; provider: ProviderId; profileId?: string; content: string }): Promise<boolean>
    createSession(request: Partial<ChatSession> & { workspace: string }): Promise<ChatSession>
    updateSession(request: ChatSession): Promise<ChatSession>
    deleteSession(sessionId: string): Promise<boolean>
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
      intent?: 'agent' | 'plan' | 'ask'
      cliSessionId?: string
      lastPrompt?: string
      profileId?: string
      sessionId?: string
      gates?: { testCommand: string[] | null; protectedPaths: string[] }
      repair?: { attempts: number; untilClean: boolean }
      maxUsd?: number
      isolated?: boolean
      delegate?: { maxSubRuns?: number; maxBestOfN?: number } | false
      contextComponents?: Array<{ category: string; source: string; text: string; status?: 'reported' | 'estimated' | 'unknown'; tokens?: number | null; id?: string; hash?: string | null; preview?: string; truncated?: boolean; runId?: string | null; agent?: string | null; chars?: number }> | Array<ContextItem>
      pipelineStep?: { role: string; index: number }
    }): Promise<{ runId: string; blocked?: boolean; reason?: string }>
    stopAgent(runId: string): Promise<boolean>
    runRace(request: {
      provider: ProviderId
      model: string
      reasoning: string
      agent: string
      permissionMode: PermissionMode
      prompt: string
      workspace: string
      attachments: string[]
      profileId?: string
      sessionId?: string
      gates?: { testCommand: string[] | null; protectedPaths: string[] }
      race?: { n: number; review: boolean; autoAdopt: boolean; providers?: string[]; reviewers?: number; minScore?: number }
      contextComponents?: Array<{ category: string; source: string; text: string; status?: 'reported' | 'estimated' | 'unknown'; tokens?: number | null; id?: string; hash?: string | null; preview?: string; truncated?: boolean; runId?: string | null; agent?: string | null; chars?: number }> | Array<ContextItem>
    }): Promise<{ raceId: string; winner: RaceCandidate | null; scores: Array<{ candidateId: string; score: number; provider: string }>; candidates: RaceCandidate[]; reason?: string }>
    runCouncil(request: {
      provider: ProviderId
      permissionMode: PermissionMode
      prompt: string
      workspace: string
      attachments: string[]
      profileId?: string
      sessionId: string
      council: { enabled: boolean; providers?: string[] }
      contextComponents?: Array<{ category: string; source: string; text: string; status?: 'reported' | 'estimated' | 'unknown'; tokens?: number | null; id?: string; hash?: string | null; preview?: string; truncated?: boolean; runId?: string | null; agent?: string | null; chars?: number }> | Array<ContextItem>
    }): Promise<{ councilId: string; drafts: CouncilDraft[]; mergedPlan: string | null; openQuestions: OpenQuestion[]; readiness: 'ready' | 'needs_answers' | 'unverified'; hash: string; planPath: string; reason?: string }>
    readPlan(request: { sessionId: string }): Promise<PlanContract | null>
    verifyPlanHash(request: { sessionId: string; hash: string }): Promise<boolean>
    adoptPlan(request: { sessionId: string; planText: string; answers?: Array<{ text: string; value: string }> }): Promise<{ hash: string; path: string; readiness: 'ready' | 'needs_answers' | 'unverified' } | null>
    getBudgetSpend(request: { sessionId: string }): Promise<{ total: number; entries: Array<Record<string, unknown>> }>
    getTokenUsageStats(): Promise<{ records: TokenUsageRecord[]; profileLabels: Record<string, string> }>
    getSessionContextSummary(sessionId: string): Promise<SessionContextSummary>
    getRunContextSnapshot(runId: string): Promise<unknown | null>
    browser: BrowserApi
    onAgentEvent(listener: (event: AgentEvent) => void): () => void
  }
}
