import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

export type NativeProxyProvider = 'claude' | 'codex'

interface NativeProxySample {
  at: number
  durationMs: number
  firstByteMs: number | null
  firstTokenMs: number | null
  streaming: boolean
  outcome: 'completed' | 'transport_error' | 'stream_error' | 'cancelled'
}

export interface NativeProxyHealthSnapshot {
  provider: NativeProxyProvider
  windowMs: number
  sampleCount: number
  cancelledCount: number
  errorRate: number
  streamFailureRate: number
  firstByteP95Ms: number | null
  firstTokenP95Ms: number | null
  gate: 'insufficient_data' | 'healthy' | 'degraded'
  reasons: string[]
}

export class NativeProxyHealthTracker {
  readonly #provider: NativeProxyProvider
  readonly #now: () => number
  readonly #windowMs: number
  readonly #minimumSamples: number
  readonly #maximumErrorRate: number
  readonly #maximumStreamFailureRate: number
  readonly #maximumFirstTokenP95Ms: number
  #samples: NativeProxySample[] = []

  constructor(options: {
    provider: NativeProxyProvider
    now?: () => number
    windowMs?: number
    minimumSamples?: number
    maximumErrorRate?: number
    maximumStreamFailureRate?: number
    maximumFirstTokenP95Ms?: number
  }) {
    this.#provider = options.provider
    this.#now = options.now ?? Date.now
    this.#windowMs = options.windowMs ?? 24 * 60 * 60_000
    this.#minimumSamples = options.minimumSamples ?? 20
    this.#maximumErrorRate = options.maximumErrorRate ?? 0.1
    this.#maximumStreamFailureRate = options.maximumStreamFailureRate ?? 0.05
    this.#maximumFirstTokenP95Ms = options.maximumFirstTokenP95Ms ?? 30_000
  }

  begin(): NativeProxyRequestHealth {
    return new NativeProxyRequestHealth(this, this.#now())
  }

  record(sample: NativeProxySample): void {
    this.#samples.push(sample)
    this.#prune()
  }

  snapshot(): NativeProxyHealthSnapshot {
    this.#prune()
    const cancelledCount = this.#samples.filter((sample) => sample.outcome === 'cancelled').length
    const samples = this.#samples.filter((sample) => sample.outcome !== 'cancelled')
    const errors = samples.filter((sample) => (
      sample.outcome === 'transport_error' || sample.outcome === 'stream_error'
    )).length
    const streams = samples.filter((sample) => sample.streaming)
    const streamFailures = streams.filter((sample) => sample.outcome === 'stream_error').length
    const firstBytes = samples.flatMap((sample) => sample.firstByteMs === null ? [] : [sample.firstByteMs])
      .sort((left, right) => left - right)
    const firstByteP95Ms = firstBytes.length === 0
      ? null
      : firstBytes[Math.ceil(firstBytes.length * 0.95) - 1] ?? null
    const firstTokens = samples.flatMap((sample) => sample.firstTokenMs === null ? [] : [sample.firstTokenMs])
      .sort((left, right) => left - right)
    const firstTokenP95Ms = firstTokens.length === 0
      ? null
      : firstTokens[Math.ceil(firstTokens.length * 0.95) - 1] ?? null
    const errorRate = samples.length === 0 ? 0 : errors / samples.length
    const streamFailureRate = streams.length === 0 ? 0 : streamFailures / streams.length
    const reasons: string[] = []
    if (errorRate > this.#maximumErrorRate) reasons.push('error_rate')
    if (streamFailureRate > this.#maximumStreamFailureRate) reasons.push('stream_failure_rate')
    if (firstTokenP95Ms !== null && firstTokenP95Ms > this.#maximumFirstTokenP95Ms) reasons.push('first_token_p95')
    return {
      provider: this.#provider,
      windowMs: this.#windowMs,
      sampleCount: samples.length,
      cancelledCount,
      errorRate,
      streamFailureRate,
      firstByteP95Ms,
      firstTokenP95Ms,
      gate: samples.length < this.#minimumSamples
        ? 'insufficient_data'
        : reasons.length > 0 ? 'degraded' : 'healthy',
      reasons,
    }
  }

  #prune(): void {
    const cutoff = this.#now() - this.#windowMs
    const firstCurrent = this.#samples.findIndex((sample) => sample.at >= cutoff)
    if (firstCurrent < 0) this.#samples = []
    else if (firstCurrent > 0) this.#samples.splice(0, firstCurrent)
  }
}

export class NativeProxyRequestHealth {
  readonly #tracker: NativeProxyHealthTracker
  readonly #startedAt: number
  #firstByteAt: number | null = null
  #firstTokenAt: number | null = null
  #streaming = false
  #finished = false

  constructor(tracker: NativeProxyHealthTracker, startedAt: number) {
    this.#tracker = tracker
    this.#startedAt = startedAt
  }

  headers(streaming: boolean): void { this.#streaming = streaming }

  firstByte(now = Date.now()): void {
    if (this.#firstByteAt === null) this.#firstByteAt = now
  }

  firstToken(now = Date.now()): void {
    if (this.#firstTokenAt === null) this.#firstTokenAt = now
  }

  streamObserver(now: () => number = Date.now): Transform {
    const decoder = new StringDecoder('utf8')
    let pending = ''
    const inspect = (block: string) => {
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!data || data === '[DONE]') return
      try {
        const payload = JSON.parse(data) as Record<string, unknown>
        const type = payload.type
        const delta = payload.delta
        const token = typeof delta === 'string'
          ? delta
          : delta && typeof delta === 'object'
            ? ((delta as Record<string, unknown>).text ?? (delta as Record<string, unknown>).thinking)
            : undefined
        if (
          (type === 'content_block_delta'
            || type === 'response.output_text.delta'
            || type === 'response.reasoning_summary_text.delta')
          && typeof token === 'string'
          && token.length > 0
        ) this.firstToken(now())
      } catch { /* byte-preserving observer ignores malformed SSE */ }
    }
    return new Transform({
      transform: (chunk, _encoding, callback) => {
        this.firstByte(now())
        const blocks = (pending + decoder.write(chunk)).split(/\r?\n\r?\n/)
        pending = blocks.pop() ?? ''
        for (const block of blocks) inspect(block)
        callback(null, chunk)
      },
      flush: (callback) => {
        const tail = pending + decoder.end()
        if (tail) inspect(tail)
        callback()
      },
    })
  }

  complete(now = Date.now()): void { this.#finish('completed', now) }
  transportError(now = Date.now()): void { this.#finish('transport_error', now) }
  streamError(now = Date.now()): void { this.#finish('stream_error', now) }
  cancelled(now = Date.now()): void { this.#finish('cancelled', now) }
  discard(): void { this.#finished = true }

  #finish(outcome: NativeProxySample['outcome'], now: number): void {
    if (this.#finished) return
    this.#finished = true
    this.#tracker.record({
      at: now,
      durationMs: Math.max(0, now - this.#startedAt),
      firstByteMs: this.#firstByteAt === null ? null : Math.max(0, this.#firstByteAt - this.#startedAt),
      firstTokenMs: this.#firstTokenAt === null ? null : Math.max(0, this.#firstTokenAt - this.#startedAt),
      streaming: this.#streaming,
      outcome,
    })
  }
}
