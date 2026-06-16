/**
 * Runnable example for @ubercode/pino-cloudwatch.
 *
 * Requires AWS credentials in the environment (or a shared config / IAM role)
 * and a region. Run with:
 *
 *   AWS_REGION=us-east-1 pnpm run example
 *
 * This uses the IN-PROCESS form (`pino(options, stream)`) so it runs directly
 * under ts-node and can pass a custom `onError`. In production you would
 * normally use the worker-thread form shown at the bottom.
 */
import pino from 'pino'
import pinoCloudWatch from '../src/transport'

async function main(): Promise<void> {
  const stream = pinoCloudWatch({
    logGroupName: '/examples/pino-cloudwatch',
    logStreamName: 'demo-{hostname}-{pid}',
    createLogGroup: true,
    createLogStream: true,
    submissionInterval: 1000,
    awsConfig: { region: process.env.AWS_REGION ?? 'us-east-1' },
    onError: error => {
      // eslint-disable-next-line no-console
      console.error('CloudWatch delivery failed:', error.message)
    },
  })

  const logger = pino({ level: 'info' }, stream)

  logger.info({ userId: 123, action: 'login' }, 'Hello CloudWatch!')
  logger.warn({ latencyMs: 1200 }, 'slow response')
  logger.error(new Error('something broke'), 'request failed')

  // Give the rate-limited relay a moment to ship, then drain on shutdown.
  await new Promise(resolve => setTimeout(resolve, 2000))
  stream.end()
  // eslint-disable-next-line no-console
  console.log('done — check the /examples/pino-cloudwatch log group')
}

void main()

/*
 * Recommended production form (worker thread):
 *
 * const logger = pino({
 *   transport: {
 *     target: '@ubercode/pino-cloudwatch',
 *     options: {
 *       logGroupName: '/my-app/logs',
 *       createLogGroup: true,
 *       awsConfig: { region: 'us-east-1' },
 *     },
 *   },
 * })
 */
