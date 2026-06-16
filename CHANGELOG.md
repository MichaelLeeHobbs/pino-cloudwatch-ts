# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-16

Complete TypeScript rewrite of the abandoned
[`pino-cloudwatch`](https://github.com/dbhowell/pino-cloudwatch) (`0.7.0`). This
is a new package published as `@ubercode/pino-cloudwatch`; the legacy
stdin-pipe CLI is **removed** in favour of a modern pino v7+ transport. See
[`docs/migration-from-pino-cloudwatch.md`](docs/migration-from-pino-cloudwatch.md)
and [`docs/upstream-issue-audit.md`](docs/upstream-issue-audit.md).

### Added

- **pino v7+ worker-thread transport** built on `pino-abstract-transport`
  (upstream #42). Default-exported as the package entry, usable via
  `transport: { target: '@ubercode/pino-cloudwatch' }` or in-process as a pino
  destination stream.
- AWS SDK v3 `CloudWatchClient` with optional auto-create of log group/stream,
  retention policy, and byte-aware batching to the 1 MB `PutLogEvents` limit
  (upstream #50).
- Bounded, rate-limited `Relay`: oldest-dropped queue, exponential-backoff
  retry, and head-of-line drop after `maxRetries` (upstream #36, #37).
- `onError` reporter defaulting to a one-line `stderr` warning so delivery
  failures are never silent (upstream #41).
- `logStreamName` tokens `{hostname}`, `{pid}`, `{date}`, `{time}`
  (upstream #5, #6).
- Async `close` flush hook for graceful shutdown (upstream #20).
- `awsConfig` pass-through for `region`, `endpoint`, and `credentials`
  (upstream #35 and PR #49).
- `jsonMessage`, `formatLog`/`formatLogItem`, `levelLabels`, `retentionInDays`,
  `timeout`, `maxEventSize`, and full batching/throttling tuning.
- 100% unit-test coverage, a real-pino integration suite, and a sustained
  memory soak (`pnpm run test:stress`).
- `messageKey` / `timestampKey` / `levelKey` options to match a non-default pino
  field naming (prevents silent message/timestamp loss).

### Fixed (pre-release, multi-agent review hardening)

- **Duplicate delivery** when a >1 MB batch split across multiple `PutLogEvents`
  calls and failed partway — accepted events are now tracked and never re-sent
  on a retry.
- **Backoff bypass**: an incoming log during a retry-backoff window no longer
  re-drains the failing head batch immediately.
- **Resurrection on teardown**: `close` now awaits the consume loop before
  stopping, and `CloudWatchClient.destroy()` is idempotent.
- Default metadata is now **compact JSON** (was pretty-printed) — smaller
  payloads, cheaper ingestion, reliable Logs-Insights field discovery.
- Deterministic anti-OOM / head-of-line and end-to-end behavioral regression
  tests added; documented security notes and Result/branded-type ADR waivers.

### Removed

- The legacy `pino-cloudwatch` CLI binary and stdin-pipe stream pipeline.
- AWS SDK v2 and the `sequenceToken` `PutLogEvents` handshake (removed by AWS;
  no longer required by the API).

### Changed

- Minimum runtime is Node.js >= 20.9.0; pino `^8 || ^9` is a peer dependency.
