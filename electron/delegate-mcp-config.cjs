'use strict'

// Per-run scoping helpers for the Delegation Belt (#12).
//
// The delegate MCP server must be (a) bound to a single parent run so its
// spawnSubRun back-channel knows which session/profile/budget to attribute
// work to, and (b) injected alongside the browser MCP without clobbering it.
// This module computes the policy from the parent request and builds the
// launch options via the unified mcp-injection module.

const { injectMcpServers, mergeInjectionResults } = require('./mcp-injection.cjs')

const DELEGATE_AWARENESS_PROMPT = `<agentdock_delegate>
You have a built-in delegation capability through the agentdock-delegate MCP
server. It exposes scoped sub-run tools: delegate_ask (read-only research),
delegate_plan (plan + open questions, no writes), delegate_run (write inside an
isolated worktree), delegate_best_of (best-of-N race, winner NOT auto-adopted),
delegate_run_status, delegate_run_result.
Delegates CANNOT apply patches, approve gates, rotate profiles, or change
settings. Nesting depth is capped to 1 — a sub-run cannot delegate further.
Use delegation to parallelize research, compare approaches, or isolate risky
writes; the parent run remains the single source of truth for adoption.
</agentdock_delegate>`

function withDelegateAwarenessPrompt(prompt) {
  if (typeof prompt !== 'string') return prompt
  if (prompt.includes('<agentdock_delegate>')) return prompt
  return `${prompt}\n\n${DELEGATE_AWARENESS_PROMPT}`
}

function normalizeDelegateConfig(value) {
  if (value == null || value === false) return { enabled: false }
  const config = typeof value === 'object' ? value : {}
  return {
    enabled: true,
    maxSubRuns: Number.isFinite(config.maxSubRuns) ? Math.max(1, Math.min(16, Math.floor(config.maxSubRuns))) : 8,
    maxDepth: 1,
    maxBestOfN: Number.isFinite(config.maxBestOfN) ? Math.max(2, Math.min(5, Math.floor(config.maxBestOfN))) : 3,
  }
}

function buildPolicy(delegateConfig, parentBudget) {
  return {
    maxSubRuns: delegateConfig.maxSubRuns,
    maxDepth: delegateConfig.maxDepth,
    maxBestOfN: delegateConfig.maxBestOfN,
    parentBudgetUsd: parentBudget?.maxUsd ?? null,
    sessionSpendUsd: parentBudget?.sessionSpendUsd ?? 0,
  }
}

// Inject browser + delegate MCP servers in one pass. Returns the merged
// launch options (args/env/cleanup) for the provider.
function combinedMcpLaunchOptions(provider, browserDescriptor, delegateDescriptor, runId, basePermissionEnv) {
  const descriptors = []
  if (browserDescriptor && browserDescriptor.url && browserDescriptor.token) {
    descriptors.push({ ...browserDescriptor, tokenEnvVar: browserDescriptor.tokenEnvVar || 'AGENTDOCK_BROWSER_MCP_TOKEN' })
  }
  if (delegateDescriptor && delegateDescriptor.url && delegateDescriptor.token) {
    descriptors.push({ ...delegateDescriptor, tokenEnvVar: delegateDescriptor.tokenEnvVar || 'AGENTDOCK_DELEGATE_MCP_TOKEN' })
  }
  if (!descriptors.length) return { args: [], env: {}, cleanup: async () => {} }
  return injectMcpServers(provider, descriptors, runId, basePermissionEnv)
}

module.exports = {
  DELEGATE_AWARENESS_PROMPT,
  withDelegateAwarenessPrompt,
  normalizeDelegateConfig,
  buildPolicy,
  combinedMcpLaunchOptions,
  mergeInjectionResults,
}