import { useState } from 'react'
import {
  AlertTriangle, ArrowDown, ArrowUp, BookOpen, Check, ChevronRight, CircleStop, Link2,
  Play, Plus, RefreshCw, Trash2, Workflow, X,
} from 'lucide-react'

const PROVIDER_LIST: ProviderId[] = ['codex', 'claude', 'opencode']

const providerNames: Record<ProviderId, string> = {
  codex: 'Codex CLI',
  claude: 'Claude Code',
  opencode: 'OpenCode',
}

export const pipelineRoleMeta: Record<PipelineRole, { label: string; hint: string; template: string; intent: 'agent' | 'ask' }> = {
  formulate: {
    label: 'Formulate task',
    hint: 'Turns the raw request into a precise task specification',
    intent: 'ask',
    template: 'You are the first stage of an agent pipeline. Turn the raw user request into a precise, self-contained task specification: goal, scope, constraints, acceptance criteria, and any assumptions you had to make. Explore the codebase read-only if needed. Do NOT implement anything and do NOT write files — output only the specification.',
  },
  plan: {
    label: 'Plan',
    hint: 'Produces a step-by-step implementation plan',
    intent: 'ask',
    template: 'You are the planning stage of an agent pipeline. Based on the pipeline context below, produce a concrete implementation plan: ordered steps, files to touch, risks, and how to verify the result. Explore the codebase read-only as needed. Do NOT implement anything — output only the plan.',
  },
  review: {
    label: 'Review',
    hint: 'Critiques the previous stage output',
    intent: 'ask',
    template: 'You are the review stage of an agent pipeline. Critically review the most recent stage output in the pipeline context below (typically a plan or specification). Identify gaps, risks, simpler alternatives, and concrete corrections. Keep what is good. Output the review as a numbered list of findings followed by a corrected/approved version of the plan. Do NOT implement anything.',
  },
  implement: {
    label: 'Implement',
    hint: 'Makes the actual changes in the workspace',
    intent: 'agent',
    template: 'You are the implementation stage of an agent pipeline. Implement the task following the specification, plan, and review notes in the pipeline context below. If a fix round is included, address every listed issue. Make the code changes and finish with a concise summary of what was changed.',
  },
  verify: {
    label: 'Verify',
    hint: 'Checks the implementation; can send it back for fixes',
    intent: 'agent',
    template: 'You are the verification stage of an agent pipeline. Check the implementation against the specification and plan in the pipeline context below: read the changed code, run builds/tests where appropriate, and look for unmet requirements or regressions. You MUST end your response with a line "VERDICT: PASS" if the work is acceptable, or "VERDICT: FAIL" followed by a numbered list of required fixes.',
  },
  custom: {
    label: 'Custom',
    hint: 'Your own stage instruction',
    intent: 'agent',
    template: '',
  },
}

export function defaultPipelineConfig(): PipelineConfig {
  return { enabled: false, autopilot: true, maxFixRounds: 2, steps: [] }
}

function pipelineKey(workspace: string) {
  return `agentdock.pipeline.${workspace}`
}

export function loadPipelineConfig(workspace: string): PipelineConfig {
  try {
    const raw = localStorage.getItem(pipelineKey(workspace))
    if (!raw) return defaultPipelineConfig()
    const parsed = JSON.parse(raw)
    return { ...defaultPipelineConfig(), ...parsed, steps: Array.isArray(parsed.steps) ? parsed.steps : [] }
  } catch {
    return defaultPipelineConfig()
  }
}

export function savePipelineConfig(workspace: string, config: PipelineConfig) {
  try { localStorage.setItem(pipelineKey(workspace), JSON.stringify(config)) } catch {}
}

export function validatePipeline(config: PipelineConfig, installed: Record<ProviderId, boolean>): string[] {
  const issues: string[] = []
  if (!config.steps.length) issues.push('Add at least one step to the pipeline.')
  for (const [index, step] of config.steps.entries()) {
    if (!installed[step.provider]) issues.push(`Step ${index + 1}: ${providerNames[step.provider]} is not installed.`)
    if (step.role === 'custom' && !step.instruction.trim()) issues.push(`Step ${index + 1}: custom steps need an instruction.`)
  }
  if (config.steps.some((step) => step.role === 'verify') && !config.steps.some((step) => step.role === 'implement')) {
    issues.push('A verify step needs an implement step before it to send fixes back to.')
  }
  return issues
}

