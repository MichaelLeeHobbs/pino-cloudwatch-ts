// The package default export is the pino transport factory — this is what pino
// loads via `transport: { target: '@ubercode/pino-cloudwatch' }`. The named
// exports expose the logger-agnostic backend for advanced/programmatic use.
export { default, type PinoCloudWatchOptions } from './transport'
export { type LogItem, type LogCallback } from './LogItem'
export {
  default as CloudWatchClient,
  type CloudWatchClientOptions,
  type RetentionInDays,
  VALID_RETENTION_DAYS,
  MAX_BATCH_BYTES,
} from './CloudWatchClient'
export {
  default as CloudWatchEventFormatter,
  type CloudWatchEventFormatterOptions,
  EVENT_OVERHEAD_BYTES,
  DEFAULT_MAX_EVENT_SIZE,
} from './CloudWatchEventFormatter'
export {
  default as Relay,
  type RelayOptions,
  type RelayClient,
  type RelayItem,
  DEFAULT_FLUSH_TIMEOUT,
  DEFAULT_OPTIONS,
} from './Relay'
export { default as Queue } from './Queue'
