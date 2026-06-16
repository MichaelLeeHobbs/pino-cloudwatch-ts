import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { once } from 'node:events'
import { type Transform } from 'node:stream'
import { mockClient } from 'aws-sdk-client-mock'
import {
  CloudWatchLogsClient,
  PutLogEventsCommand,
  type InputLogEvent,
} from '@aws-sdk/client-cloudwatch-logs'
import pinoCloudWatch, { type PinoCloudWatchOptions } from '../../src/transport'
import { MAX_BATCH_BYTES } from '../../src/CloudWatchClient'
import { EVENT_OVERHEAD_BYTES } from '../../src/CloudWatchEventFormatter'

// Deep, end-to-end behavioral tests that drive real NDJSON through the full
// transport → relay → client pipeline (not just the backend units), to prove
// the AWS-limit / formatting / ordering invariants hold through the new pino
// front-end — closing the "covered only indirectly" gaps.

const cwMock = mockClient(CloudWatchLogsClient)

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function putCalls(): { logEvents: InputLogEvent[] }[] {
  return cwMock.commandCalls(PutLogEventsCommand).map(call => ({
    logEvents: call.args[0].input.logEvents ?? [],
  }))
}

function allEvents(): InputLogEvent[] {
  return putCalls().flatMap(call => call.logEvents)
}

function messages(): string[] {
  return allEvents().map(event => event.message ?? '')
}

const streams: Transform[] = []

function createTransport(options: Partial<PinoCloudWatchOptions>): Transform {
  const stream = pinoCloudWatch({
    logGroupName: 'g',
    logStreamName: 's',
    submissionInterval: 20,
    retryBackoffCap: 0,
    onError: () => undefined,
    ...options,
  })
  streams.push(stream)
  return stream
}

function writeLine(stream: Transform, raw: string): void {
  stream.write(`${raw}\n`)
}

function writeLog(stream: Transform, obj: Record<string, unknown>): void {
  writeLine(stream, JSON.stringify(obj))
}

beforeEach(() => {
  cwMock.reset()
  cwMock.onAnyCommand().resolves({})
})

afterEach(async () => {
  for (const stream of streams.splice(0)) {
    if (!stream.destroyed) {
      stream.end()
      await once(stream, 'close').catch(() => undefined)
    }
  }
})

describe('transport — byte-limit batch splitting', () => {
  it('never exceeds the 1 MB PutLogEvents limit and delivers every event', async () => {
    // 40 events × ~30 KB ≈ 1.2 MB — cannot fit in a single ≤1 MB request, so
    // splitByByteLimit must fan it across multiple PutLogEvents calls.
    const big = 'x'.repeat(30_000)
    const stream = createTransport({ batchSize: 100, submissionInterval: 10 })
    const N = 40
    for (let i = 0; i < N; i++) writeLog(stream, { level: 30, time: 1, msg: `${big}-${i}` })

    await waitUntil(() => allEvents().length === N)
    const calls = putCalls()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const call of calls) {
      const bytes = call.logEvents.reduce(
        (sum, e) => sum + Buffer.byteLength(e.message ?? '', 'utf8') + EVENT_OVERHEAD_BYTES,
        0
      )
      expect(bytes).toBeLessThanOrEqual(MAX_BATCH_BYTES)
    }
  })
})

describe('transport — UTF-8-safe truncation end-to-end', () => {
  it('truncates an oversized multi-byte message without splitting a code point', async () => {
    const maxEventSize = 100 // usable payload = 100 - 26 = 74 bytes
    const stream = createTransport({ maxEventSize })
    writeLog(stream, { level: 30, msg: '🚀'.repeat(40) }) // 4 bytes each → 160 bytes

    await waitUntil(() => messages().length > 0)
    const message = messages()[0]!
    expect(message.endsWith('...[truncated]')).toBe(true)
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(
      maxEventSize - EVENT_OVERHEAD_BYTES
    )
    // No U+FFFD replacement char → no multi-byte code point was cut in half.
    expect(message).not.toContain('�')
    expect(message.startsWith('[INFO] 🚀')).toBe(true)
  })
})

describe('transport — levelLabels merge semantics', () => {
  it('overrides built-in levels, adds custom ones, and preserves un-overridden defaults', async () => {
    const stream = createTransport({ levelLabels: { 30: 'information', 35: 'notice' } })
    writeLog(stream, { level: 30, msg: 'a' }) // overridden default
    writeLog(stream, { level: 35, msg: 'b' }) // added custom
    writeLog(stream, { level: 50, msg: 'c' }) // un-overridden default

    await waitUntil(() => messages().length >= 3)
    const joined = messages().join('\n')
    expect(joined).toContain('[INFORMATION] a')
    expect(joined).toContain('[NOTICE] b')
    expect(joined).toContain('[ERROR] c')
  })
})

describe('transport — custom formatter function options (in-process)', () => {
  it('uses formatLog for the message', async () => {
    const stream = createTransport({
      formatLog: item => `CUSTOM:${item.level}:${item.message}`,
    })
    writeLog(stream, { level: 30, msg: 'hi' })

    await waitUntil(() => messages().length > 0)
    expect(messages()[0]).toBe('CUSTOM:info:hi')
  })

  it('uses formatLogItem for both message and timestamp', async () => {
    const stream = createTransport({
      formatLogItem: item => ({ message: `MI:${item.message}`, timestamp: 424242 }),
    })
    writeLog(stream, { level: 30, time: 1, msg: 'hi' })

    await waitUntil(() => allEvents().length > 0)
    const event = allEvents()[0]!
    expect(event.message).toBe('MI:hi')
    expect(event.timestamp).toBe(424242)
  })
})

describe('transport — event ordering', () => {
  it('emits each PutLogEvents batch sorted by timestamp', async () => {
    const stream = createTransport({ batchSize: 20, submissionInterval: 10 })
    writeLog(stream, { level: 30, time: 300, msg: 'third' })
    writeLog(stream, { level: 30, time: 100, msg: 'first' })
    writeLog(stream, { level: 30, time: 200, msg: 'second' })

    await waitUntil(() => allEvents().length === 3)
    // Each batch the client submits is timestamp-ascending (sort before split).
    for (const call of putCalls()) {
      const stamps = call.logEvents.map(e => e.timestamp ?? 0)
      const sorted = [...stamps].sort((a, b) => a - b)
      expect(stamps).toEqual(sorted)
    }
  })
})

describe('transport — non-object log lines', () => {
  it('wraps a primitive line into a data field (pino-abstract-transport contract)', async () => {
    const stream = createTransport({})
    writeLine(stream, '42') // bare number → { data: 42, time: <now> }

    await waitUntil(() => messages().length > 0)
    // No level/msg → "[] "; the primitive is preserved under `data`.
    expect(messages()[0]).toContain('[] ')
    expect(messages()[0]).toContain('"data": 42')
  })
})
