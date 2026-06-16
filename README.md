# @ubercode/pino-cloudwatch

[![npm version](https://img.shields.io/npm/v/@ubercode/pino-cloudwatch.svg)](https://www.npmjs.com/package/@ubercode/pino-cloudwatch)
[![CI](https://github.com/MichaelLeeHobbs/pino-cloudwatch-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/MichaelLeeHobbs/pino-cloudwatch-ts/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.9.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A modern TypeScript [pino](https://getpino.io/) **v7+ transport** for [Amazon CloudWatch Logs](https://aws.amazon.com/cloudwatch/), built on AWS SDK v3.

This is the actively-maintained successor to the original [`pino-cloudwatch`](https://github.com/dbhowell/pino-cloudwatch), rebuilt from the ground up in TypeScript. It replaces the legacy stdin-pipe CLI (AWS SDK v2, sequence-token protocol) with a worker-thread [`pino-abstract-transport`](https://github.com/pinojs/pino-abstract-transport), and inherits the mission-critical batching/throttling/bounded-memory core from its sibling [`@ubercode/winston-cloudwatch`](https://www.npmjs.com/package/@ubercode/winston-cloudwatch).

> **Project status.** The original `pino-cloudwatch` is unmaintained — no releases or
> issue activity in years. `@ubercode/pino-cloudwatch` is its de-facto continuation:
> every open upstream issue and PR has been triaged and addressed (see
> [`docs/upstream-issue-audit.md`](docs/upstream-issue-audit.md)), and bug reports and
> feature requests are tracked **in this repository** going forward.

## Features

- **pino v7+ transport** — runs in pino's worker thread; only records emitted through pino are shipped (your `console.log` is never captured)
- **AWS SDK v3** — modular, tree-shakeable; no sequence-token handshake
- **Bounded memory** — a CloudWatch outage can never stall pino or leak memory; the queue is strictly bounded (oldest-dropped)
- **Resilient delivery** — rate-limited batches, exponential-backoff retry, and head-of-line drop so a persistent outage never wedges the pipeline
- **Byte-aware batching** — respects the 1 MB `PutLogEvents` payload limit
- **Graceful flush** — drains queued logs on shutdown via the transport `close` hook
- **Flexible formatting** — default `[LEVEL] message {meta}`, optional `jsonMessage`, or fully custom
- **Dynamic stream names** — `{hostname}`/`{pid}`/`{date}`/`{time}` tokens
- **100% test coverage** with Jest, plus a sustained memory soak

## Installation

```bash
npm install @ubercode/pino-cloudwatch pino
# or: pnpm add @ubercode/pino-cloudwatch pino
```

## Usage

### Recommended: worker-thread transport

```typescript
import pino from 'pino'

const logger = pino({
  transport: {
    target: '@ubercode/pino-cloudwatch',
    options: {
      logGroupName: '/my-app/logs', // REQUIRED
      logStreamName: 'production',   // optional; defaults to "<hostname>-<pid>"
      createLogGroup: true,
      createLogStream: true,
      awsConfig: { region: 'us-east-1' },
    },
  },
})

logger.info({ userId: 123, action: 'login' }, 'Hello CloudWatch!')
```

Because pino runs the transport in a **worker thread**, the `options` object is
structured-cloned across the thread boundary, so it must be **JSON-serializable**.
Functions (`formatLog`, `formatLogItem`, a credential-provider function) and a
pre-built `cloudWatchLogs` client **cannot** be passed this way — use the
in-process form below for those.

### Advanced: in-process (supports functions & custom clients)

pino accepts a destination stream as its second argument. This runs the
transport in the main thread, so callbacks and a bring-your-own client work:

```typescript
import pino from 'pino'
import pinoCloudWatch from '@ubercode/pino-cloudwatch'

const stream = pinoCloudWatch({
  logGroupName: '/my-app/logs',
  logStreamName: 'production',
  formatLog: item => `[${item.level}] ${item.message}`,
  awsConfig: { region: 'us-east-1', credentials: myCredentialProvider },
})

const logger = pino({ level: 'info' }, stream)
```

## Configuration Options

| Option               | Type                         | Required | Default        | Description                                                                                  |
|----------------------|------------------------------|----------|----------------|----------------------------------------------------------------------------------------------|
| `logGroupName`       | `string`                     | Yes      | –              | CloudWatch log group name (1–512 chars)                                                      |
| `logStreamName`      | `string`                     | No       | `<hostname>-<pid>` | Log stream name (1–512 chars). Supports `{hostname}` `{pid}` `{date}` `{time}` tokens     |
| `awsConfig`          | `CloudWatchLogsClientConfig` | No       | `{}`           | AWS SDK v3 client config (`region`, `endpoint`, `credentials`, …). Ignored if `cloudWatchLogs` is set |
| `cloudWatchLogs`     | `CloudWatchLogsClient`       | No       | –              | Pre-built AWS SDK client (in-process usage only). Not destroyed on close                     |
| `createLogGroup`     | `boolean`                    | No       | `false`        | Auto-create the log group on first submission                                                |
| `createLogStream`    | `boolean`                    | No       | `false`        | Auto-create the log stream on first submission                                               |
| `retentionInDays`    | `RetentionInDays`            | No       | –              | Set the log-group retention policy (e.g. `7`, `30`, `365`)                                   |
| `timeout`            | `number`                     | No       | `10000`        | Timeout (ms) for each AWS SDK call                                                           |
| `maxEventSize`       | `number`                     | No       | `1048576`      | Max event size in bytes (incl. 26-byte overhead); longer messages are truncated             |
| `jsonMessage`        | `boolean`                    | No       | `false`        | Emit each event as a JSON object. Ignored if `formatLog`/`formatLogItem` is set              |
| `formatLog`          | `(item) => string`           | No       | –              | Custom message formatter (in-process only). Takes precedence over `formatLogItem`            |
| `formatLogItem`      | `(item) => {message,timestamp}` | No    | –              | Custom message+timestamp formatter (in-process only)                                         |
| `levelLabels`        | `Record<number,string>`      | No       | pino defaults  | Override the numeric-level → label map (merged over `10..60`)                                |
| `onError`            | `(error) => void`            | No       | stderr warning | Delivery-failure reporter (in-process only). Default writes one line to `stderr`             |
| `submissionInterval` | `number`                     | No       | `2000`         | Minimum ms between batch submissions                                                         |
| `batchSize`          | `number`                     | No       | `20`           | Max log events per batch                                                                     |
| `maxQueueSize`       | `number`                     | No       | `10000`        | Max queued events (oldest dropped when full)                                                 |
| `maxRetries`         | `number`                     | No       | `10`           | Consecutive head-batch failures before the batch is dropped (frees head-of-line)             |
| `retryBackoffCap`    | `number`                     | No       | `30000`        | Upper bound (ms) on exponential backoff between retries; `0` disables backoff                |

## Backpressure & Delivery Semantics

CloudWatch delivery is **decoupled** from pino's log stream. Each record is
accepted into a bounded in-memory queue and the stream keeps draining;
delivery to CloudWatch then happens asynchronously in rate-limited batches.

This is deliberate. If delivery were coupled to the inbound stream, any
*persistent* failure (throttling, timeouts, missing IAM, a CloudWatch outage,
or an `EMFILE`/`ulimit` storm) would stall the pipeline head-of-line and buffer
every later log unbounded until the process ran out of memory — the failure
mode reported upstream in
[#36](https://github.com/dbhowell/pino-cloudwatch/issues/36) and
[#37](https://github.com/dbhowell/pino-cloudwatch/issues/37).

Practical implications:

- **Memory is strictly bounded** by `maxQueueSize`, regardless of CloudWatch
  availability. When full, the **oldest** queued event is dropped.
- A logging call returning does **not** mean the log reached CloudWatch — only
  that it was queued. Genuine delivery failures go to `onError` (or `stderr`).
- During a persistent outage a failing batch is retried with exponential
  backoff and, after `maxRetries` consecutive failures, dropped — so an
  undeliverable head batch never blocks newer logs.

## Graceful Shutdown / Flush

The transport implements pino's async `close` hook: on teardown it performs a
best-effort flush of the queue (bounded by the flush timeout) before stopping.
With a worker transport, `await logger.flush()` and let the process end so pino
tears the worker down cleanly; the transport drains on close.

## AWS Credentials

AWS SDK v3 resolves credentials from the standard chain (env vars, shared
config files, IAM roles for EC2/ECS/Lambda). In a **worker transport** the
chain runs inside the worker, so IAM roles and assumed-role-via-config work
automatically. For a programmatic credential **provider** (e.g. a refreshing
assumed-role provider — upstream
[#35](https://github.com/dbhowell/pino-cloudwatch/issues/35)), use the
in-process form and pass it as `awsConfig.credentials`.

## Migration

Coming from the original `pino-cloudwatch`? See
[`docs/migration-from-pino-cloudwatch.md`](docs/migration-from-pino-cloudwatch.md).
Every open issue and PR from the upstream project and how this rewrite
addresses it is catalogued in
[`docs/upstream-issue-audit.md`](docs/upstream-issue-audit.md).

## Requirements

- Node.js >= 20.9.0
- pino ^8 || ^9

## Development

```bash
pnpm install
pnpm test          # format + lint + unit (100% coverage required)
pnpm test:stress   # sustained memory soak (node --expose-gc; not in CI)
pnpm build
```

This project follows the mission-critical TypeScript standard in
[`docs/CodingStandards.md`](docs/CodingStandards.md).

## License

MIT — see [LICENSE](LICENSE).

## Maintenance & credits

This package is the actively-maintained successor to the original
`pino-cloudwatch`, which is no longer maintained. File bug reports and feature
requests against [this repository](https://github.com/MichaelLeeHobbs/pino-cloudwatch-ts/issues).

The original `pino-cloudwatch` by [David Howell](https://github.com/dbhowell) is
gratefully acknowledged — its design informed this work. TypeScript v7-transport
rewrite, AWS SDK v3 migration, and ongoing maintenance by
[Michael Lee Hobbs](https://github.com/MichaelLeeHobbs).
