export type ContextStatus = 'reported' | 'estimated' | 'unknown'
export type ContextCategory =
  | 'user_request'
  | 'portable_context'
  | 'continuation_packet'
  | 'git_branch'
  | 'attachment'
  | 'orchestration'
  | 'step_original_request'
  | 'step_previous_output'
  | 'step_fix_notes'
  | 'step_system_instruction'
  | 'step_extra_instruction'
  | 'intent_prefix'
  | 'global_skill'
  | 'browser_awareness'
  | 'delegate_awareness'
  | 'gate_result'
  | 'repair_prompt'
  | 'race_review'
  | 'race_candidate'
  | 'council_draft'
  | 'council_merge'
  | 'delegate_sub_run'
  | 'resume_instruction'
  | 'provider_system_state'
  | 'provider_overhead'


export interface ContextItem {
  id: string
  category: ContextCategory
  source: string
  runId: string | null
  agent: string | null
  chars: number
  tokens: number | null
  status: ContextStatus
  preview: string
  truncated: boolean
  hash: string | null
}

export const COMPONENT_CATEGORIES: Record<string, ContextCategory>

export function estimateTokens(text: string): { tokens: number | null; status: ContextStatus }
export function makePreview(text: string, maxLength?: number): { preview: string; truncated: boolean; hash: string | null }
export function createContextItem(options: {
  category: ContextCategory
  source: string
  runId?: string | null
  agent?: string | null
  text: string
  status?: ContextStatus
  tokens?: number | null
}): ContextItem
