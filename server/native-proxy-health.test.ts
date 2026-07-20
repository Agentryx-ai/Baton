import assert from 'node:assert/strict'
import test from 'node:test'

import { NativeProxyHealthTracker } from './native-proxy-health.ts'

test('native proxy health gate measures errors, streams, first byte, and ignores duplicate completion', () => {
  let now = 1_000
  const health = new NativeProxyHealthTracker({
    provider: 'claude', now: () => now, minimumSamples: 2,
    maximumErrorRate: 0.4, maximumStreamFailureRate: 0.4, maximumFirstTokenP95Ms: 100,
  })
  const completed = health.begin()
  completed.headers(true)
  completed.firstByte(1_050)
  completed.firstToken(1_060)
  completed.complete(1_080)
  completed.transportError(1_090)
  now = 2_000
  const failed = health.begin()
  failed.headers(true)
  failed.firstByte(2_150)
  failed.firstToken(2_180)
  failed.streamError(2_200)

  assert.deepEqual(health.snapshot(), {
    provider: 'claude', windowMs: 86_400_000, sampleCount: 2, cancelledCount: 0,
    errorRate: 0.5, streamFailureRate: 0.5, firstByteP95Ms: 150, firstTokenP95Ms: 180,
    gate: 'degraded', reasons: ['error_rate', 'stream_failure_rate', 'first_token_p95'],
  })
})

test('native proxy health observes Claude and Codex token deltas without changing bytes', async () => {
  for (const [provider, block] of [
    ['claude', 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n'],
    ['codex', 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n'],
  ] as const) {
    let now = 1_000
    const health = new NativeProxyHealthTracker({ provider, now: () => now, minimumSamples: 1 })
    const request = health.begin()
    request.headers(true)
    const observer = request.streamObserver(() => now)
    let output = ''
    observer.on('data', (chunk) => { output += chunk.toString() })
    observer.write(block)
    now = 1_050
    observer.end('data: [DONE]\n\n')
    await new Promise<void>((resolve) => observer.once('end', resolve))
    request.complete(now)
    assert.match(output, /"delta"/)
    assert.equal(health.snapshot().firstTokenP95Ms, 0)
  }
})

test('native proxy health gate prunes expired samples and requires enough current data', () => {
  let now = 0
  const health = new NativeProxyHealthTracker({ provider: 'codex', now: () => now, windowMs: 100, minimumSamples: 1 })
  health.begin().transportError(10)
  now = 111
  assert.equal(health.snapshot().sampleCount, 0)
  assert.equal(health.snapshot().gate, 'insufficient_data')
})

test('client cancellation never masks native proxy health failures', () => {
  const health = new NativeProxyHealthTracker({ provider: 'claude', minimumSamples: 1 })
  health.begin().cancelled()
  health.begin().transportError()
  const snapshot = health.snapshot()
  assert.equal(snapshot.sampleCount, 1)
  assert.equal(snapshot.cancelledCount, 1)
  assert.equal(snapshot.errorRate, 1)
  assert.equal(snapshot.gate, 'degraded')
})
