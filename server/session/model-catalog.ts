import type { CanonicalProvider } from './domain.ts'

export interface ProviderModelDescriptor {
  id: string
  displayName: string
  description: string
  effortLevels: string[]
  defaultEffort: string | null
}

export interface ProviderModelCatalog {
  provider: CanonicalProvider
  models: ProviderModelDescriptor[]
  defaultModel: string | null
}

const CLAUDE_ORDER = ['fable', 'opus', 'sonnet', 'haiku'] as const

export function buildProviderModelCatalog(
  provider: CanonicalProvider,
  availableModels: string[],
  configuredDefault: string | null = null,
): ProviderModelCatalog {
  const unique = [...new Set(availableModels)]
  const models = provider === 'claude'
    ? claudeModels(unique)
    : provider === 'gemini'
      ? geminiModels(unique)
      : codexModels(unique)
  return {
    provider,
    models,
    defaultModel: configuredDefault && models.some((model) => model.id === configuredDefault)
      ? configuredDefault
      : models[0]?.id ?? null,
  }
}

function claudeModels(models: string[]): ProviderModelDescriptor[] {
  return CLAUDE_ORDER.flatMap((family): ProviderModelDescriptor[] => {
      const id = models
        .filter((candidate) => candidate.startsWith('claude-') && candidate.includes(`-${family}-`))
        .sort(newestClaudeFirst)[0]
      if (!id) return []
      const supportsEffort = family !== 'haiku'
      return [{
        id,
        displayName: friendlyClaudeName(id),
        description: family === 'fable'
          ? '가장 어려운 작업'
          : family === 'opus'
            ? '복잡한 작업'
            : family === 'sonnet'
              ? '일상 작업'
              : '빠른 응답',
        effortLevels: supportsEffort ? ['low', 'medium', 'high', 'max'] : [],
        defaultEffort: supportsEffort ? 'high' : null,
      }]
    })
}

function codexModels(models: string[]): ProviderModelDescriptor[] {
  return models
    .filter((id) => id.startsWith('gpt-') && !id.startsWith('gpt-image-'))
    .sort((left, right) => codexRank(left) - codexRank(right) || newestFirst(left, right))
    .map((id) => ({
      id,
      displayName: friendlyModelName(id),
      description: id.includes('-sol')
        ? '깊은 작업'
        : id.includes('-terra')
          ? '균형 잡힌 기본 모델'
          : id.includes('-luna')
            ? '빠른 작업'
            : 'Codex 모델',
      effortLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high',
    }))
}

function geminiModels(models: string[]): ProviderModelDescriptor[] {
  return models
    .filter((id) => id.startsWith('gemini-'))
    .sort((left, right) => geminiRank(left) - geminiRank(right) || newestFirst(left, right))
    .map((id) => ({
      id,
      displayName: friendlyModelName(id),
      description: id.includes('flash-lite')
        ? '가장 빠른 응답'
        : id.includes('flash')
          ? '일상 작업'
          : id.includes('pro')
            ? '고급 수학 및 코딩'
            : id.includes('thinking')
              ? '복잡한 문제 해결'
              : 'Gemini 모델',
      effortLevels: [],
      defaultEffort: null,
    }))
}

function codexRank(id: string): number {
  if (id === 'gpt-5.6-sol') return 0
  if (id === 'gpt-5.6-terra') return 1
  if (id === 'gpt-5.6-luna') return 2
  if (id.startsWith('gpt-5.5')) return 3
  if (id === 'gpt-5.4') return 4
  if (id.includes('mini')) return 5
  if (id.includes('spark')) return 6
  return 7
}

function geminiRank(id: string): number {
  if (id.includes('flash-lite')) return 0
  if (id.includes('flash')) return 1
  if (id.includes('pro')) return 2
  if (id.includes('thinking')) return 3
  return 4
}

function friendlyClaudeName(id: string): string {
  const match = /^claude-(fable|opus|sonnet|haiku)-(.+?)(?:-\d{8})?$/.exec(id)
  if (!match) return friendlyModelName(id)
  return `${capitalize(match[1])} ${match[2].replaceAll('-', '.')}`
}

function friendlyModelName(id: string): string {
  return id.split('-').map((part) => /^(gpt|ai)$/i.test(part)
    ? part.toUpperCase()
    : capitalize(part)).join(' ')
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

function newestFirst(left: string, right: string): number {
  return right.localeCompare(left, 'en', { numeric: true, sensitivity: 'base' })
}

function newestClaudeFirst(left: string, right: string): number {
  const leftParts = claudeVersion(left)
  const rightParts = claudeVersion(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return newestFirst(left, right)
}

function claudeVersion(id: string): number[] {
  const withoutDate = id.replace(/-\d{8}$/, '')
  const family = CLAUDE_ORDER.find((candidate) => withoutDate.includes(`-${candidate}-`))
  const version = family ? withoutDate.split(`-${family}-`, 2)[1] : withoutDate
  return (version.match(/\d+/g) ?? []).map(Number)
}
