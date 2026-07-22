import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Blocks, Bot, BrainCircuit, Check, ChevronDown, ChevronRight, CircleStop,
  Command, Folder, GitBranch, Menu, MessageSquareText, RefreshCw,
  PanelLeftClose, Paperclip, PlugZap, Plus, Search, Send, Settings, Sparkles,
  FileDiff, FileText, Hand, ShieldAlert, ShieldCheck, Share2, TerminalSquare, Wrench, X, Zap,
} from 'lucide-react'
import { parseAgentTranscript } from './agent-events.mjs'
import { describeActivity } from './activity-format.mjs'
import { MoreMenu, MoreMenuTrigger } from './components/MoreMenu'
import { BrowserView } from './components/BrowserView'

type ProviderId = 'codex' | 'claude' | 'opencode'
type ViewId = 'chat' | 'providers' | 'mcp' | 'skills' | 'settings'
type Message = ChatMessage

const providerMeta: Record<ProviderId, { name: string; badge: string; color: string }> = {
  codex: { name: 'Codex CLI', badge: 'CX', color: '#80caff' },
  claude: { name: 'Claude Code', badge: 'CL', color: '#e6a271' },
  opencode: { name: 'OpenCode', badge: 'OC', color: '#a9e574' },
}

const permissionMeta: Record<PermissionMode, { label: string; description: string }> = {
  ask: { label: 'Ask for approval', description: 'Ask before edits, commands, internet access, or files outside the workspace.' },
  auto: { label: 'Approve automatically', description: 'Only ask for actions the CLI considers potentially unsafe.' },
  full: { label: 'Full access', description: 'Allow internet access and any files on this computer without prompts.' },
}

const fallbackRuntime: Record<ProviderId, ProviderRuntime> = {
  codex: { installed: false, path: null, version: null, agents: ['default'], models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', reasoning: ['low', 'medium', 'high'], defaultReasoning: 'low' }] },
  claude: { installed: false, path: null, version: null, agents: ['default'], models: [{ id: 'sonnet', label: 'Sonnet (latest)', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoning: 'high' }] },
  opencode: { installed: false, path: null, version: null, agents: ['default'], models: [] },
}

const nav = [
  { id: 'chat' as ViewId, label: 'Workspace', icon: MessageSquareText },
  { id: 'providers' as ViewId, label: 'Providers', icon: Bot },
  { id: 'mcp' as ViewId, label: 'MCP servers', icon: PlugZap },
  { id: 'skills' as ViewId, label: 'Skills', icon: Blocks },
]

const starterMessages: Message[] = [{
  id: 'hello', role: 'assistant', provider: 'codex',
  content: 'AgentDock is ready. Choose a provider and model, then describe what you want to build. Your workspace and conversation stay here when you switch engines.',
}]

function workspaceName(workspace: string) {
  return workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || workspace
}

function sessionTitle(messages: Message[]) {
  const firstPrompt = messages.find((message) => message.role === 'user')?.content.replace(/\s+/g, ' ').trim()
  return firstPrompt ? firstPrompt.slice(0, 64) : 'New session'
}

function relativeTime(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return 'moments ago'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

const emptyTokenUsage = (): TokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  contextTokens: 0,
  contextWindow: null,
})

function extractTokenUsage(provider: ProviderId, raw: string, modelContextWindow?: number): TokenUsage | null {
  let usage: TokenUsage | null = null
  const openCodeSteps: TokenUsage[] = []
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0

  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line)
      if (provider === 'codex' && event.type === 'turn.completed' && event.usage) {
        const inputTokens = number(event.usage.input_tokens)
        const outputTokens = number(event.usage.output_tokens)
        usage = {
          inputTokens,
          cachedInputTokens: number(event.usage.cached_input_tokens),
          outputTokens,
          reasoningTokens: number(event.usage.reasoning_output_tokens),
          totalTokens: inputTokens + outputTokens,
          contextTokens: inputTokens + outputTokens,
          contextWindow: modelContextWindow || null,
        }
      } else if (provider === 'claude' && event.type === 'result' && event.usage) {
        const inputTokens = number(event.usage.input_tokens)
        const cachedInputTokens = number(event.usage.cache_read_input_tokens) + number(event.usage.cache_creation_input_tokens)
        const outputTokens = number(event.usage.output_tokens)
        const modelUsage = event.modelUsage && typeof event.modelUsage === 'object' ? Object.values(event.modelUsage)[0] as Record<string, unknown> | undefined : undefined
        usage = {
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningTokens: 0,
          totalTokens: inputTokens + cachedInputTokens + outputTokens,
          contextTokens: inputTokens + cachedInputTokens + outputTokens,
          contextWindow: number(modelUsage?.contextWindow) || modelContextWindow || null,
        }
      } else if (provider === 'opencode' && (event.type === 'step_finish' || event.type === 'step-finish') && event.part?.tokens) {
        const tokens = event.part.tokens
        const inputTokens = number(tokens.input)
        const cachedInputTokens = number(tokens.cache?.read) + number(tokens.cache?.write)
        const outputTokens = number(tokens.output)
        const reasoningTokens = number(tokens.reasoning)
        openCodeSteps.push({
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningTokens,
          totalTokens: inputTokens + outputTokens + reasoningTokens,
          contextTokens: inputTokens + outputTokens,
          contextWindow: modelContextWindow || null,
        })
      }
    } catch {}
  }

  if (openCodeSteps.length) {
    const last = openCodeSteps[openCodeSteps.length - 1]
    usage = openCodeSteps.reduce((total, step) => ({
      inputTokens: total.inputTokens + step.inputTokens,
      cachedInputTokens: total.cachedInputTokens + step.cachedInputTokens,
      outputTokens: total.outputTokens + step.outputTokens,
      reasoningTokens: total.reasoningTokens + step.reasoningTokens,
      totalTokens: total.totalTokens + step.totalTokens,
      contextTokens: last.contextTokens,
      contextWindow: last.contextWindow,
    }), emptyTokenUsage())
  }
  return usage
}

function addTokenUsage(total: TokenUsage, turn: TokenUsage): TokenUsage {
  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    cachedInputTokens: total.cachedInputTokens + turn.cachedInputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    reasoningTokens: total.reasoningTokens + turn.reasoningTokens,
    totalTokens: total.totalTokens + turn.totalTokens,
    contextTokens: turn.contextTokens,
    contextWindow: turn.contextWindow || total.contextWindow,
  }
}

function sanitizeDiagnostics(raw: string) {
  return raw.split(/\r?\n/).filter((line) => {
    const clean = line.trim()
    return clean && !/no stdin data received|reading additional input from stdin/i.test(clean) && !/^\d{4}-\d{2}-\d{2}T\S+\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\b/.test(clean)
  }).join('\n')
}

