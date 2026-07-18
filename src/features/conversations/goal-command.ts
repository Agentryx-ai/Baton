export type GoalComposerCommand =
  | { type: 'open' }
  | { type: 'set'; objective: string }
  | { type: 'edit' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'clear' }

const CONTROL_COMMANDS = new Set(['edit', 'pause', 'resume', 'clear'])

export function parseGoalComposerCommand(input: string): GoalComposerCommand | null {
  if (!input.startsWith('/goal')) return null
  const suffix = input.slice('/goal'.length)
  if (suffix.length === 0) return { type: 'open' }
  if (!/^\s/u.test(suffix)) return null

  const argument = suffix.trim()
  if (!argument) return { type: 'open' }
  const normalized = argument.toLocaleLowerCase('en-US')
  if (CONTROL_COMMANDS.has(normalized)) {
    return { type: normalized as 'edit' | 'pause' | 'resume' | 'clear' }
  }
  return { type: 'set', objective: argument }
}