const clip = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value

export const TEMPLATE_ROLES = ['formulate', 'plan', 'review', 'implement', 'verify'] as const

export function effectiveTemplate(role: PipelineRole, templates: PipelineTemplateOverrides): string {
  if (role === 'custom') return ''
  const override = templates[role]
  return override && override.trim() ? override : pipelineRoleMeta[role].template
}

export interface PipelineStepContext {
  components: Array<{
    category: string
    source: string
    text: string
    status?: 'reported' | 'estimated' | 'unknown'
    tokens?: number | null
  }>
  prompt: string
}

function buildStepPromptParts(step: PipelineStep, request: string, outputs: PipelineStepOutput[], fixNotes: string, templates: PipelineTemplateOverrides = {}): PipelineStepContext {
  const components: PipelineStepContext['components'] = []
  const requestText = clip(request, 4000)
  components.push({ category: 'step_original_request', source: 'pipeline-request', text: requestText })
  for (const [index, output] of outputs.entries()) {
    components.push({ category: 'step_previous_output', source: `step-${index + 1}-${output.role}`, text: clip(output.content, 7000) })
  }
  if (fixNotes) components.push({ category: 'step_fix_notes', source: 'verifier', text: clip(fixNotes, 5000) })
  const systemTemplate = effectiveTemplate(step.role, templates)
  if (systemTemplate) components.push({ category: 'step_system_instruction', source: `role-template-${step.role}`, text: systemTemplate })
  if (step.instruction.trim()) components.push({ category: 'step_extra_instruction', source: 'per-step-override', text: step.instruction.trim() })
  const instruction = [systemTemplate, step.instruction.trim()].filter(Boolean).join('\n\nAdditional instructions for this stage:\n')
  const blocks: string[] = [`## Original user request\n${requestText}`]
  for (const [index, output] of outputs.entries()) {
    blocks.push(`## Stage ${index + 1} output — ${pipelineRoleMeta[output.role].label} (${providerNames[output.provider]} · ${output.model})\n${clip(output.content, 7000)}`)
  }
  if (fixNotes) blocks.push(`## Fix round — the verifier rejected the previous implementation with these notes\n${clip(fixNotes, 5000)}`)
  const prompt = `<pipeline_context>\nYou are one stage in a multi-agent pipeline. Earlier stage outputs:\n\n${blocks.join('\n\n')}\n</pipeline_context>\n\n<stage_instruction>\n${instruction}\n</stage_instruction>`
  return { components, prompt }
}

export function buildStepPrompt(step: PipelineStep, request: string, outputs: PipelineStepOutput[], fixNotes: string, templates: PipelineTemplateOverrides = {}): string {
  return buildStepPromptParts(step, request, outputs, fixNotes, templates).prompt
}

export { buildStepPromptParts }

export function parseVerdict(content: string): 'pass' | 'fail' | undefined {
  const match = [...content.matchAll(/VERDICT:\s*(PASS|FAIL)/gi)].at(-1)
  return match ? (match[1].toUpperCase() === 'PASS' ? 'pass' : 'fail') : undefined
}

let stepCounter = 0
function newStep(runtime: Record<ProviderId, ProviderRuntime>, installed: Record<ProviderId, boolean>, role: PipelineRole): PipelineStep {
  const provider = PROVIDER_LIST.find((id) => installed[id]) ?? 'claude'
  const model = runtime[provider].models[0]
  stepCounter += 1
  return {
    id: `step-${Date.now().toString(36)}-${stepCounter}`,
    role,
    provider,
    model: model?.id ?? '',
    reasoning: model?.defaultReasoning ?? '',
    instruction: '',
  }
}