function buildHandoffContext(messages: Message[]): string {
  const userMessages = messages.filter((message) => message.role === 'user' && message.id !== 'hello' && !message.pending)
  const assistantMessages = messages.filter((message) => message.role === 'assistant' && message.id !== 'hello' && !message.pending)
  if (!userMessages.length && !assistantMessages.length) return ''

  const blocks: string[] = []

  const goal = userMessages[0]?.content.replace(/\s+/g, ' ').trim()
  if (goal) blocks.push(`## Session goal\n${goal.slice(0, 600)}`)

  const recentUserRequests = userMessages.slice(1).map((message) => message.content.replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean)
  if (recentUserRequests.length) blocks.push(`## Recent requests\n${recentUserRequests.map((item) => `- ${item}`).join('\n')}`)

  const summaries: string[] = []
  const allFiles = new Map<string, { additions: number; deletions: number; provider: string }>()
  const commands: string[] = []
  for (const message of assistantMessages) {
    const providerName = message.provider ? providerMeta[message.provider].name : 'Agent'
    if (message.content && !/^The agent finished without a text response\.?$/.test(message.content.trim())) {
      summaries.push(`[${providerName}] ${message.content.replace(/\s+/g, ' ').trim().slice(0, 400)}`)
    }
    if (message.activities) {
      for (const activity of message.activities) {
        if (activity.type === 'command' && activity.title) commands.push(activity.title.slice(0, 120))
      }
    }
    if (message.files) {
      for (const file of message.files) {
        const existing = allFiles.get(file.path)
        if (existing) {
          existing.additions += file.additions
          existing.deletions += file.deletions
        } else {
          allFiles.set(file.path, { additions: file.additions, deletions: file.deletions, provider: providerName })
        }
      }
    }
  }

  if (summaries.length) blocks.push(`## Findings & summaries\n${summaries.join('\n')}`)
  if (allFiles.size) {
    const fileList = [...allFiles.entries()].map(([path, change]) => `- ${path} (+${change.additions}/-${change.deletions})`).join('\n')
    blocks.push(`## Files changed\n${fileList}`)
  }
  if (commands.length) {
    const uniqueCommands = [...new Set(commands)].slice(-15)
    blocks.push(`## Commands run\n${uniqueCommands.map((item) => `- ${item}`).join('\n')}`)
  }

  return blocks.join('\n\n')
}

