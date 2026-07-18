export type ComposerKeyAction = 'submit' | 'newline' | 'ignore'

interface ComposerKeyInput {
  key: string
  shiftKey: boolean
  isComposing?: boolean
  keyCode?: number
}

export function composerKeyAction(input: ComposerKeyInput): ComposerKeyAction {
  if (input.key !== 'Enter') return 'ignore'
  if (input.isComposing || input.keyCode === 229) return 'ignore'
  return input.shiftKey ? 'newline' : 'submit'
}
