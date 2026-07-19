export type GoalViewStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usage_limited'
  | 'budget_limited'
  | 'complete'

export type GoalStatusTone = 'active' | 'muted' | 'warning' | 'success'

export interface GoalViewReason {
  code: string
  source: 'user' | 'host' | 'provider' | 'model'
  message: string | null
  at: string
}

export interface GoalView {
  id: string
  objective: string
  status: GoalViewStatus
  statusReason: GoalViewReason | null
  timeUsedSeconds: number
  automaticTurnsUsed: number
  maxAutomaticTurns: number
  tokensUsed: number
  tokenBudget: number | null
}

export interface GoalStatusPresentation {
  label: string
  tone: GoalStatusTone
}

export type GoalWorkStatus = 'awaiting_goal_turn' | 'queued' | 'running' | 'waiting_tool'

const STATUS_PRESENTATION: Record<GoalViewStatus, GoalStatusPresentation> = {
  active: { label: '진행 중', tone: 'active' },
  paused: { label: '일시 정지', tone: 'muted' },
  blocked: { label: '확인 필요', tone: 'warning' },
  usage_limited: { label: '사용량 제한', tone: 'warning' },
  budget_limited: { label: '예산 제한', tone: 'warning' },
  complete: { label: '완료', tone: 'success' },
}

const REASON_LABELS: Readonly<Record<string, string>> = {
  no_progress: '진전이 없어 멈췄습니다.',
  provider_failure: '실행 중 오류가 발생했습니다.',
  context_input_too_large: '선택한 모델의 입력 한도를 초과했고 자동 압축을 완료하지 못했습니다.',
  provider_usage_limit: '사용 가능한 계정의 사용량 제한에 도달했습니다.',
  goal_turn_limit: '자동 실행 횟수 제한에 도달했습니다.',
  goal_time_limit: '활성 시간 제한에 도달했습니다.',
  goal_token_limit: '토큰 예산에 도달했습니다.',
  runtime_interrupted: '실행이 중단되어 확인이 필요합니다.',
  unknown_mutation_outcome: '변경 작업의 결과를 확인해야 합니다.',
  user_paused: '사용자가 일시 정지했습니다.',
}

const integerFormatter = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 })

const ACTIVE_WORK_PRESENTATION: Record<GoalWorkStatus, GoalStatusPresentation> = {
  awaiting_goal_turn: { label: '다음 작업 준비 중', tone: 'active' },
  queued: { label: '대기 중', tone: 'active' },
  running: { label: '진행 중', tone: 'active' },
  waiting_tool: { label: '도구 실행 중', tone: 'active' },
}

export function goalStatusPresentation(
  status: GoalViewStatus,
  workStatus?: GoalWorkStatus,
): GoalStatusPresentation {
  if (status === 'active' && workStatus) return ACTIVE_WORK_PRESENTATION[workStatus]
  return STATUS_PRESENTATION[status]
}

export function formatGoalDuration(totalSeconds: number): string {
  const seconds = safeCount(totalSeconds)
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60

  if (hours > 0) return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`
  if (minutes > 0) return remainder > 0 ? `${minutes}분 ${remainder}초` : `${minutes}분`
  return `${remainder}초`
}

export function formatGoalTurns(used: number, maximum: number): string {
  return `${integerFormatter.format(safeCount(used))} / ${integerFormatter.format(safeCount(maximum))}회`
}

export function goalRemainingTokens(tokensUsed: number, tokenBudget: number | null): number | null {
  if (tokenBudget === null) return null
  return Math.max(0, safeCount(tokenBudget) - safeCount(tokensUsed))
}

export function formatGoalTokens(tokensUsed: number, tokenBudget: number | null): string {
  const used = integerFormatter.format(safeCount(tokensUsed))
  const remaining = goalRemainingTokens(tokensUsed, tokenBudget)
  if (remaining === null) return `${used} 토큰 · 예산 없음`
  return `${used} 토큰 · ${integerFormatter.format(remaining)} 남음`
}

export function formatGoalReason(reason: GoalViewReason | null): string | null {
  if (!reason) return null
  const message = reason.message?.trim()
  if (reason.code === 'context_input_too_large' || isLegacyContextLimitMessage(message)) {
    return formatContextLimitReason(message)
  }
  if (message) return message
  return REASON_LABELS[reason.code] ?? '계속하려면 상태를 확인해 주세요.'
}

function isLegacyContextLimitMessage(message: string | undefined): boolean {
  return message?.startsWith('Upcoming input requires approximately ') ?? false
}

function formatContextLimitReason(message: string | undefined): string {
  if (!message) return REASON_LABELS.context_input_too_large!
  const match = message.match(
    /Upcoming input requires approximately ([\d,]+) tokens; usable input budget is ([\d,]+)(?: for ([^(;]+))?/,
  )
  if (!match) return REASON_LABELS.context_input_too_large!
  const required = formatTokenCount(match[1])
  const budget = formatTokenCount(match[2])
  const model = match[3]?.trim()
  const subject = model ? `${model}의 입력 한도` : '선택한 모델의 입력 한도'
  return `대화 컨텍스트가 ${subject}를 초과했습니다(약 ${required} / ${budget} 토큰). 자동 압축을 완료하지 못해 작업을 멈췄습니다.`
}

function formatTokenCount(value: string | undefined): string {
  const parsed = Number(value?.replaceAll(',', ''))
  return Number.isFinite(parsed) ? integerFormatter.format(parsed) : value ?? '0'
}

function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}