export default function App() {
  const [view, setView] = useState<ViewId>('chat')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [provider, setProvider] = useState<ProviderId>('codex')
  const [runtime, setRuntime] = useState<Record<ProviderId, ProviderRuntime>>(fallbackRuntime)
  const [model, setModel] = useState(fallbackRuntime.codex.models[0].id)
  const [reasoning, setReasoning] = useState(fallbackRuntime.codex.models[0].defaultReasoning)
  const [agent, setAgent] = useState('default')
  const [agentMenu, setAgentMenu] = useState(false)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('auto')
  const [permissionMenu, setPermissionMenu] = useState(false)
  const [providerMenu, setProviderMenu] = useState(false)
  const [workspace, setWorkspace] = useState('')
  const [installed, setInstalled] = useState<Record<ProviderId, boolean>>({ codex: false, claude: false, opencode: false })
  const [messages, setMessages] = useState<Message[]>(starterMessages)
  const [prompt, setPrompt] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [rawOutput, setRawOutput] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null)
  const [branchMenu, setBranchMenu] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [branchError, setBranchError] = useState('')
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [browserVisible, setBrowserVisible] = useState(false)
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([])
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionsReady, setSessionsReady] = useState(false)
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([])
  const [usage, setUsage] = useState<TokenUsage>(emptyTokenUsage)
  const [limits, setLimits] = useState<ProviderLimits | null | undefined>(undefined)
  const [contextHandoff, setContextHandoff] = useState(true)
  const messagesEnd = useRef<HTMLDivElement>(null)
  const activeRunId = useRef<string | null>(null)
  const limitsRequestId = useRef(0)
  const suppressSessionSave = useRef(true)

  const restoreSession = (session: ChatSession, catalog = runtime) => {
    limitsRequestId.current += 1
    const availableProvider = catalog[session.provider]?.installed
      ? session.provider
      : (Object.keys(catalog) as ProviderId[]).find((id) => catalog[id].installed) ?? 'codex'
    const availableModels = catalog[availableProvider].models
    const selectedModel = availableModels.find((item) => item.id === session.model) ?? availableModels[0]
    suppressSessionSave.current = true
    setActiveSessionId(session.id)
    setWorkspace(session.workspace)
    setProvider(availableProvider)
    setModel(selectedModel?.id ?? '')
    setReasoning(selectedModel?.reasoning.includes(session.reasoning) ? session.reasoning : selectedModel?.defaultReasoning ?? '')
    setAgent(catalog[availableProvider].agents.includes(session.agent) ? session.agent : 'default')
    setPermissionMode(session.permissionMode ?? 'auto')
    setMessages(session.messages.length ? session.messages : starterMessages)
    setPrompt('')
    setRawOutput('')
    setAttachments(session.attachments ?? [])
    setGitInfo(session.git ?? null)
    setBranchMenu(false)
    setNewBranch('')
    setBranchError('')
    setUsage(session.usage ?? emptyTokenUsage())
    setLimits(undefined)
    setView('chat')
  }

  useEffect(() => {
    if (!window.agentDock) return
    Promise.all([window.agentDock.getSystemInfo(), window.agentDock.listSessions()]).then(async ([info, storedSessions]) => {
      setRuntime(info.providers)
      setInstalled(Object.fromEntries(Object.entries(info.providers).map(([id, value]) => [id, value.installed])) as Record<ProviderId, boolean>)
    if (storedSessions.length) {
      setSessions(storedSessions)
      restoreSession(storedSessions[0], info.providers)
    } else {
      const initialProvider = (Object.keys(info.providers) as ProviderId[]).find((id) => info.providers[id].installed) ?? 'codex'
      const initialModel = info.providers[initialProvider].models[0]
      const initialWorkspace = info.cwd || info.home
    const initialGit = await window.agentDock?.readGitInfo(initialWorkspace)
    const created = await window.agentDock!.createSession({
        workspace: initialWorkspace,
        title: 'New session',
        provider: initialProvider,
        model: initialModel?.id ?? '',
        reasoning: initialModel?.defaultReasoning ?? '',
        agent: 'default',
        permissionMode: 'auto',
        messages: starterMessages,
        attachments: [],
        git: initialGit?.isRepo ? initialGit : undefined,
      })
        setSessions([created])
        restoreSession(created, info.providers)
      }
      setSessionsReady(true)
    }).catch(() => setSessionsReady(true))
    window.agentDock?.getMcpServers().then(setMcpServers).catch(() => {})
    window.agentDock?.getSettings().then((settings) => setContextHandoff(settings.contextHandoff)).catch(() => {})
  }, [])

  useEffect(() => {
    const api = window.agentDock?.browser
    if (!api) return
    api.getState().then((state) => setBrowserVisible(Boolean(state?.visible))).catch(() => {})
    return api.onState((state) => setBrowserVisible(state.visible))
  }, [])

  useEffect(() => {
    if (!sessionsReady || !window.agentDock) return
    let cancelled = false
    let attempts = 0
    let timer: number | undefined
    const refresh = async () => {
      try {
        const info = await window.agentDock!.getSystemInfo()
        if (cancelled) return
        setRuntime(info.providers)
        setInstalled(Object.fromEntries(Object.entries(info.providers).map(([id, value]) => [id, value.installed])) as Record<ProviderId, boolean>)
        const incomplete = Object.values(info.providers).some((item) => item.installed && (!item.version || !item.models.length))
        attempts += 1
        if (incomplete && attempts < 3) timer = window.setTimeout(refresh, attempts * 4000)
      } catch {
        attempts += 1
        if (!cancelled && attempts < 3) timer = window.setTimeout(refresh, attempts * 4000)
      }
    }
    // A delayed refresh lets CLIs finish first-run initialization without making the
    // user restart AgentDock when the initial discovery happened too early.
    timer = window.setTimeout(refresh, 4000)
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [sessionsReady])

  useEffect(() => {
    const availableModels = runtime[provider].models
    if (!availableModels.length || availableModels.some((item) => item.id === model)) return
    setModel(availableModels[0].id)
    setReasoning(availableModels[0].defaultReasoning ?? availableModels[0].reasoning[0] ?? '')
  }, [model, provider, runtime])

  useEffect(() => {
    const unsubscribe = window.agentDock?.onAgentEvent((event) => {
      if (activeRunId.current && event.runId !== activeRunId.current) return
      activeRunId.current = event.runId
      setRunId((current) => current ?? event.runId)
      if (event.type === 'stdout') setRawOutput((value) => value + event.data)
      if (event.type === 'stderr') {
        const diagnostics = sanitizeDiagnostics(event.data)
        if (diagnostics) setRawOutput((value) => value + `\n${diagnostics}`)
      }
      if (event.type === 'error') setRawOutput((value) => value + `\n${event.data}`)
      if (event.type === 'exit') {
        activeRunId.current = null
        setRunId(null)
      }
    })
    return typeof unsubscribe === 'function' ? unsubscribe : undefined
  }, [])

  useEffect(() => {
    if (!runId && rawOutput) {
      const transcript = parseAgentTranscript(provider, rawOutput)
      const content = transcript.content || 'The agent finished without a text response.'
      const selectedModel = runtime[provider].models.find((item) => item.id === model)
      const turnUsage = extractTokenUsage(provider, rawOutput, selectedModel?.contextWindow)
      if (turnUsage) setUsage((total) => addTokenUsage(total, turnUsage))
      setMessages((items) => items.map((message) => message.pending ? { ...message, pending: false, content, activities: transcript.activities, files: transcript.finalFiles } : message))
      setRawOutput('')
    }
  }, [runId, rawOutput, provider, model, runtime])

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, rawOutput])

  useEffect(() => {
    if (!sessionsReady || !activeSessionId || !window.agentDock) return
    if (suppressSessionSave.current) {
      suppressSessionSave.current = false
      return
    }
    const timer = window.setTimeout(() => {
      const existing = sessions.find((session) => session.id === activeSessionId)
      if (!existing) return
      const     snapshot: ChatSession = {
        ...existing,
        title: sessionTitle(messages),
        workspace,
        provider,
        model,
        reasoning,
        agent,
        permissionMode,
        messages: messages.filter((message) => !message.pending),
        attachments,
        git: gitInfo ?? undefined,
        usage,
        updatedAt: Date.now(),
      }
      setSessions((items) => [snapshot, ...items.filter((item) => item.id !== snapshot.id)])
      window.agentDock?.updateSession(snapshot).catch(() => {})
    }, 350)
    return () => window.clearTimeout(timer)
  }, [agent, activeSessionId, attachments, gitInfo, messages, model, permissionMode, provider, reasoning, sessionsReady, usage, workspace])

  useEffect(() => {
    if (view === 'chat') void refreshGitInfo()
  }, [view, workspace])

  const chooseProvider = (id: ProviderId) => {
    limitsRequestId.current += 1
    setProvider(id)
    const firstModel = runtime[id].models[0]
    setModel(firstModel?.id ?? '')
    setReasoning(firstModel?.defaultReasoning ?? '')
    setAgent('default')
    setUsage((current) => ({ ...current, contextTokens: 0, contextWindow: null }))
    setLimits(undefined)
    setProviderMenu(false)
  }

  const refreshLimits = async () => {
    const requestId = ++limitsRequestId.current
    setLimits(null)
    if (!window.agentDock || !installed[provider]) {
      setLimits({ available: false, planType: null, limitName: null, primary: null, secondary: null, error: `${providerMeta[provider].name} CLI is not available.` })
      return
    }
    try {
      const value = await window.agentDock.getProviderLimits(provider)
      if (requestId === limitsRequestId.current) setLimits(value)
    } catch (error) {
      if (requestId === limitsRequestId.current) setLimits({ available: false, planType: null, limitName: null, primary: null, secondary: null, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const chooseModel = (id: string) => {
    setModel(id)
    const selected = runtime[provider].models.find((item) => item.id === id)
    setReasoning(selected?.defaultReasoning ?? selected?.reasoning[0] ?? '')
    setUsage((current) => ({ ...current, contextTokens: 0, contextWindow: null }))
  }

  const chooseAttachments = async () => {
    const selected = await window.agentDock?.chooseAttachments()
    if (selected?.length) setAttachments((current) => [...new Set([...current, ...selected])])
  }

  const chooseWorkspaceAttachments = async () => {
    const selected = await window.agentDock?.chooseWorkspaceAttachments()
    if (selected?.length) setAttachments((current) => [...new Set([...current, ...selected])])
  }

  const refreshGitInfo = async () => {
    if (!window.agentDock) return
    const info = await window.agentDock.readGitInfo(workspace)
    setGitInfo(info.isRepo ? info : null)
  }

  const selectBranch = async (branch: string) => {
    if (!window.agentDock) return
    setBranchError('')
    const ok = await window.agentDock.checkoutBranch(workspace, branch)
    if (ok) await refreshGitInfo()
    else setBranchError(`Could not checkout ${branch}`)
    setBranchMenu(false)
  }

  const addBranch = async () => {
    if (!window.agentDock || !newBranch.trim()) return
    setBranchError('')
    const ok = await window.agentDock.createBranch(workspace, newBranch.trim())
    if (ok) {
      await refreshGitInfo()
      setNewBranch('')
    } else {
      setBranchError(`Could not create branch ${newBranch.trim()}`)
    }
  }

  const createNewSession = async (targetWorkspace = workspace) => {
    if (runId || !window.agentDock) return
    const selectedProvider = installed[provider]
      ? provider
      : (Object.keys(installed) as ProviderId[]).find((id) => installed[id]) ?? 'codex'
    const selectedModel = runtime[selectedProvider].models[0]
    const created = await window.agentDock.createSession({
      workspace: targetWorkspace,
      title: 'New session',
      provider: selectedProvider,
      model: selectedProvider === provider && runtime[selectedProvider].models.some((item) => item.id === model) ? model : selectedModel?.id ?? '',
      reasoning: selectedProvider === provider ? reasoning : selectedModel?.defaultReasoning ?? '',
      agent: selectedProvider === provider ? agent : 'default',
      permissionMode,
      messages: starterMessages,
    })
    const git = await window.agentDock.readGitInfo(targetWorkspace)
    if (git.isRepo) created.git = git
    setSessions((items) => [created, ...items])
    restoreSession(created)
  }

  const selectSession = (session: ChatSession) => {
    if (runId || session.id === activeSessionId) return
    restoreSession(session)
  }

  const sendPrompt = async () => {
    const value = prompt.trim()
    if (!value || runId) return
    setPrompt('')
    setRawOutput('')
    const pendingId = crypto.randomUUID()
    const conversationMessages = messages.filter((message) => message.id !== 'hello' && !message.pending)
    let portableContext: string
    if (contextHandoff) {
      portableContext = buildHandoffContext(conversationMessages)
    } else {
      portableContext = conversationMessages
        .slice(-8)
        .map((message) => `${message.role === 'user' ? 'User' : providerMeta[message.provider ?? provider].name}: ${message.content}`)
        .join('\n\n')
    }
    const contextBlocks: string[] = []
    if (portableContext) contextBlocks.push(contextHandoff
      ? `<agentdock_session_summary>\nThis is a compact summary of the session so far, produced so the new model/provider can continue effectively:\n\n${portableContext}\n</agentdock_session_summary>`
      : `Continue from this provider-neutral conversation context:\n\n${portableContext}`)
    if (gitInfo?.currentBranch) contextBlocks.push(`Active git branch: ${gitInfo.currentBranch}`)
    if (attachments.length) contextBlocks.push(`Attached files:\n${attachments.map((file) => `- ${file}`).join('\n')}`)
    const contextPrefix = contextBlocks.length
      ? `<agentdock_context>\n${contextBlocks.join('\n\n')}\n</agentdock_context>\n\n<user_request>\n${value}\n</user_request>`
      : value
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: 'user', content: value }, { id: pendingId, role: 'assistant', provider, content: '', pending: true }])
    try {
      if (!window.agentDock) throw new Error('Agent execution is available in the Electron app.')
      const result = await window.agentDock.runAgent({ provider, model, reasoning, agent, permissionMode, prompt: contextPrefix, workspace, attachments })
      setAttachments([])
      activeRunId.current = result.runId
      setRunId(result.runId)
    } catch (error) {
      setMessages((items) => items.map((message) => message.id === pendingId ? { ...message, pending: false, content: error instanceof Error ? error.message : String(error) } : message))
    }
  }

  const chooseWorkspace = async () => {
    const selected = await window.agentDock?.chooseWorkspace()
    if (selected) await createNewSession(selected)
  }


  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void createNewSession()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [agent, installed, model, provider, reasoning, runId, runtime, workspace])

  useEffect(() => {
    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (branchMenu && !document.querySelector('.branch-select')?.contains(target)) setBranchMenu(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [branchMenu])

  const title = useMemo(() => nav.find((item) => item.id === view)?.label ?? 'Settings', [view])
  const projectGroups = useMemo(() => {
    const groups = new Map<string, ChatSession[]>()
    for (const session of sessions) {
      const group = groups.get(session.workspace) ?? []
      group.push(session)
      groups.set(session.workspace, group)
    }
    return [...groups.entries()].map(([projectPath, projectSessions]) => ({
      path: projectPath,
      name: workspaceName(projectPath),
      sessions: projectSessions.sort((a, b) => b.updatedAt - a.updatedAt),
      updatedAt: Math.max(...projectSessions.map((session) => session.updatedAt)),
    })).sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions])

  return <div className="app-shell">
    <header className="titlebar">
      <div className="brand-mark"><Sparkles size={15} /><span>AGENTDOCK</span><span className="version">ALPHA</span></div>
      <div className="title-drag">agentdock / desktop</div>
      <button className="icon-button title-action" aria-label="Command menu"><Command size={16} /></button>
    </header>

    <div className="workspace-shell">
      <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
        <div className="sidebar-head">
          <button className="new-session" onClick={() => void createNewSession()} disabled={Boolean(runId) || !sessionsReady}><Plus size={16} /><span>New session</span><kbd>Ctrl N</kbd></button>
        </div>
        <nav className="main-nav">
          <div className="nav-caption">SYSTEM</div>
          {nav.map((item) => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => setView(item.id)}>
            <item.icon size={17} /><span>{item.label}</span>{item.id === 'mcp' && <span className="count">{mcpServers.length}</span>}
          </button>)}
        </nav>
        <div className="session-list">
          <div className="nav-caption row">PROJECTS <button onClick={() => void chooseWorkspace()} disabled={Boolean(runId)} aria-label="Add project"><Plus size={14} /></button></div>
          {!sessionsReady && <div className="sessions-empty">Loading sessions…</div>}
          {sessionsReady && !projectGroups.length && <div className="sessions-empty">No projects yet</div>}
          {projectGroups.map((project) => {
            const collapsed = collapsedProjects.includes(project.path)
            return <div className="project-group" key={project.path}>
              <button className="project-row" onClick={() => setCollapsedProjects((items) => items.includes(project.path) ? items.filter((item) => item !== project.path) : [...items, project.path])} title={project.path}>
                {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<Folder size={14} /><strong>{project.name}</strong><span>{project.sessions.length}</span>
              </button>
              {!collapsed && <div className="project-sessions">{project.sessions.map((session) => <button key={session.id} className={`session ${session.id === activeSessionId ? 'active' : ''}`} onClick={() => selectSession(session)} disabled={Boolean(runId) && session.id !== activeSessionId}>
                <strong>{session.title}</strong><small>{relativeTime(session.updatedAt)}</small>
              </button>)}</div>}
            </div>
          })}
        </div>
        <div className="sidebar-foot">
          <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}><Settings size={17} /><span>Settings</span></button>
          <div className="profile"><div className="avatar">JD</div><span><strong>Local workspace</strong><small>All systems operational</small></span><span className="online" /></div>
        </div>
      </aside>

      <div className={`content-shell ${browserVisible ? 'browser-open' : ''}`}>
        <main className="main-panel">
        <div className="panel-toolbar">
          <button className="icon-button" onClick={() => setSidebarOpen(!sidebarOpen)}>{sidebarOpen ? <PanelLeftClose size={18} /> : <Menu size={18} />}</button>
          <div className="toolbar-title"><span>{title}</span>{view === 'chat' && <><ChevronRight size={14} /><strong>{sessionTitle(messages)}</strong></>}</div>
          <div className="toolbar-spacer" />
          {view === 'chat' && <button className="workspace-picker" onClick={chooseWorkspace} disabled={Boolean(runId)} title="Start a session in another project"><Folder size={14} /><span>{workspaceName(workspace)}</span><ChevronDown size={13} /></button>}
          <button className="icon-button"><Search size={17} /></button>
          <MoreMenuTrigger open={moreMenuOpen} onClick={() => setMoreMenuOpen(!moreMenuOpen)} />
          <MoreMenu open={moreMenuOpen} onClose={() => setMoreMenuOpen(false)} browserOpen={browserVisible} onOpenBrowser={() => { setBrowserVisible(true); void window.agentDock?.browser.show() }} />
        </div>

        {view === 'chat' && <ChatView {...{ messages, rawOutput, prompt, setPrompt, sendPrompt, runId, provider, model, chooseModel, reasoning, setReasoning, agent, setAgent, agentMenu, setAgentMenu, permissionMode, setPermissionMode, permissionMenu, setPermissionMenu, providerMenu, setProviderMenu, chooseProvider, installed, runtime, attachments, setAttachments, chooseAttachments, chooseWorkspaceAttachments, gitInfo, refreshGitInfo, branchMenu, setBranchMenu, newBranch, setNewBranch, branchError, setBranchError, selectBranch, addBranch, usage, limits, refreshLimits }} sessionTitle={sessionTitle(messages)} />}
        {view === 'providers' && <ProvidersView installed={installed} runtime={runtime} />}
        {view === 'mcp' && <McpView servers={mcpServers} />}
        {view === 'skills' && <SkillsView workspace={workspace} />}
        {view === 'settings' && <SettingsView workspace={workspace} contextHandoff={contextHandoff} onContextHandoffChange={async (enabled) => { setContextHandoff(enabled); try { await window.agentDock?.patchSettings({ contextHandoff: enabled }) } catch {} }} />}
        <div ref={messagesEnd} />
        </main>
        {browserVisible && <BrowserView onClose={() => setBrowserVisible(false)} />}
      </div>
    </div>
  </div>
}

