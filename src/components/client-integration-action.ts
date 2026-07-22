import type { ClientIntegrationTargetStatus } from '../api/types.ts'

export interface ClientIntegrationAction {
  actionable: boolean
  label: string
}

export function clientIntegrationAction(
  status: ClientIntegrationTargetStatus | undefined,
): ClientIntegrationAction {
  if (!status) return { actionable: false, label: '확인 중…' }
  const actionable = status.certainlyStopped
  if (status.configuration === 'applied') {
    return { actionable, label: actionable ? '설정 해제' : '종료 후 해제' }
  }
  if (status.configuration === 'not-applied') {
    return { actionable, label: actionable ? '설정 적용' : '종료 후 적용' }
  }
  if (
    status.target === 'codex'
    && status.configuration === 'conflict'
    && status.repairable === true
  ) {
    return { actionable, label: actionable ? '설정 복구' : '종료 후 복구' }
  }
  return { actionable: false, label: '조치 불가' }
}
