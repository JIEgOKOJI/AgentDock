export function parseAgentTranscript(provider: ProviderId, raw: string): { content: string; activities: AgentActivity[]; finalFiles: FileChangeSummary[]; cliSessionId: string }