function ChatView(props: {
  messages: Message[]; rawOutput: string; prompt: string; setPrompt: (value: string) => void; sendPrompt: () => void; sessionTitle: string;
  runId: string | null; provider: ProviderId; model: string; chooseModel: (value: string) => void; reasoning: string;
  setReasoning: (value: string) => void; agent: string; setAgent: (value: string) => void; agentMenu: boolean; setAgentMenu: (value: boolean) => void;
  permissionMode: PermissionMode; setPermissionMode: (value: PermissionMode) => void; permissionMenu: boolean; setPermissionMenu: (value: boolean) => void;
  providerMenu: boolean; setProviderMenu: (value: boolean) => void; chooseProvider: (id: ProviderId) => void;
  installed: Record<ProviderId, boolean>; runtime: Record<ProviderId, ProviderRuntime>; attachments: string[];
  setAttachments: React.Dispatch<React.SetStateAction<string[]>>; chooseAttachments: () => void; chooseWorkspaceAttachments: () => void;
  gitInfo: GitInfo | null; refreshGitInfo: () => Promise<void>; branchMenu: boolean; setBranchMenu: (value: boolean) => void;
  newBranch: string; setNewBranch: (value: string) => void; branchError: string; setBranchError: (value: string) => void;
  selectBranch: (branch: string) => Promise<void>; addBranch: () => Promise<void>;
  usage: TokenUsage; limits: ProviderLimits | null | undefined; refreshLimits: () => void;
}) {
  const meta = providerMeta[props.provider]
  const models = props.runtime[props.provider].models
  const selectedModel = models.find((item) => item.id === props.model)
  const agents = props.runtime[props.provider].agents
  const attachmentPills = props.attachments.length > 0 || Boolean(props.gitInfo)
  const liveTranscript = useMemo(() => parseAgentTranscript(props.provider, props.rawOutput), [props.provider, props.rawOutput])
  const isNewSession = !props.messages.some((message) => message.role === 'user')
  return <section className="chat-view">
    <div className="chat-scroll">
      <div className="conversation-heading"><div><span className="eyebrow"><GitBranch size={12} /> WORKSPACE SESSION</span><h1>{props.sessionTitle}</h1><p>One workspace. Any coding agent.</p></div></div>

      <div className="messages">
        {props.messages.map((message) => <article key={message.id} className={`message ${message.role}`}>
          <div className="message-avatar">{message.role === 'user' ? 'JD' : <BrainCircuit size={17} />}</div>
          <div className="message-body">
            <div className="message-meta"><strong>{message.role === 'user' ? 'You' : providerMeta[message.provider ?? props.provider].name}</strong><span>now</span>{message.provider && <em>{providerMeta[message.provider].badge}</em>}</div>
            {message.pending ? <>
              <div className="agent-started"><span className="running-dot" />{meta.name} начал работу…</div>
              {liveTranscript.activities.length ? <ActivityFeed activities={liveTranscript.activities} live /> : null}
            </> : message.role === 'assistant' && message.id !== 'hello' ? <>
              {message.activities?.length ? <ActivityFeed activities={message.activities} /> : null}
              <FinalSummary content={message.content} files={message.files ?? []} />
            </> : <p>{message.content}</p>}
          </div>
        </article>)}
      </div>
    </div>

    {attachmentPills && <div className="context-pills">
      {props.gitInfo && <span className="context-pill git"><GitBranch size={11} />{props.gitInfo.currentBranch}</span>}
      {props.attachments.map((file) => <span key={file} className="context-pill"><Paperclip size={11} />{file.split(/[\\/]/).pop()}<button onClick={() => props.setAttachments((items) => items.filter((item) => item !== file))}><X size={11} /></button></span>)}
    </div>}

    {isNewSession && <div className="context-bar composer-context-bar">
      <button className="context-action" onClick={props.chooseWorkspaceAttachments} disabled={Boolean(props.runId)}><Folder size={14} />Add files or folder</button>
      {props.gitInfo ? <div className="branch-select">
        <button className="context-action" onClick={() => props.setBranchMenu(!props.branchMenu)} disabled={Boolean(props.runId)}><GitBranch size={14} />{props.gitInfo.currentBranch || 'Branch'}<ChevronDown size={12} /></button>
        {props.branchMenu && <div className="branch-menu">
          <div className="branch-menu-head"><strong>Switch branch</strong></div>
          <div className="branch-list">{props.gitInfo.branches.map((branch) => <button key={branch} className={branch === props.gitInfo?.currentBranch ? 'active' : ''} onClick={() => void props.selectBranch(branch)}><GitBranch size={12} />{branch}{branch === props.gitInfo?.currentBranch && <Check size={12} />}</button>)}</div>
          <div className="branch-create"><input value={props.newBranch} onChange={(e) => props.setNewBranch(e.target.value)} placeholder="New branch name" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void props.addBranch() } }} /><button onClick={() => void props.addBranch()} disabled={!props.newBranch.trim()}><Plus size={12} />Create</button></div>
          {props.branchError && <div className="branch-error">{props.branchError}</div>}
        </div>}
      </div> : <button className="context-action" onClick={props.refreshGitInfo} disabled={Boolean(props.runId)}><GitBranch size={14} />No git repository</button>}
    </div>}

    <div className="composer-wrap">
      <div className="composer">
        {props.attachments.length > 0 && <div className="attachment-list">{props.attachments.map((file) => <span key={file}><Paperclip size={11} />{file.split(/[\\/]/).pop()}<button onClick={() => props.setAttachments((items) => items.filter((item) => item !== file))}><X size={11} /></button></span>)}</div>}
        <textarea value={props.prompt} onChange={(e) => props.setPrompt(e.target.value)} placeholder="Ask the agent to build, explain, or change something…" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); props.sendPrompt() } }} />
        <div className="composer-bar">
          <button className="tool-button" onClick={props.chooseAttachments} aria-label="Attach files"><Paperclip size={16} /></button>
          <div className="agent-select">
            <button className="tool-pill" onClick={() => props.setAgentMenu(!props.agentMenu)}><Zap size={14} /> {props.agent === 'default' ? 'Agent' : props.agent} <ChevronDown size={12} /></button>
            {props.agentMenu && <div className="agent-menu">{agents.map((item) => <button key={item} onClick={() => { props.setAgent(item); props.setAgentMenu(false) }}><span>{item === 'default' ? 'Default agent' : item}</span>{item === props.agent && <Check size={14} />}</button>)}</div>}
          </div>
          <div className="permission-select">
            <button className={`tool-pill permission-button ${props.permissionMode === 'full' ? 'danger' : ''}`} onClick={() => props.setPermissionMenu(!props.permissionMenu)} disabled={Boolean(props.runId)}><ShieldCheck size={14} /> {permissionMeta[props.permissionMode].label} <ChevronDown size={12} /></button>
            {props.permissionMenu && <div className="permission-menu">
              <div className="permission-menu-head"><strong>How should agents request approval?</strong><small>The selected mode applies to every CLI.</small></div>
              {(Object.keys(permissionMeta) as PermissionMode[]).map((mode) => {
                const Icon = mode === 'ask' ? Hand : mode === 'auto' ? ShieldCheck : ShieldAlert
                return <button key={mode} className={mode === 'full' ? 'danger' : ''} onClick={() => { props.setPermissionMode(mode); props.setPermissionMenu(false) }}>
                  <Icon size={16} /><span><strong>{permissionMeta[mode].label}</strong><small>{permissionMeta[mode].description}</small></span>{mode === props.permissionMode && <Check size={15} />}
                </button>
              })}
            </div>}
          </div>
          <div className="composer-spacer" />
          <div className="provider-select">
            <button className="provider-button" onClick={() => props.setProviderMenu(!props.providerMenu)} disabled={Boolean(props.runId)}><span className="provider-logo" style={{ '--provider': meta.color } as React.CSSProperties}>{meta.badge}</span><span>{meta.name}</span><ChevronDown size={13} /></button>
            {props.providerMenu && <div className="provider-menu">{(Object.keys(providerMeta) as ProviderId[]).map((id) => <button key={id} onClick={() => props.chooseProvider(id)} disabled={!props.installed[id]}><span className="provider-logo" style={{ '--provider': providerMeta[id].color } as React.CSSProperties}>{providerMeta[id].badge}</span><span><strong>{providerMeta[id].name}</strong><small>{props.installed[id] ? 'Installed' : 'CLI not found'}</small></span>{id === props.provider && <Check size={15} />}</button>)}</div>}
          </div>
          <select aria-label="Model" value={props.model} onChange={(e) => props.chooseModel(e.target.value)} disabled={!models.length || Boolean(props.runId)}>{models.length ? models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>) : <option>No models found</option>}</select>
          {selectedModel?.reasoning.length ? <select aria-label="Reasoning level" value={props.reasoning} onChange={(e) => props.setReasoning(e.target.value)} disabled={Boolean(props.runId)}>{selectedModel.reasoning.map((item) => <option key={item} value={item}>{item}</option>)}</select> : null}
          <UsageIndicator provider={props.provider} usage={{ ...props.usage, contextWindow: props.usage.contextWindow || selectedModel?.contextWindow || null }} limits={props.limits} refreshLimits={props.refreshLimits} />
          {props.runId ? <button className="send-button stop" onClick={() => window.agentDock?.stopAgent(props.runId!)}><CircleStop size={17} /></button> : <button className="send-button" onClick={props.sendPrompt} disabled={!props.prompt.trim()}><Send size={17} /></button>}
        </div>
      </div>
      <div className="composer-hint"><span>Enter to send · Shift + Enter for new line</span><span>Context is portable across providers</span></div>
    </div>
  </section>
}

