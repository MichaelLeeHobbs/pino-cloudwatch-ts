# Upstream issue & PR audit

A review of every open issue and pull request on the abandoned source project
[`dbhowell/pino-cloudwatch`](https://github.com/dbhowell/pino-cloudwatch) as of
the fork, and how `@ubercode/pino-cloudwatch` addresses each. These cannot be
closed upstream (the project is unmaintained and we are not maintainers); this
document is the traceability record.

## Issues

| # | Title | Resolution |
|---|-------|------------|
| 50 | Support for AWS SDK v3 | **Done.** `CloudWatchClient` is built on AWS SDK v3; SDK v2 is gone. |
| 42 | Plan to migrate to v7+ transport? | **Done.** Implemented as a `pino-abstract-transport` worker-thread transport — the core architecture. |
| 41 | Nothing happens… | **Mitigated.** Misconfiguration/delivery failures are surfaced via `onError` (default: one-line `stderr` warning), never silently swallowed. The worker model also avoids the old "must pipe stdout" footgun. |
| 37 | pino stops working after the error | **Fixed structurally.** Bounded retry with exponential backoff + head-of-line drop after `maxRetries`; a failed batch can never permanently wedge delivery. |
| 36 | stop sending logs on `ulimit`/network error | **Fixed structurally.** Same resilient `Relay` path; transient errors are retried, the queue stays bounded, and the pipeline self-heals. |
| 35 | Allow credentials to be specified (assumed role) | **Done.** `awsConfig.credentials` accepts the full SDK v3 credentials/provider (in-process form for provider functions); the SDK default chain covers IAM roles in a worker transport. |
| 34 | `console.log` also logged to CloudWatch | **Fixed by design.** The v7 transport only receives pino's own records; arbitrary stdout is never captured. Covered by an integration test. |
| 20 | Force flush / `flushSync`/`final` support | **Done.** The transport implements pino's async `close` hook, draining the queue (best-effort, bounded) before stop. |
| 7  | Allow `config.json` for options | **Done.** Transport `options` are plain JSON; load and spread your own config object. |
| 6  | Option to use a stream name | **Done.** `logStreamName` option. |
| 5  | Use `pid`/`hostname` for the stream name | **Done.** `logStreamName` supports `{hostname}`/`{pid}` (and `{date}`/`{time}`) tokens; defaults to `<hostname>-<pid>`. |

## Pull requests

| # | Title | Disposition |
|---|-------|-------------|
| 49 | Expose AWS Endpoint to config option | **Incorporated.** `awsConfig.endpoint` (SDK v3) covers it — useful for LocalStack/custom endpoints. |
| 46 | Fixed missing default interval for Stream usage | **Superseded.** `Relay` always applies a default `submissionInterval` (`DEFAULT_OPTIONS`); the original bug class doesn't exist here. |
| 48 | Bump flat and mocha | **Moot.** Dev toolchain replaced (Jest/ts-jest); mocha/flat are gone. |
| 47 | Bump async 3.2.0 → 3.2.2 | **Moot.** `async` dependency removed. |
| 45 | Bump ajv | **Moot.** Transitive SDK v2 dependency removed. |
| 44 | Bump pathval | **Moot.** Chai/mocha test stack removed. |
| 43 | Bump aws-sdk 2.668 → 2.814 | **Moot.** AWS SDK v2 removed in favour of v3. |
| 40 | Bump glob-parent | **Moot.** Transitive dependency removed. |
| 39 | Bump lodash | **Moot.** `lodash` not used. |
| 38 | Bump y18n | **Moot.** Transitive `yargs` (CLI) dependency removed. |

The dependabot PRs (#38–#48 except #49) all targeted the AWS SDK v2 / mocha
dependency tree, which no longer exists after the rewrite; ongoing dependency
upkeep here is handled by this repo's own `.github/dependabot.yml`.