export function PipelinePanel({
  workspace, installed, runtime, config, onChange, busy, templates, onTemplatesChange, templatesSaving,
}: {
  workspace: string
  installed: Record<ProviderId, boolean>
  runtime: Record<ProviderId, ProviderRuntime>
  config: PipelineConfig
  onChange: (config: PipelineConfig) => void
  busy: boolean
  templates: PipelineTemplateOverrides
  onTemplatesChange: (templates: PipelineTemplateOverrides) => void
  templatesSaving: boolean
}) {
  const [open, setOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const issues = validatePipeline(config, installed)

  const patch = (partial: Partial<PipelineConfig>) => {
    const next = { ...config, ...partial }
    onChange(next)
    savePipelineConfig(workspace, next)
  }

  const patchStep = (id: string, partial: Partial<PipelineStep>) => {
    patch({ steps: config.steps.map((step) => step.id === id ? { ...step, ...partial } : step) })
  }

  const moveStep = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= config.steps.length) return
    const steps = [...config.steps]
    const [step] = steps.splice(index, 1)
    steps.splice(target, 0, step)
    patch({ steps })
  }

  const setStepProvider = (step: PipelineStep, provider: ProviderId) => {
    const model = runtime[provider].models[0]
    patchStep(step.id, { provider, model: model?.id ?? '', reasoning: model?.defaultReasoning ?? '' })
  }

  const setStepModel = (step: PipelineStep, modelId: string) => {
    const model = runtime[step.provider].models.find((item) => item.id === modelId)
    patchStep(step.id, { model: modelId, reasoning: model?.defaultReasoning ?? model?.reasoning[0] ?? '' })
  }

  return <div className="pipeline-panel">
    <button className={`orchestration-toggle ${open ? 'open' : ''}`} onClick={() => setOpen((value) => !value)}>
      <Workflow size={14} /> Pipeline
      {config.enabled && config.steps.length > 0 && <span className="orchestration-badge">{config.steps.length} steps{config.autopilot ? ' · autopilot' : ''}</span>}
      {config.enabled && issues.length > 0 && <span className="orchestration-badge warn"><AlertTriangle size={11} /> {issues.length}</span>}
    </button>

    {open && <div className="orchestration-body pipeline-body">
      <div className="orchestration-inline">
        <label className="orchestration-check"><input type="checkbox" checked={config.enabled} disabled={busy} onChange={(e) => patch({ enabled: e.target.checked })} /><span>Run prompts through the pipeline</span><small>Each step feeds its output to the next.</small></label>
      </div>
      <div className="orchestration-inline">
        <label className="orchestration-check"><input type="checkbox" checked={config.autopilot} disabled={busy} onChange={(e) => patch({ autopilot: e.target.checked })} /><span>Autopilot</span><small>Advance to the next step automatically; otherwise each step waits for you.</small></label>
        <label>Max fix rounds <input type="number" min={0} max={5} value={config.maxFixRounds} disabled={busy} onChange={(e) => patch({ maxFixRounds: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })} /></label>
      </div>

      <div className="pipeline-steps">
        {config.steps.length === 0 && <div className="pipeline-empty">No steps yet. A classic pipeline: Formulate → Plan → Review → Implement → Verify.</div>}
        {config.steps.map((step, index) => {
          const models = runtime[step.provider].models
          const selectedModel = models.find((item) => item.id === step.model)
          return <div className="pipeline-step" key={step.id}>
            <div className="pipeline-step-row">
              <span className="pipeline-step-index">{index + 1}</span>
              <select aria-label="Step role" value={step.role} disabled={busy} onChange={(e) => patchStep(step.id, { role: e.target.value as PipelineRole })}>
                {(Object.keys(pipelineRoleMeta) as PipelineRole[]).map((role) => <option key={role} value={role}>{pipelineRoleMeta[role].label}</option>)}
              </select>
              <select aria-label="Step provider" value={step.provider} disabled={busy} onChange={(e) => setStepProvider(step, e.target.value as ProviderId)}>
                {PROVIDER_LIST.map((id) => <option key={id} value={id} disabled={!installed[id]}>{providerNames[id]}{installed[id] ? '' : ' (not installed)'}</option>)}
              </select>
              <select aria-label="Step model" value={step.model} disabled={busy || !models.length} onChange={(e) => setStepModel(step, e.target.value)}>
                {models.length ? models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>) : <option value="">No models</option>}
              </select>
              {selectedModel?.reasoning.length ? <select aria-label="Step reasoning" value={step.reasoning} disabled={busy} onChange={(e) => patchStep(step.id, { reasoning: e.target.value })}>
                {selectedModel.reasoning.map((item) => <option key={item} value={item}>{item}</option>)}
              </select> : null}
              <span className="activity-spacer" />
              <button className="pipeline-step-action" onClick={() => moveStep(index, -1)} disabled={busy || index === 0} title="Move up"><ArrowUp size={13} /></button>
              <button className="pipeline-step-action" onClick={() => moveStep(index, 1)} disabled={busy || index === config.steps.length - 1} title="Move down"><ArrowDown size={13} /></button>
              <button className="pipeline-step-action danger" onClick={() => patch({ steps: config.steps.filter((item) => item.id !== step.id) })} disabled={busy} title="Remove step"><Trash2 size={13} /></button>
            </div>
            <div className="pipeline-step-hint">{pipelineRoleMeta[step.role].hint}{step.role === 'verify' ? ` · sends fixes back up to ${config.maxFixRounds}×` : ''}{step.role !== 'custom' && templates[step.role]?.trim() ? <em className="template-modified"> · customized template</em> : null}</div>
            <textarea
              className="pipeline-step-instruction"
              value={step.instruction}
              placeholder={step.role === 'custom' ? 'Stage instruction (required for custom steps)…' : 'Extra instructions for this stage (optional)…'}
              disabled={busy}
              rows={1}
              onChange={(e) => patchStep(step.id, { instruction: e.target.value })}
            />
          </div>
        })}
      </div>

      <div className="pipeline-add-row">
        <button className="pipeline-add" onClick={() => patch({ steps: [...config.steps, newStep(runtime, installed, config.steps.length === 0 ? 'formulate' : 'implement')] })} disabled={busy}><Plus size={13} /> Add step</button>
        {config.steps.length === 0 && <button className="pipeline-add" disabled={busy} onClick={() => {
          const roles: PipelineRole[] = ['formulate', 'plan', 'review', 'implement', 'verify']
          patch({ steps: roles.map((role) => newStep(runtime, installed, role)), enabled: true })
        }}><Workflow size={13} /> Use classic 5-step template</button>}
        <span className="activity-spacer" />
        <button className="pipeline-add" onClick={() => setLibraryOpen(true)} disabled={templatesSaving}><BookOpen size={13} /> Role templates{Object.keys(templates).length > 0 ? ` (${Object.keys(templates).length} customized)` : ''}</button>
      </div>

      {config.enabled && issues.length > 0 && <div className="orchestration-issues">{issues.map((issue) => <div key={issue} className="orchestration-issue"><AlertTriangle size={12} /> {issue}</div>)}</div>}
    </div>}

    {libraryOpen && <RoleTemplateLibrary
      templates={templates}
      saving={templatesSaving}
      onClose={() => setLibraryOpen(false)}
      onSave={(next) => { onTemplatesChange(next); setLibraryOpen(false) }}
    />}
  </div>
}

