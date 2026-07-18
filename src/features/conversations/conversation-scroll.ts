export interface ScrollMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export function isNearScrollBottom(metrics: ScrollMetrics, threshold = 96): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
}