function ActivityFeed({ activities, live = false }: { activities: AgentActivity[]; live?: boolean }) {
  const reasoning = activities.filter((activity) => activity.type === 'thinking')
  const actions = activities.filter((activity) => activity.type !== 'thinking')
  return <div className={`activity-feed ${live ? 'live' : ''}`}>
    {reasoning.length ? <details className="activity-group reasoning" open={live}>
      <summary><span className="activity-icon"><BrainCircuit size={14} /></span><strong>Reasoning</strong><span className="activity-count">{reasoning.length}</span><span className="activity-spacer" /><ChevronRight className="activity-chevron" size={14} /></summary>
      <div className="reasoning-list">{reasoning.map((item) => <p key={item.id}>{item.detail}</p>)}</div>
    </details> : null}
    {actions.length ? <details className="activity-group actions" open={live}>
      <summary><span className="activity-icon"><TerminalSquare size={14} /></span><strong>Actions</strong><span className="activity-count">{actions.length}</span><span className="activity-spacer" /><ChevronRight className="activity-chevron" size={14} /></summary>
      <div className="action-list">{actions.map((activity) => <ActionRow activity={activity} key={activity.id} />)}</div>
    </details> : null}
  </div>
}

function ActionRow({ activity }: { activity: AgentActivity }) {
  const changed = activity.type === 'files'
  const description = describeActivity(activity)
  const additions = changed ? activity.files?.reduce((sum, file) => sum + file.additions, 0) ?? 0 : 0
  const deletions = changed ? activity.files?.reduce((sum, file) => sum + file.deletions, 0) ?? 0 : 0
  const expandable = Boolean(activity.detail || activity.output || activity.files?.some((file) => file.diff))
  const ActivityIcon = description.kind === 'read' ? FileText
    : description.kind === 'search' ? Search
      : description.kind === 'list' ? Folder
        : description.kind === 'edit' ? FileDiff
          : description.kind === 'git' ? GitBranch
            : description.kind === 'build' || description.kind === 'test' || description.kind === 'install' ? Wrench
              : TerminalSquare
  const heading = <><span className="action-kind"><ActivityIcon size={13} /></span><strong>{description.label}</strong>{description.target ? <span className="action-target">{description.target}</span> : null}</>
  const content = <>
    {activity.detail ? <pre>{activity.detail}</pre> : null}
    {activity.output ? <pre className="activity-output">{activity.output}</pre> : null}
    {activity.files?.map((file) => <div className="action-file" key={file.path}>
      <div><span>{file.path}</span><i>+{file.additions}</i><b>-{file.deletions}</b></div>
      {file.diff ? <pre className="file-diff">{file.diff}</pre> : null}
    </div>)}
  </>
  if (!expandable) return <div className={`action-row ${description.kind}`}>{heading}<span className="activity-spacer" />{changed ? <span className="activity-totals"><i>+{additions}</i><b>-{deletions}</b></span> : null}</div>
  return <details className={`action-row ${description.kind}`}>
    <summary>{heading}<span className="activity-spacer" />{changed ? <span className="activity-totals"><i>+{additions}</i><b>-{deletions}</b></span> : null}<ChevronRight className="activity-chevron" size={13} /></summary>
    <div className="action-content">{content}</div>
  </details>
}

