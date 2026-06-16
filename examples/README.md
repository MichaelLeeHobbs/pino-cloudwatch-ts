# Examples

## `basic-usage.ts`

A minimal end-to-end example that ships a few pino log records to CloudWatch.

```bash
AWS_REGION=us-east-1 pnpm run example
```

Needs AWS credentials resolvable by the SDK default chain (environment
variables, shared config file, or an IAM role) with permission to
`logs:CreateLogGroup`, `logs:CreateLogStream`, and `logs:PutLogEvents`. It logs
to the `/examples/pino-cloudwatch` log group.

The example uses the in-process form (`pino(options, stream)`) so it runs under
ts-node and can pass a custom `onError`. The recommended production form — the
worker-thread transport via `transport: { target: '@ubercode/pino-cloudwatch' }`
— is shown in a comment at the bottom of the file and in the
[root README](../README.md).
