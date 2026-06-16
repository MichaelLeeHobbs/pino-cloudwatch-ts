import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { once } from 'node:events'
import os from 'node:os'
import { type Transform } from 'node:stream'
import { mockClient } from 'aws-sdk-client-mock'
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs'
import pinoCloudWatch, { type PinoCloudWatchOptions } from '../../src/transport'

const cwMock = mockClient(CloudWatchLogsClient)

// Real timers only (Bottleneck minTime is wall-clock); poll for async delivery.
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const streams: Transform[] = []

function createTransport(options: Partial<PinoCloudWatchOptions> = {}): Transform {
  const stream = pinoCloudWatch({
    logGroupName: 'test-group',
    logStreamName: 'test-stream',
    submissionInterval: 50,
    retryBackoffCap: 0,
    ...options,
  })
  streams.push(stream)
  return stream
}

function writeLog(stream: Transform, obj: Record<string, unknown>): void {
  stream.write(`${JSON.stringify(obj)}\n`)
}

function putEventMessages(): string[] {
  return cwMock
    .commandCalls(PutLogEventsCommand)
    .flatMap(call => (call.args[0].input.logEvents ?? []).map(e => e.message ?? ''))
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

describe('pino-cloudwatch transport', () => {
  it('delivers a pino log line to CloudWatch as a formatted event', async () => {
    const stream = createTransport()
    writeLog(stream, { level: 30, time: 1700000000000, msg: 'hello', userId: 7 })

    await waitUntil(() => cwMock.commandCalls(PutLogEventsCommand).length > 0)
    const messages = putEventMessages()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('[INFO] hello')
    expect(messages[0]).toContain('"userId":7')
  })

  it('maps numeric levels to labels and passes string levels through', async () => {
    const stream = createTransport()
    writeLog(stream, { level: 50, msg: 'a' })
    writeLog(stream, { level: 'warn', msg: 'b' })
    writeLog(stream, { level: 99, msg: 'c' }) // unknown numeric level → stringified

    await waitUntil(() => putEventMessages().length >= 3)
    const joined = putEventMessages().join('\n')
    expect(joined).toContain('[ERROR] a')
    expect(joined).toContain('[WARN] b')
    expect(joined).toContain('[99] c')
  })

  it('falls back to safe defaults for missing level/msg', async () => {
    const stream = createTransport()
    writeLog(stream, { foo: 'bar' }) // no level, no msg, no time

    await waitUntil(() => putEventMessages().length > 0)
    expect(putEventMessages()[0]).toContain('[] ')
    expect(putEventMessages()[0]).toContain('"foo":"bar"')
  })

  it('supports custom level-label overrides', async () => {
    const stream = createTransport({ levelLabels: { 35: 'notice' } })
    writeLog(stream, { level: 35, msg: 'x' })

    await waitUntil(() => putEventMessages().length > 0)
    expect(putEventMessages()[0]).toContain('[NOTICE] x')
  })

  it('supports jsonMessage formatting', async () => {
    const stream = createTransport({ jsonMessage: true })
    writeLog(stream, { level: 30, time: 123, msg: 'hi', a: 1 })

    await waitUntil(() => putEventMessages().length > 0)
    const parsed = JSON.parse(putEventMessages()[0]!) as Record<string, unknown>
    expect(parsed).toMatchObject({ level: 'info', message: 'hi', a: 1 })
  })

  it('auto-creates the log group and stream when requested', async () => {
    const stream = createTransport({ createLogGroup: true, createLogStream: true })
    writeLog(stream, { level: 30, msg: 'hi' })

    await waitUntil(() => cwMock.commandCalls(PutLogEventsCommand).length > 0)
    expect(cwMock.commandCalls(CreateLogGroupCommand)).toHaveLength(1)
    expect(cwMock.commandCalls(CreateLogStreamCommand)).toHaveLength(1)
  })

  describe('stream-name resolution', () => {
    it('defaults to "<hostname>-<pid>" when undefined or empty', async () => {
      for (const logStreamName of [undefined, '']) {
        cwMock.reset()
        cwMock.onAnyCommand().resolves({})
        const stream = createTransport({ logStreamName })
        writeLog(stream, { level: 30, msg: 'hi' })

        await waitUntil(() => cwMock.commandCalls(PutLogEventsCommand).length > 0)
        const input = cwMock.commandCalls(PutLogEventsCommand)[0]!.args[0].input
        expect(input.logStreamName).toBe(`${os.hostname()}-${process.pid}`)
      }
    })

    it('resolves {hostname}, {pid} and {time} tokens', async () => {
      const stream = createTransport({ logStreamName: '{hostname}/{pid}/{time}' })
      writeLog(stream, { level: 30, msg: 'hi' })

      await waitUntil(() => cwMock.commandCalls(PutLogEventsCommand).length > 0)
      const input = cwMock.commandCalls(PutLogEventsCommand)[0]!.args[0].input
      expect(input.logStreamName).toMatch(new RegExp(`^${os.hostname()}/${process.pid}/\\d+$`))
    })
  })

  describe('error handling', () => {
    it('invokes a custom onError when delivery fails', async () => {
      const onError = jest.fn()
      cwMock.reset()
      cwMock.on(PutLogEventsCommand).rejects(new Error('boom'))
      const stream = createTransport({ onError, maxRetries: 1 })
      writeLog(stream, { level: 30, msg: 'hi' })

      await waitUntil(() => onError.mock.calls.length > 0)
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error)
      expect((onError.mock.calls[0]![0] as Error).message).toBe('boom')
    })

    it('writes to stderr by default when delivery fails', async () => {
      const writeSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
      cwMock.reset()
      cwMock.on(PutLogEventsCommand).rejects(new Error('kaboom'))
      const stream = createTransport({ maxRetries: 1 })
      writeLog(stream, { level: 30, msg: 'hi' })

      await waitUntil(() =>
        writeSpy.mock.calls.some(c => String(c[0]).includes('[pino-cloudwatch]'))
      )
      writeSpy.mockRestore()
    })

    it('reports an unparsable line via onError', async () => {
      const onError = jest.fn()
      const stream = createTransport({ onError })
      stream.write('{not valid json\n')

      await waitUntil(() => onError.mock.calls.length > 0)
      expect((onError.mock.calls[0]![0] as Error).message).toContain('unparsable log line')
    })

    it('reports a null line via onError', async () => {
      const onError = jest.fn()
      const stream = createTransport({ onError })
      stream.write('null\n')

      await waitUntil(() => onError.mock.calls.length > 0)
      expect((onError.mock.calls[0]![0] as Error).message).toContain('Null value ignored')
    })
  })

  describe('close', () => {
    it('flushes queued logs before shutdown without loss', async () => {
      // batchSize 1 + a short interval forces multiple rate-limited batches;
      // close()'s flush hook must drain all of them before stop().
      const stream = createTransport({ submissionInterval: 50, batchSize: 1 })
      writeLog(stream, { level: 30, msg: 'one' })
      writeLog(stream, { level: 30, msg: 'two' })
      writeLog(stream, { level: 30, msg: 'three' })

      stream.end()
      await once(stream, 'close')

      const messages = putEventMessages()
      expect(messages.some(m => m.includes('one'))).toBe(true)
      expect(messages.some(m => m.includes('two'))).toBe(true)
      expect(messages.some(m => m.includes('three'))).toBe(true)
    })
  })
})
