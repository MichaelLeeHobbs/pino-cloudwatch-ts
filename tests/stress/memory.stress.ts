import { describe, it, expect, beforeAll } from '@jest/globals'
import { type CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs'
import { type Transform } from 'node:stream'
import pinoCloudWatch, { type PinoCloudWatchOptions } from '../../src/transport'

// Sustained high-volume memory/throughput harness (regression for issue #9 /
// #36 / #37). NOT part of the default suite or CI — run with:
//   pnpm run test:stress      (which passes node --expose-gc)
//
// Goal: prove memory stays bounded under hundreds of thousands of log lines,
// both when CloudWatch delivery succeeds and when it permanently fails. The
// deterministic bounded-queue / drop-head guarantees are unit-tested in
// tests/unit/Relay.spec.ts; this is the soak test over the real stream path.

const gc = (global as unknown as { gc?: () => void }).gc

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const settle = async (turns = 30): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve))
}

const heapUsedMB = (): number => {
  if (gc) gc()
  return process.memoryUsage().heapUsed / 1024 / 1024
}

/** RSS catches leaks invisible to heapUsed (V8 arenas, off-heap buffers). */
const rssMB = (): number => process.memoryUsage().rss / 1024 / 1024

function makeStream(
  client: CloudWatchLogsClient,
  options: Partial<PinoCloudWatchOptions>
): Transform {
  return pinoCloudWatch({
    logGroupName: 'g',
    logStreamName: 's',
    cloudWatchLogs: client,
    submissionInterval: 1,
    batchSize: 500,
    retryBackoffCap: 0,
    ...options,
  })
}

function writeLine(stream: Transform, i: number): void {
  stream.write(
    `${JSON.stringify({
      level: 30,
      time: 1700000000000,
      msg: `event ${i}`,
      i,
      ctx: { requestId: `req-${i}`, nested: { x: 1, y: 2 } },
    })}\n`
  )
}

// Heap may grow modestly (V8 arenas, JIT) but must NOT scale with line count.
const MAX_HEAP_GROWTH_MB = 60
const MAX_RSS_GROWTH_MB = 300
// The stream's writable buffer must never accumulate the whole backlog: the
// for-await consumer drains into the bounded relay queue, so backpressure stays
// small regardless of N.
const MAX_STREAM_BUFFER_BYTES = 8 * 1024 * 1024

describe('pino transport — sustained memory soak', () => {
  beforeAll(() => {
    if (!gc) {
      console.warn(
        '[stress] global.gc unavailable — heap assertions skipped. Run via `pnpm run test:stress`.'
      )
    }
  })

  it('steady delivery: 100k lines stay memory- and buffer-bounded', async () => {
    const fastClient = {
      send: () => Promise.resolve({}),
      destroy() {},
    } as unknown as CloudWatchLogsClient

    const stream = makeStream(fastClient, { maxQueueSize: 10_000 })

    try {
      const N = 100_000
      const chunk = 1000
      for (let i = 0; i < chunk; i++) writeLine(stream, i)
      await settle()
      const baselineMB = heapUsedMB()
      const baselineRss = rssMB()

      let maxBuffer = 0
      for (let written = 0; written < N; written += chunk) {
        for (let i = 0; i < chunk; i++) writeLine(stream, written + i)
        maxBuffer = Math.max(maxBuffer, stream.writableLength)
        await settle(5)
      }
      const endMB = heapUsedMB()
      const endRss = rssMB()

      expect(maxBuffer).toBeLessThan(MAX_STREAM_BUFFER_BYTES)
      if (gc) expect(endMB - baselineMB).toBeLessThan(MAX_HEAP_GROWTH_MB)
      expect(endRss - baselineRss).toBeLessThan(MAX_RSS_GROWTH_MB)
    } finally {
      stream.destroy()
    }
  })

  it('permanent failure: 100k lines stay memory-bounded (issue #9/#37 at scale)', async () => {
    let sends = 0
    const failingClient = {
      send: () => {
        sends += 1
        return Promise.reject(
          Object.assign(new Error('throttled'), { name: 'ThrottlingException' })
        )
      },
      destroy() {},
    } as unknown as CloudWatchLogsClient

    const stream = makeStream(failingClient, {
      maxQueueSize: 5000,
      maxRetries: 3,
      onError: () => undefined,
    })

    try {
      const N = 100_000
      const chunk = 1000
      for (let i = 0; i < chunk; i++) writeLine(stream, i)
      await settle()
      const baselineMB = heapUsedMB()
      const baselineRss = rssMB()

      let maxBuffer = 0
      for (let written = 0; written < N; written += chunk) {
        for (let i = 0; i < chunk; i++) writeLine(stream, written + i)
        maxBuffer = Math.max(maxBuffer, stream.writableLength)
        await settle(5)
      }
      // Let real time elapse so retries run and head batches drop.
      await sleep(500)
      const endMB = heapUsedMB()
      const endRss = rssMB()

      // Delivery NEVER succeeds, yet the stream never backs up unbounded and
      // memory does not scale with N.
      expect(sends).toBeGreaterThan(0)
      expect(maxBuffer).toBeLessThan(MAX_STREAM_BUFFER_BYTES)
      if (gc) expect(endMB - baselineMB).toBeLessThan(MAX_HEAP_GROWTH_MB)
      expect(endRss - baselineRss).toBeLessThan(MAX_RSS_GROWTH_MB)
    } finally {
      stream.destroy()
    }
  })
})
