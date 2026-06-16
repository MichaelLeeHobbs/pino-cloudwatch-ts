# Migrating from pino-cloudwatch

This guide helps you migrate from the original
[`pino-cloudwatch`](https://github.com/dbhowell/pino-cloudwatch) (by David
Howell) to `@ubercode/pino-cloudwatch`.

## What changed

The original was a **legacy stdin-pipe transport**: a CLI you piped pino's
stdout into (`node app | pino-cloudwatch --group ...`), built on AWS SDK v2 and
the now-removed `PutLogEvents` sequence-token protocol.

`@ubercode/pino-cloudwatch` is a **pino v7+ transport** (worker thread) on AWS
SDK v3. Practical consequences:

- **No CLI / no piping.** You configure the transport in your pino setup.
- **`console.log` is no longer captured.** Only records emitted through pino
  flow to CloudWatch (upstream
  [#34](https://github.com/dbhowell/pino-cloudwatch/issues/34)).
- **Resilient delivery.** A CloudWatch/network/`ulimit` outage no longer wedges
  logging (upstream
  [#36](https://github.com/dbhowell/pino-cloudwatch/issues/36),
  [#37](https://github.com/dbhowell/pino-cloudwatch/issues/37)).

## Install

```bash
npm uninstall pino-cloudwatch
npm install @ubercode/pino-cloudwatch
```

## Before

```js
// package.json: "start": "node app.js | pino-cloudwatch --group my-group ..."
import pino from 'pino'
import cloudwatch from 'pino-cloudwatch'

const logger = pino(
  { level: 'info' },
  cloudwatch({
    group: 'my-group',
    prefix: 'web',
    aws_region: 'us-east-1',
    aws_access_key_id: process.env.AWS_ACCESS_KEY_ID,
    aws_secret_access_key: process.env.AWS_SECRET_ACCESS_KEY,
    interval: 1000,
  })
)
```

## After

```js
import pino from 'pino'

const logger = pino({
  level: 'info',
  transport: {
    target: '@ubercode/pino-cloudwatch',
    options: {
      logGroupName: 'my-group',
      logStreamName: 'web-{hostname}-{pid}',
      submissionInterval: 1000,
      createLogGroup: true,
      createLogStream: true,
      awsConfig: {
        region: 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      },
    },
  },
})
```

## Option mapping

| `pino-cloudwatch` (0.7.0) | `@ubercode/pino-cloudwatch`                              | Notes                                                                 |
|---------------------------|----------------------------------------------------------|-----------------------------------------------------------------------|
| `group`                   | `logGroupName`                                           | Now required, validated to 1–512 chars                                |
| `stream`                  | `logStreamName`                                         | Optional; defaults to `<hostname>-<pid>`                              |
| `prefix`                  | `logStreamName` with tokens, e.g. `'web-{hostname}-{pid}'` | No separate `prefix` option; compose the name via tokens (#5, #6)  |
| `aws_region`              | `awsConfig: { region }`                                 | Standard AWS SDK v3 config                                            |
| `aws_access_key_id`       | `awsConfig: { credentials: { accessKeyId } }`           | Or use the SDK default credential chain (IAM role, env, shared config)|
| `aws_secret_access_key`   | `awsConfig: { credentials: { secretAccessKey } }`       | —                                                                     |
| `interval`                | `submissionInterval`                                    | Minimum ms between batch submissions                                  |
| `errorHandler` (2nd arg)  | `onError` (in-process) / default `stderr` warning        | Delivery failures are surfaced, not silent (#41)                      |
| _(implicit)_              | `createLogGroup` / `createLogStream`                    | Opt in to auto-create; off by default                                 |
| _(none)_                  | `endpoint` (via `awsConfig`)                            | For LocalStack / custom endpoints (upstream PR #49)                   |

## Credentials & assumed roles

For a refreshing credential **provider** (e.g. assumed role — upstream
[#35](https://github.com/dbhowell/pino-cloudwatch/issues/35)), pass it as
`awsConfig.credentials` using the **in-process** form (`pino(opts, stream)`),
since functions can't cross the worker-thread boundary. In a worker transport,
rely on the SDK default credential chain instead. See the README for both
forms.
