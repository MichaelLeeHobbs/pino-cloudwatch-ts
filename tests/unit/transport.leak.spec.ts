import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { type Transform } from 'node:stream'
import { mockClient } from 'aws-sdk-client-mock'
import { CloudWatchLogsClient, PutLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import pinoCloudWatch, { type PinoCloudWatchOptions } from '../../src/transport'

// Deterministic regression for the lineage's signature bug: a persistent
// CloudWatch delivery failure must NEVER stall the inbound pino stream or grow
// memory unbounded (issue #9 / #36 / #37). The sibling Winston transport guards
// this in CloudWatchTransport.log() (resolve the write callback immediately).
// The pino front-end has no per-line callback to mis-couple — `consumeSource`
// calls the synchronous, non-blocking `relay.submit()` — so this suite proves
// the protection holds for the NEW front-end, in the default (CI) suite, not
// only in the excluded memory soak.

const cwMock = mockClient(CloudWatchLogsClient)

async function tick(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const streams: Transform[] = []

function createTransport(options: Partial<PinoCloudWatchOptions>): Transform {
  const stream = pinoCloudWatch({
    logGroupName: 'g',
    logStreamName: 's',
    onError: () => undefined,
    ...options,
  })
  streams.push(stream)
  return stream
}

function writeLog(stream: Transform, obj: Record<string, unknown>): void {
  stream.write(`${JSON.stringify(obj)}\n`)
}

beforeEach(() => {
  cwMock.reset()
  cwMock.onAnyCommand().resolves({})
})

afterEach(() => {
  // Destroy synchronously WITHOUT awaiting 'close': a permanently-stuck send
  // would otherwise hold close()'s flush open for the full flush timeout. The
  // residual flush timer is unref'd, so it never keeps the process alive.
  for (const stream of streams.splice(0)) {
    if (!stream.destroyed) stream.destroy()
  }
})

describe('pino transport — bounded memory / no head-of-line stall (issue #9)', () => {
  it('does not stall the inbound stream when delivery is permanently stuck', async () => {
    // PutLogEvents that never settles: the first batch is in-flight forever.
    cwMock.on(PutLogEventsCommand).callsFake(() => new Promise(() => undefined))
    const stream = createTransport({
      submissionInterval: 5,
      batchSize: 10,
      maxQueueSize: 100,
    })

    let maxBuffer = 0
    const N = 5000
    for (let i = 0; i < N; i++) {
      writeLog(stream, { level: 30, time: 1, msg: `event ${i}` })
      if (i % 250 === 0) {
        await tick()
        maxBuffer = Math.max(maxBuffer, stream.writableLength)
      }
    }
    await tick()
    maxBuffer = Math.max(maxBuffer, stream.writableLength)

    // The for-await consumer keeps draining into the bounded relay queue
    // (maxQueueSize=100, oldest-dropped), so the stream's writable buffer never
    // accumulates the 5000-line backlog. A coupled/blocking design would pin
    // the whole backlog here and eventually OOM.
    expect(maxBuffer).toBeLessThan(64 * 1024)
    expect(stream.writable).toBe(true)
  })

  it('drops an undeliverable head batch after maxRetries so newer logs still ship', async () => {
    const err = Object.assign(new Error('throttled'), { name: 'ThrottlingException' })
    const delivered: string[] = []
    let attempt = 0
    // Record only SUCCESSFUL deliveries (commandCalls would also count the two
    // rejected attempts of the doomed batch). Head batch fails twice → dropped
    // at maxRetries=2; everything after succeeds.
    cwMock.on(PutLogEventsCommand).callsFake((input: { logEvents?: { message?: string }[] }) => {
      attempt += 1
      if (attempt <= 2) return Promise.reject(err)
      for (const event of input.logEvents ?? []) delivered.push(event.message ?? '')
      return Promise.resolve({})
    })
    const stream = createTransport({
      submissionInterval: 10,
      batchSize: 1,
      maxRetries: 2,
      retryBackoffCap: 0,
    })

    writeLog(stream, { level: 30, msg: 'DOOMED' }) // attempted 2x, then dropped
    writeLog(stream, { level: 30, msg: 'survivor-1' })
    writeLog(stream, { level: 30, msg: 'survivor-2' })

    await waitUntil(() => delivered.some(m => m.includes('survivor-2')))
    const joined = delivered.join('\n')
    // The undeliverable head batch never head-of-line blocks newer logs, and
    // the dropped batch is never successfully delivered.
    expect(joined).toContain('survivor-1')
    expect(joined).toContain('survivor-2')
    expect(joined).not.toContain('DOOMED')
  })
})
