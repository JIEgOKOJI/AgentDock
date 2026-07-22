const IMAGE_FILE_PATTERN = /\.(?:png|jpe?g|gif|webp)$/i

function promptWithAttachments(prompt, attachments = []) {
  if (!attachments.length) return prompt
  return `${prompt}\n\n<agentdock_attachments>\nThe user attached the following local files. Open and inspect them before answering; do not claim that no file was provided.\n${attachments.map((file) => `- ${file}`).join('\n')}\n</agentdock_attachments>`
}

function codexApprovalPolicy(mode) {
  return mode === 'ask' ? 'untrusted' : 'on-request'
}

function codexResumePermissionArgs(permissionMode) {
  if (permissionMode === 'full') return ['--dangerously-bypass-approvals-and-sandbox']
  return ['-c', `approval_policy="${codexApprovalPolicy(permissionMode)}"`, '-c', 'sandbox_mode="workspace-write"']
}

const adapters = {
  codex: {
    executable: 'codex',
    buildArgs: ({ model, reasoning, prompt, workspace, attachments = [], permissionArgs = [] }) => [
      'exec', '--json', '--color', 'never', '--cd', workspace,
      ...permissionArgs,
      ...(model ? ['--model', model] : []),
      ...(reasoning ? ['-c', `model_reasoning_effort="${reasoning}"`] : []),
      ...attachments.filter((file) => IMAGE_FILE_PATTERN.test(file)).flatMap((file) => ['--image', file]),
      '--', promptWithAttachments(prompt, attachments),
    ],
    buildResumeArgs: ({ model, reasoning, workspace, cliSessionId, lastPrompt, attachments = [], permissionMode = 'auto', permissionArgs = [] }) => {
      const args = ['exec', 'resume', '--json', '--skip-git-repo-check', ...codexResumePermissionArgs(permissionMode)]
      args.push(...permissionArgs)
      if (reasoning) args.push('-c', `model_reasoning_effort="${reasoning}"`)
      if (model) args.push('--model', model)
      args.push(...attachments.filter((file) => IMAGE_FILE_PATTERN.test(file)).flatMap((file) => ['--image', file]))
      args.push(cliSessionId || '--last')
      if (lastPrompt) args.push(promptWithAttachments(lastPrompt, attachments))
      return args
    },
  },
  claude: {
    executable: 'claude',
    buildArgs: ({ model, reasoning, prompt, attachments = [], permissionArgs = [] }) => [
      '--print', '--output-format', 'stream-json', '--verbose',
      ...permissionArgs,
      ...(model ? ['--model', model] : []),
      ...(reasoning ? ['--effort', reasoning] : []),
      '--',
      promptWithAttachments(prompt, attachments),
    ],
    buildResumeArgs: ({ model, reasoning, cliSessionId, lastPrompt, attachments = [], permissionArgs = [] }) => [
      '--print', '--output-format', 'stream-json', '--verbose',
      '--resume', cliSessionId,
      ...permissionArgs,
      ...(model ? ['--model', model] : []),
      ...(reasoning ? ['--effort', reasoning] : []),
      '--',
      promptWithAttachments(lastPrompt || 'Continue from where we left off.', attachments),
    ],
  },
  opencode: {
    executable: 'opencode',
    buildArgs: ({ model, reasoning, agent, prompt, workspace, attachments = [], permissionArgs = [] }) => [
      'run', '--format', 'json', '--dir', workspace,
      ...permissionArgs,
      ...(model ? ['--model', model] : []),
      ...(reasoning ? ['--variant', reasoning] : []),
      ...(agent && agent !== 'default' ? ['--agent', agent] : []),
      ...attachments.flatMap((file) => ['--file', file]),
      '--', promptWithAttachments(prompt, attachments),
    ],
    buildResumeArgs: ({ model, reasoning, agent, workspace, cliSessionId, lastPrompt, attachments = [], permissionArgs = [] }) => [
      'run', '--format', 'json', '--dir', workspace,
      '--session', cliSessionId,
      ...permissionArgs,
      ...(model ? ['--model', model] : []),
      ...(reasoning ? ['--variant', reasoning] : []),
      ...(agent && agent !== 'default' ? ['--agent', agent] : []),
      ...attachments.flatMap((file) => ['--file', file]),
      '--', promptWithAttachments(lastPrompt || 'Continue from where we left off.', attachments),
    ],
  },
}

module.exports = { adapters, promptWithAttachments, codexApprovalPolicy, codexResumePermissionArgs }