function FinalSummary({ content, files }: { content: string; files: FileChangeSummary[] }) {
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  return <div className="final-summary">
    <div className="summary-label">Summary</div>
    <p>{content}</p>
    {files.length ? <details className="final-files" open>
      <summary><span className="activity-icon"><FileDiff size={14} /></span><strong>Изменено файлов: {files.length}</strong><span className="activity-spacer" /><span className="activity-totals"><i>+{additions}</i><b>-{deletions}</b></span><ChevronRight className="activity-chevron" size={14} /></summary>
      <div className="final-file-list">{files.map((file) => file.diff ? <details className="final-file" key={file.path}>
        <summary><span>{file.path}</span><i>+{file.additions}</i><b>-{file.deletions}</b><ChevronRight className="activity-chevron" size={13} /></summary><pre className="file-diff">{file.diff}</pre>
      </details> : <div className="final-file" key={file.path}><span>{file.path}</span><i>+{file.additions}</i><b>-{file.deletions}</b></div>)}</div>
    </details> : null}
  </div>
}

function formatTokens(value: number) {
  if (value < 1000) return String(Math.round(value))
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value).toLowerCase()
}

function resetLabel(window: RateLimitWindow) {
  if (window.resetText) return window.resetText.replace(/^./, (letter) => letter.toUpperCase())
  if (!window.resetsAt) return 'Reset time unavailable'
  const minutes = Math.max(0, Math.ceil((window.resetsAt * 1000 - Date.now()) / 60000))
  if (minutes < 60) return `Resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 48) return `Resets in ${hours}h${rest ? ` ${rest}m` : ''}`
  return `Resets ${new Date(window.resetsAt * 1000).toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
}

function windowLabel(window: RateLimitWindow) {
  if (window.label) return window.label
  if (window.windowDurationMins === 300) return '5-hour limit'
  if (window.windowDurationMins === 10080) return 'Weekly · all models'
  if (window.windowDurationMins) return `${Math.round(window.windowDurationMins / 60)}-hour limit`
  return 'Usage limit'
}

function UsageIndicator({ provider, usage, limits, refreshLimits }: { provider: ProviderId; usage: TokenUsage; limits: ProviderLimits | null | undefined; refreshLimits: () => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const percent = usage.contextWindow ? Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100)) : 0
  const windows = limits?.available ? (limits.windows ?? [limits.secondary, limits.primary].filter((item): item is RateLimitWindow => Boolean(item))) : []

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [open])

  return <div className="usage-control" ref={root}>
    <button className="usage-orb" onClick={() => { const next = !open; setOpen(next); if (next) refreshLimits() }} aria-label="Token usage and limits" aria-expanded={open} title="Token usage and limits" style={{ '--usage': `${percent * 3.6}deg` } as React.CSSProperties}><i /></button>
    {open && <div className="usage-popover">
      <div className="usage-section">
        <div className="usage-heading"><span>Context window</span><strong>{usage.contextTokens ? formatTokens(usage.contextTokens) : '0'}{usage.contextWindow ? ` / ${formatTokens(usage.contextWindow)} (${percent}%)` : ' used'}</strong></div>
        <div className={`usage-track ${usage.contextWindow ? '' : 'unknown'}`}><i style={{ width: `${percent}%` }} /></div>
        {!usage.contextWindow && <small>The provider does not expose this model’s context maximum.</small>}
      </div>
      <div className="usage-section">
        <div className="usage-heading"><span>Session tokens</span><strong>{formatTokens(usage.totalTokens)} total</strong></div>
        <div className="token-breakdown"><span><b>{formatTokens(usage.inputTokens)}</b> input</span><span><b>{formatTokens(usage.outputTokens)}</b> output</span>{usage.cachedInputTokens > 0 && <span><b>{formatTokens(usage.cachedInputTokens)}</b> cached</span>}{usage.reasoningTokens > 0 && <span><b>{formatTokens(usage.reasoningTokens)}</b> reasoning</span>}</div>
      </div>
      <div className="usage-section limits-section">
        <div className="usage-heading"><span>Plan usage limits{limits?.planType ? ` · ${limits.planType.replace(/^./, (letter) => letter.toUpperCase())}` : ''}</span></div>
        {limits === null && <small>Loading provider limits…</small>}
        {limits === undefined && <small>Open this panel to refresh provider limits.</small>}
        {limits && !limits.available && <small>{limits.error || `${providerMeta[provider].name} does not expose plan limits through its CLI.`}</small>}
        {windows.map((window, index) => <div className="limit-row" key={`${window.windowDurationMins}-${index}`}>
          <div><strong>{windowLabel(window)}</strong><span>{resetLabel(window)} <b>{window.usedPercent}%</b></span></div>
          <div className="usage-track"><i style={{ width: `${Math.min(100, window.usedPercent)}%` }} /></div>
        </div>)}
      </div>
    </div>}
  </div>
}

