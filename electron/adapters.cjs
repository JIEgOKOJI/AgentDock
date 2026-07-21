const IMAGE_FILE_PATTERN = /\.(?:png|jpe?g|gif|webp)$/i

function promptWithAttachments(prompt, attachments = []) {
  if (!attachments.length) return prompt
  return `${prompt}\n\n<agentdock_attachments>\nThe user attached the following local files. Open and inspect them before answering; do not claim that no file was provided.\n${attachments.map((file) => `- ${file}`).join('\n')}\n</agentdock_attachments>`
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
  },
  claude: {
    executable: 'claude',
    buildArgs: ({ model, reasoning, prompt, attachments = [], permissionArgs = [] }) => [
      '--print', '--output-format', 'stream-json', '--verbose',
      ...permissionArgs,
      ...(model ? ['--model', model] : []),
      ...(reasoning ? ['--effort', reasoning] : []),
      promptWithAttachments(prompt, attachments),
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
  },
}

module.exports = { adapters, promptWithAttachments }
