const CONTEXT_STATUS_REPORTED = 'reported'
const CONTEXT_STATUS_ESTIMATED = 'estimated'
const CONTEXT_STATUS_UNKNOWN = 'unknown'

const COMPONENT_CATEGORIES = {
  userRequest: 'user_request',
  portableContext: 'portable_context',
  continuationPacket: 'continuation_packet',
  gitBranch: 'git_branch',
  attachment: 'attachment',
  orchestration: 'orchestration',
  stepOriginalRequest: 'step_original_request',
  stepPreviousOutput: 'step_previous_output',
  stepFixNotes: 'step_fix_notes',
  stepSystemInstruction: 'step_system_instruction',
  stepExtraInstruction: 'step_extra_instruction',
  intentPrefix: 'intent_prefix',
  globalSkill: 'global_skill',
  browserAwareness: 'browser_awareness',
  delegateAwareness: 'delegate_awareness',
  gateResult: 'gate_result',
  repairPrompt: 'repair_prompt',
  raceReview: 'race_review',
  raceCandidate: 'race_candidate',
  councilDraft: 'council_draft',
  councilMerge: 'council_merge',
  delegateSubRun: 'delegate_sub_run',
  resumeInstruction: 'resume_instruction',
  providerSystemState: 'provider_system_state',
  providerOverhead: 'provider_overhead',
}

function estimateTokens(text) {
  if (text == null || typeof text !== 'string') return { tokens: null, status: CONTEXT_STATUS_UNKNOWN }
  if (text.length === 0) return { tokens: 0, status: CONTEXT_STATUS_ESTIMATED }
  const words = text.trim().split(/\s+/).filter(Boolean).length
  const chars = text.length
  const estimate = Math.max(Math.round(chars / 4), Math.round(words * 0.6))
  return { tokens: estimate, status: CONTEXT_STATUS_ESTIMATED }
}

module.exports = {
  CONTEXT_STATUS_REPORTED,
  CONTEXT_STATUS_ESTIMATED,
  CONTEXT_STATUS_UNKNOWN,
  COMPONENT_CATEGORIES,
  estimateTokens,
}