function ProvidersView({ installed, runtime }: { installed: Record<ProviderId, boolean>; runtime: Record<ProviderId, ProviderRuntime> }) {
  return <Page title="Agent providers" subtitle="Installed CLIs and the model catalogs they currently expose.">
    <div className="card-grid providers-grid">{(Object.keys(providerMeta) as ProviderId[]).map((id) => <div className="feature-card" key={id}>
      <div className="feature-top"><span className="large-logo" style={{ '--provider': providerMeta[id].color } as React.CSSProperties}>{providerMeta[id].badge}</span><span className={`status ${installed[id] ? 'ok' : ''}`}>{installed[id] ? 'Connected' : 'Not found'}</span></div>
      <h3>{providerMeta[id].name}</h3><p>{runtime[id].models.length} models discovered · {runtime[id].version ?? 'CLI not installed'}</p>
      <div className="card-footer"><span title={runtime[id].path ?? undefined}><TerminalSquare size={14} /> {runtime[id].version ?? id}</span><button onClick={() => window.agentDock?.configureProvider(id)} disabled={!installed[id]}>Configure <ChevronRight size={14} /></button></div>
    </div>)}</div>
    <InfoStrip icon={<Sparkles size={18} />} title="Portable sessions" text="AgentDock keeps a provider-neutral transcript, so the next engine can continue with the same project context." />
  </Page>
}

function McpView({ servers }: { servers: McpServerInfo[] }) {
  return <Page title="MCP servers" subtitle="Servers reported by the MCP configuration of each installed CLI.">
    <div className="list-card">{servers.length ? servers.map((server) => <div className="integration-row" key={server.name}><span className="integration-icon" style={{ background: '#a9e57418', color: '#a9e574' }}><PlugZap size={18} /></span><span className="integration-info"><strong>{server.name}</strong><small>{server.detail || 'Configured MCP server'}</small></span><span className="tool-count">{server.providers.join(' · ')}</span><span className={`status ${server.enabled ? 'ok' : ''}`}>{server.enabled ? 'Enabled' : 'Unavailable'}</span><button className="icon-button" onClick={() => window.agentDock?.configureProvider(server.providers[0])} aria-label={`Configure ${server.name}`}><Settings size={16} /></button></div>) : <div className="empty-state">No MCP servers were reported by the installed CLIs.</div>}</div>
    <InfoStrip icon={<Wrench size={18} />} title="No synthetic entries" text="This list is read from Codex, Claude Code, and OpenCode. Proxies such as Headroom are not shown as MCP servers." />
  </Page>
}

