export type ActivityDescription = {
  kind: 'read' | 'search' | 'list' | 'edit' | 'delete' | 'test' | 'build' | 'install' | 'git' | 'network' | 'command' | 'tool'
  label: string
  target: string
}

export function describeCommand(value: string): ActivityDescription
export function describeActivity(activity: AgentActivity): ActivityDescription