export function RoleTemplateLibrary({
  templates, onSave, onClose, saving,
}: {
  templates: PipelineTemplateOverrides
  onSave: (templates: PipelineTemplateOverrides) => void
  onClose: () => void
  saving: boolean
}) {
  // Drafts hold the full visible text per role; a draft equal to the default counts as "no override".
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(
    TEMPLATE_ROLES.map((role) => [role, templates[role]?.trim() ? templates[role]! : pipelineRoleMeta[role].template]),
  ))

  const isModified = (role: typeof TEMPLATE_ROLES[number]) => drafts[role].trim() !== pipelineRoleMeta[role].template.trim()

  const save = () => {
    const next: PipelineTemplateOverrides = {}
    for (const role of TEMPLATE_ROLES) {
      if (isModified(role) && drafts[role].trim()) next[role] = drafts[role].trim()
    }
    onSave(next)
  }

  return <div className="mcp-editor-overlay" onClick={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <div className="mcp-editor template-library" onClick={(event) => event.stopPropagation()}>
      <div className="mcp-editor-head">
        <h2>Pipeline role templates</h2>
        <button className="icon-button" onClick={onClose} disabled={saving}><X size={18} /></button>
      </div>
      <div className="mcp-editor-body">
        <div className="mcp-form-hint">These instructions are sent as the <code>&lt;stage_instruction&gt;</code> of every pipeline step with that role, before any per-step extra instructions. Overrides are stored in AgentDock settings and apply to all workspaces.</div>
        {TEMPLATE_ROLES.map((role) => <div className="template-role" key={role}>
          <div className="template-role-head">
            <strong>{pipelineRoleMeta[role].label}</strong>
            <span>{pipelineRoleMeta[role].hint}</span>
            {isModified(role) && <em className="template-modified">customized</em>}
            <span className="activity-spacer" />
            {isModified(role) && <button className="template-reset" onClick={() => setDrafts((current) => ({ ...current, [role]: pipelineRoleMeta[role].template }))} disabled={saving}><RefreshCw size={11} /> Reset to default</button>}
          </div>
          <textarea
            value={drafts[role]}
            rows={4}
            disabled={saving}
            onChange={(event) => setDrafts((current) => ({ ...current, [role]: event.target.value }))}
          />
          {role === 'verify' && !/VERDICT/i.test(drafts[role]) && <div className="template-warning"><AlertTriangle size={11} /> The verify template should require a “VERDICT: PASS / FAIL” line — the fix-round loop depends on it.</div>}
        </div>)}
      </div>
      <div className="mcp-editor-foot">
        <button className="mcp-tool-button" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="mcp-tool-button primary" onClick={save} disabled={saving}>{saving ? <RefreshCw className="spin" size={13} /> : <Check size={13} />} Save templates</button>
      </div>
    </div>
  </div>
}

