import createDebug from 'debug'
import os from 'node:os'
import build from 'pino-abstract-transport'
import { type Transform } from 'node:stream'
import CloudWatchClient, { type CloudWatchClientOptions } from './CloudWatchClient'
import Relay, { type RelayClient, type RelayOptions } from './Relay'
import { type LogCallback, type LogItem } from './LogItem'
import { isError } from './typeGuards'

const debug = createDebug('pino-cloudwatch:transport')

/**
 * Stand-in callback for relay items. Pino's transport protocol provides no
 * per-line delivery acknowledgement, so CloudWatch delivery is decoupled from
 * the inbound log stream (the same decoupling the Winston port relies on to
 * avoid head-of-line OOM, issue #9). Delivery failures surface via
 * {@link PinoCloudWatchOptions.onError}, not this callback.
 */
const noop: LogCallback = (): void => undefined

/**
 * Default mapping from pino numeric levels to label strings. Pino emits
 * numeric levels by default; a log object carrying a string level (e.g. from a
 * custom `formatters.level`) is passed through unchanged.
 *
 * @see https://getpino.io/#/docs/api?id=levels
 */
const DEFAULT_LEVELS: Readonly<Record<number, string>> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

/** Fields lifted out of the pino log object; everything else becomes metadata. */
const RESERVED_KEYS: readonly string[] = ['level', 'time', 'msg']

/** Options for the pino CloudWatch transport. */
export interface PinoCloudWatchOptions extends Partial<RelayOptions>, CloudWatchClientOptions {
  /** CloudWatch log group name (1-512 characters). */
  readonly logGroupName: string
  /**
   * CloudWatch log stream name (1-512 characters). Supports the tokens
   * `{hostname}`, `{pid}`, `{date}` (ISO 8601) and `{time}` (epoch ms),
   * resolved once when the transport starts. Defaults to `"<hostname>-<pid>"`.
   */
  readonly logStreamName?: string
  /**
   * Invoked when a batch fails to deliver (after the relay's bounded retry).
   * Defaults to writing a one-line warning to `stderr` so failures are never
   * silent (issue #41). Supply a no-op to silence, or your own reporter.
   */
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Error is not a deeply-readonly type
  readonly onError?: (error: Error) => void
  /** Override the numeric-level → label mapping. Merged over {@link DEFAULT_LEVELS}. */
  readonly levelLabels?: Readonly<Record<number, string>>
}

/** Coerces an unknown thrown/emitted value into an `Error`. */
function toError(value: unknown): Error {
  if (isError(value)) return value
  /* istanbul ignore else -- defensive: the relay 'error' event and split2 'unknown' event only surface Error or string values */
  if (typeof value === 'string') return new Error(value)
  /* istanbul ignore next -- unreachable; see above */
  return new Error('unknown error')
}

/** Resolves stream-name tokens against this process. */
function resolveStreamName(template: string | undefined): string {
  const hostname = os.hostname()
  const pid = String(process.pid)
  if (template === undefined || template.length === 0) {
    return `${hostname}-${pid}`
  }
  const now = new Date()
  return template
    .replace(/\{hostname\}/g, hostname)
    .replace(/\{pid\}/g, pid)
    .replace(/\{date\}/g, now.toISOString())
    .replace(/\{time\}/g, String(now.getTime()))
}

/** Default error reporter: a single line to stderr, so delivery failures are visible. */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Error is not a deeply-readonly type; we only read .message
function defaultOnError(error: Error): void {
  process.stderr.write(`[pino-cloudwatch] log delivery error: ${error.message}\n`)
}

/**
 * Converts a parsed pino log object into a {@link LogItem}. `level`, `time` and
 * `msg` are lifted out; every other field becomes metadata. Missing or
 * wrong-typed fields fall back to safe defaults (Rule 7.2: validate at the
 * boundary).
 */
function toLogItem(
  record: Readonly<Record<string, unknown>>,
  levels: Readonly<Record<number, string>>
): LogItem {
  const rawLevel = record.level
  let level: string
  if (typeof rawLevel === 'number') {
    level = levels[rawLevel] ?? String(rawLevel)
  } else if (typeof rawLevel === 'string') {
    level = rawLevel
  } else {
    level = ''
  }
  const date = typeof record.time === 'number' ? record.time : Date.now()
  const message = typeof record.msg === 'string' ? record.msg : ''

  const meta: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (!RESERVED_KEYS.includes(key)) {
      meta[key] = record[key]
    }
  }

  return { date, level, message, meta, callback: noop }
}

/**
 * Drains parsed pino log objects from the transport source into the relay.
 * Bounded by pino closing the source stream on shutdown.
 */
async function consumeSource(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Node stream is inherently mutable
  source: Transform & build.OnUnknown,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Relay is a stateful class instance
  relay: Relay<LogItem>,
  levels: Readonly<Record<number, string>>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Error is not a deeply-readonly type
  onError: (error: Error) => void
): Promise<void> {
  source.on('unknown', (_line: string, error: unknown) => {
    debug('unknown line', { error })
    onError(new Error(`unparsable log line: ${toError(error).message}`))
  })
  for await (const obj of source) {
    // pino-abstract-transport guarantees a non-null object here: it emits null
    // lines and parse failures via the 'unknown' event and wraps primitive
    // values into `{ data, time }` before they reach this iterator.
    relay.submit(toLogItem(obj as Readonly<Record<string, unknown>>, levels))
  }
}

/**
 * Creates a pino v7+ transport that ships logs to AWS CloudWatch Logs.
 *
 * Pino runs this in a worker thread; only log records emitted through pino flow
 * here (so `console.log` output is never captured — issue #34). Records are
 * buffered and submitted in bounded, rate-limited batches via {@link Relay} and
 * {@link CloudWatchClient}.
 *
 * @param options - Transport configuration; see {@link PinoCloudWatchOptions}.
 * @returns The pino transport stream.
 *
 * @example
 * ```ts
 * const logger = pino({
 *   transport: {
 *     target: '@ubercode/pino-cloudwatch',
 *     options: { logGroupName: '/my-app/logs', createLogGroup: true },
 *   },
 * })
 * ```
 */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- options embeds the mutable AWS SDK client config; treated as read-only here
export default function pinoCloudWatch(options: PinoCloudWatchOptions): Transform {
  debug('init', { logGroupName: options.logGroupName })
  const logStreamName = resolveStreamName(options.logStreamName)
  const levels = { ...DEFAULT_LEVELS, ...(options.levelLabels ?? {}) }
  const onError = options.onError ?? defaultOnError

  const client: RelayClient<LogItem> = new CloudWatchClient(
    options.logGroupName,
    logStreamName,
    options
  )
  const relay = new Relay<LogItem>(client, options)
  const handleError = (error: unknown): void => onError(toError(error))
  relay.on('error', handleError)
  relay.start()

  return build(
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- pino passes a mutable Node stream
    (source: Transform & build.OnUnknown) => consumeSource(source, relay, levels, onError),
    {
      // Called on both error and graceful shutdown (logger.flush()/final(),
      // worker teardown). Drain the queue best-effort, then release resources
      // (issue #20). Resolving the returned promise tells pino teardown is done.
      close: async (): Promise<void> => {
        debug('close')
        try {
          await relay.flush()
        } catch {
          /* istanbul ignore next -- defensive: flush() resolves on timeout and is not expected to reject */
        }
        relay.removeListener('error', handleError)
        relay.stop()
      },
    }
  )
}