function SkillsView({ workspace }: { workspace: string }) {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [filter, setFilter] = useState<'all' | SkillInfo['scope']>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sharing, setSharing] = useState<string | null>(null)
  const [defaultSkills, setDefaultSkills] = useState<string[]>([])
  const [updatingDefault, setUpdatingDefault] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      if (!window.agentDock) throw new Error('Skills are available in the Electron app.')
      const [availableSkills, enabledDefaults] = await Promise.all([
        window.agentDock.listSkills(workspace),
        window.agentDock.getDefaultGlobalSkills(),
      ])
      setSkills(availableSkills)
      setDefaultSkills(enabledDefaults)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [workspace])

  const visibleSkills = skills.filter((skill) => {
    const matchesScope = filter === 'all' || skill.scope === filter
    const needle = query.trim().toLowerCase()
    return matchesScope && (!needle || `${skill.name} ${skill.description} ${skill.path}`.toLowerCase().includes(needle))
  })
  const createScope = filter === 'global' ? 'global' : 'project'
  const create = async () => {
    try {
      setError('')
      setNotice('')
      const created = await window.agentDock?.createSkill({ workspace, scope: createScope })
      if (created) await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const share = async (skill: SkillInfo) => {
    try {
      setError('')
      setNotice('')
      setSharing(skill.id)
      if (!window.agentDock) throw new Error('Skill sharing is available in the Electron app.')
      const result = await window.agentDock.shareSkill({ workspace, id: skill.id, path: skill.path })
      if (!result.canceled) {
        const backupMessage = result.backups.length ? ` ${result.backups.length} previous ${result.backups.length === 1 ? 'copy was' : 'copies were'} backed up.` : ''
        setNotice(result.updated ? `${skill.name} shared across all CLI skill locations.${backupMessage}` : `${skill.name} is already synchronized.`)
        await refresh()
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSharing(null)
    }
  }

  const toggleDefault = async (skill: SkillInfo, enabled: boolean) => {
    try {
      setError('')
      setNotice('')
      setUpdatingDefault(skill.id)
      if (!window.agentDock) throw new Error('Default skills are available in the Electron app.')
      const enabledDefaults = await window.agentDock.setDefaultGlobalSkill({ workspace, id: skill.id, enabled })
      setDefaultSkills(enabledDefaults)
      setNotice(enabled
        ? `${skill.name} will now be loaded for every Codex, Claude, and OpenCode request.`
        : `${skill.name} will return to on-demand loading.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setUpdatingDefault(null)
    }
  }

  const open = (skill: SkillInfo) => window.agentDock?.openSkill({ workspace, path: skill.path }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
  const cliNames: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' }

  return <Page title="Agent skills" subtitle="One catalog for Codex, Claude Code, and OpenCode skills, with safe cross-CLI sharing." action={{ label: `Create ${createScope} skill`, onClick: create }}>
    <div className="filter-row"><div className="search-box"><Search size={15} /><input placeholder="Search skills" value={query} onChange={(event) => setQuery(event.target.value)} /></div>{(['all', 'global', 'project'] as const).map((scope) => <button key={scope} className={`filter ${filter === scope ? 'active' : ''}`} onClick={() => setFilter(scope)}>{scope.replace(/^./, (letter) => letter.toUpperCase())}</button>)}</div>
    {error && <div className="skills-message error">{error}</div>}
    {notice && <div className="skills-message success">{notice}</div>}
    {loading ? <div className="skills-message">Loading skills…</div> : visibleSkills.length ? <div className="skills-grid">{visibleSkills.map((skill) => {
      const sharedWithAll = skill.providers.length === 3
      return <div className={`skill-card ${skill.synced ? '' : 'conflict'}`} key={skill.id} title={skill.copies.map((copy) => copy.path).join('\n')}>
        <div className="skill-icon">{skill.scope === 'global' ? <Sparkles size={18} /> : <Blocks size={18} />}</div>
        <div className="skill-summary"><h3>{skill.name}</h3><p>{skill.description}</p><div className="skill-providers">{(Object.keys(cliNames) as ProviderId[]).map((id) => <span key={id} className={skill.providers.includes(id) ? 'available' : ''} title={`${cliNames[id]} ${skill.providers.includes(id) ? 'can discover this skill' : 'does not see this skill yet'}`}>{cliNames[id]}</span>)}</div></div>
        <div className="skill-foot"><span>{skill.scope === 'global' ? 'Global' : 'Project'} · {skill.copies.length} {skill.copies.length === 1 ? 'copy' : 'copies'}</span><div className="skill-actions">{skill.scope === 'global' && <label className="default-skill-toggle" title="Load this skill before every request, regardless of the selected CLI"><b>Use by default</b><input type="checkbox" checked={defaultSkills.includes(skill.id)} disabled={updatingDefault === skill.id} onChange={(event) => void toggleDefault(skill, event.target.checked)} /><i /></label>}<button onClick={() => void open(skill)}>Open <ChevronRight size={14} /></button>{!skill.synced ? <button className="share-action warning" onClick={() => void share(skill)} disabled={sharing === skill.id}>{sharing === skill.id ? <RefreshCw className="spin" size={13} /> : <RefreshCw size={13} />} Sync copies</button> : sharedWithAll ? <em><Check size={12} /> Shared</em> : <button className="share-action" onClick={() => void share(skill)} disabled={sharing === skill.id}>{sharing === skill.id ? <RefreshCw className="spin" size={13} /> : <Share2 size={13} />} Share to all</button>}</div></div>
      </div>
    })}</div> : <div className="skills-message">{skills.length ? 'No skills match this filter.' : 'No skills found. Create one to add a portable SKILL.md workflow.'}</div>}
    <InfoStrip icon={<Sparkles size={18} />} title="Default global skills" text="Enabled skills are explicitly loaded before every request sent through AgentDock, for Codex, Claude Code, and OpenCode." />
  </Page>
}

function SettingsView({ workspace, contextHandoff, onContextHandoffChange }: { workspace: string; contextHandoff: boolean; onContextHandoffChange: (enabled: boolean) => void }) {
  return <Page title="Settings" subtitle="Tune AgentDock for your machine and workflow.">
    <div className="settings-card"><div className="setting-row"><span><strong>Default workspace</strong><small>New sessions start in this directory</small></span><code>{workspace}</code></div><div className="setting-row"><span><strong>Context handoff</strong><small>Generate a compact session summary (goal, plan, findings, changes) when switching providers or models, instead of forwarding the last 8 messages</small></span><label className="switch"><input type="checkbox" checked={contextHandoff} onChange={(event) => onContextHandoffChange(event.target.checked)} /><i /></label></div><div className="setting-row"><span><strong>Run confirmation</strong><small>Ask before an agent executes commands</small></span><label className="switch"><input type="checkbox" defaultChecked /><i /></label></div></div>
  </Page>
}

function Page({ title, subtitle, action, children }: { title: string; subtitle: string; action?: { label: string; onClick: () => void }; children: React.ReactNode }) {
  return <section className="page"><div className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div>{action && <button className="primary-button" onClick={action.onClick}><Plus size={15} />{action.label}</button>}</div>{children}</section>
}

function InfoStrip({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="info-strip"><span>{icon}</span><div><strong>{title}</strong><p>{text}</p></div><button><X size={15} /></button></div>
}