export function PipelineStrip({
  config, run, onContinue, onStop,
}: {
  config: PipelineConfig
  run: PipelineRunState
  onContinue: () => void
  onStop: () => void
}) {
  if (!run.active) return null
  return <div className="pipeline-strip">
    <div className="pipeline-strip-head">
      <Link2 size={13} />
      <strong>Pipeline</strong>
      {run.fixRounds > 0 && <span className="pipeline-fix-badge">fix round {run.fixRounds}</span>}
      <span className="activity-spacer" />
      <button className="pipeline-strip-stop" onClick={onStop} title="Stop the pipeline"><CircleStop size={13} /> Stop</button>
    </div>
    <div className="pipeline-strip-steps">
      {config.steps.map((step, index) => {
        const done = run.outputs.some((output) => output.stepId === step.id) && index !== run.stepIndex
        const current = index === run.stepIndex
        const failVerdict = current ? undefined : [...run.outputs].reverse().find((output) => output.stepId === step.id)?.verdict
        return <span key={step.id} className={`pipeline-chip ${current ? 'current' : done ? 'done' : ''}`} title={`${pipelineRoleMeta[step.role].label} — ${providerNames[step.provider]} · ${step.model}`}>
          {current && !run.awaitingContinue && !run.error ? <RefreshCw className="spin" size={11} /> : done ? (failVerdict === 'fail' ? <X size={11} /> : <Check size={11} />) : <ChevronRight size={11} />}
          {index + 1} · {pipelineRoleMeta[step.role].label}
        </span>
      })}
    </div>
    {run.error && <div className="pipeline-strip-error"><AlertTriangle size={12} /> {run.error}</div>}
    {run.awaitingContinue && !run.error && run.nextIndex !== null && <div className="pipeline-strip-continue">
      <span>Next: step {run.nextIndex + 1} — {pipelineRoleMeta[config.steps[run.nextIndex].role].label} ({providerNames[config.steps[run.nextIndex].provider]})</span>
      <button onClick={onContinue}><Play size={12} /> Continue</button>
    </div>}
    {run.awaitingContinue && run.error && <div className="pipeline-strip-continue">
      <span>Pipeline paused.</span>
      {run.nextIndex !== null && <button onClick={onContinue}><Play size={12} /> Retry step {run.nextIndex + 1}</button>}
    </div>}
  </div>
}
