import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { once } from 'node:events'
import { type Transform } from 'node:stream'
import { mockClient } from 'aws-sdk-client-mock'
import { CloudWatchLogsClient, PutLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import pino from 'pino'
import pinoCloudWatch from '../../src/transport'

// End-to-end through a REAL pino logger. pino accepts a destination stream as
// its second argument, so we drive the transport in-process (no worker thread)
// while still exercising pino's actual NDJSON output → our parser → relay →
// CloudWatchClient plumbing. This closes the "100% line coverage but untested
// real-logger plumbing" gap.

const cwMock = mockClient(CloudWatchLogsClient)

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function putEventMessages(): string[] {
  return cwMock
    .commandCalls(PutLogEventsCommand)
    .flatMap(call => (call.args[0].input.logEvents ?? []).map(e => e.message ?? ''))
}

let stream: Transform | undefined

beforeEach(() => {
  cwMock.reset()
  cwMock.onAnyCommand().resolves({})
})

afterEach(async () => {
  if (stream && !stream.destroyed) {
    stream.end()
    await once(stream, 'close').catch(() => undefined)
  }
  stream = undefined
})

describe('end-to-end through a real pino.Logger', () => {
  it('routes a real logger call to PutLogEvents with message + metadata intact', async () => {
    stream = pinoCloudWatch({ logGroupName: 'g', logStreamName: 's', submissionInterval: 10 })
    const logger = pino({ level: 'info' }, stream)

    logger.info({ userId: 1234, action: 'login' }, 'hello world')

    await waitUntil(() => putEventMessages().length > 0)
    const message = putEventMessages()[0] ?? ''
    expect(message).toContain('hello world')
    expect(message).toContain('[INFO]')
    expect(message).toContain('1234')
    expect(message).toContain('login')
  })

  it('maps pino severity levels to CloudWatch event labels', async () => {
    stream = pinoCloudWatch({ logGroupName: 'g', logStreamName: 's', submissionInterval: 10 })
    const logger = pino({ level: 'trace' }, stream)

    logger.warn('careful')
    logger.error('broken')

    await waitUntil(() => putEventMessages().length >= 2)
    const joined = putEventMessages().join('\n')
    expect(joined).toContain('[WARN] careful')
    expect(joined).toContain('[ERROR] broken')
  })

  it('captures only pino records, never stray console output (issue #34)', async () => {
    stream = pinoCloudWatch({ logGroupName: 'g', logStreamName: 's', submissionInterval: 10 })
    const logger = pino({ level: 'info' }, stream)

    // Console output goes nowhere near the transport stream.
    // eslint-disable-next-line no-console -- intentional: proving console output is NOT captured
    console.log('this must NOT reach CloudWatch')
    logger.info('only this')

    await waitUntil(() => putEventMessages().length > 0)
    const joined = putEventMessages().join('\n')
    expect(joined).toContain('only this')
    expect(joined).not.toContain('must NOT reach CloudWatch')
  })
})
