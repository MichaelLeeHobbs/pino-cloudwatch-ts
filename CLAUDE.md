# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

pino v7+ transport for AWS CloudWatch Logs (TypeScript, AWS SDK v3, Bottleneck rate limiting). Publishes as dual ESM/CJS with type declarations via tsup. Package: `@ubercode/pino-cloudwatch`. Requires Node.js >= 20.9.0; pino `^8 || ^9` peer. This is a ground-up rewrite of the abandoned `dbhowell/pino-cloudwatch`; the logger-agnostic backend is vendor-copied from the sibling `@ubercode/winston-cloudwatch` (see `docs/adr/0002-vendor-copy-backend.md`).

## Commands

```bash
pnpm install
pnpm run build         # ESM + CJS + d.ts to dist/
pnpm run test          # format + lint + unit
pnpm run test:cover    # unit + coverage (must stay 100%)
pnpm run test:ci       # what CI runs
pnpm run test:stress   # sustained memory soak (--expose-gc; NOT in default test/CI)
pnpm run lint          # eslint --fix
pnpm run format        # prettier --write
pnpm run example       # run examples/basic-usage.ts via ts-node
```

## Architecture

Pipeline: **pino Logger → (worker thread) transport → Relay → CloudWatchClient → AWS CloudWatch Logs API**.

- **transport** (`src/transport.ts`) — default export; a `pino-abstract-transport` factory. Parses pino log objects → `LogItem` → `Relay`. Entry point.
- **Relay\<T\>** (`src/Relay.ts`) — Generic batching/throttling. Bottleneck-rate-limited; bounded queue (oldest-dropped); bounded retry with exponential backoff (`maxRetries`/`retryBackoffCap`) — the head batch is dropped after the cap to prevent head-of-line blocking during a sustained outage.
- **CloudWatchClient** (`src/CloudWatchClient.ts`) — implements `RelayClient<LogItem>`. Wraps the AWS SDK v3 client; optional auto-create of log groups/streams; lazy-initialized with idempotent `??=` memoization (reset on failure). No sequence-token handshake (`docs/adr/0003`).
- **CloudWatchEventFormatter** (`src/CloudWatchEventFormatter.ts`) — default format `[LEVEL] message {metadata}`; UTF-8-safe truncation; optional `jsonMessage` and user-supplied `formatLog`/`formatLogItem`.

Broader rationale and the mission-critical TypeScript standard this project follows: [`docs/CodingStandards.md`](docs/CodingStandards.md). Design decisions: [`docs/adr/`](docs/adr/).

## Non-obvious behaviors

- **Delivery is decoupled from the inbound pino stream.** The transport feeds the relay's bounded queue and never blocks; relay items carry a `noop` callback (pino has no per-line ack). Re-coupling reintroduces head-of-line OOM under a sustained outage — preserve this.
- **Worker-thread transport options must be JSON-serializable.** `formatLog`/`formatLogItem`/`onError` functions and a pre-built `cloudWatchLogs` client only work via the in-process form `pino(options, stream)`. The README documents both forms.
- **No `jest.useFakeTimers()` anywhere**, by design. Bottleneck's `minTime` is wall-clock; tests use real timers + `waitUntil(predicate, timeoutMs)` polling. The transport is driven by writing NDJSON to the returned stream; `close` fires on stream end (`autoDestroy`).
- **Adding a public option** means: `PinoCloudWatchOptions` (`src/transport.ts`), `RelayOptions` + `DEFAULT_OPTIONS` (`src/Relay.ts`) if it flows through the relay, and the config table in `README.md`. The DTS build catches type breakage; `test:cover` must stay at 100%.
- **Releases are automated.** `.github/workflows/publish.yml` triggers on `v*` tag push and runs `npm publish --provenance` + auto-creates the GitHub Release. Never run `npm publish` manually.
- `tsconfig.json` is IDE-only (`noEmit`); production output is built by `tsup.config.ts`.

## Code conventions

- PascalCase filenames for the class/type they export; `transport.ts` is the pino adapter.
- No semicolons, single quotes, 100-char line width, ES5 trailing commas (Prettier).
- Unused parameters prefixed with `_`. Inline type imports: `import { type Foo } from ...`.
- `any` is banned; defensive-but-unreachable branches use `/* istanbul ignore ... */` with a justification, matching the backend.

## Testing

- Jest with ts-jest; unit tests in `tests/unit/`. AWS SDK mocked with `aws-sdk-client-mock` (matchers wired via `tests/helpers/setupAwsSdkMock.ts`).
- `tests/helpers/MockClient.ts` is a `RelayClient` stub for `Relay` tests.
- `tests/unit/pino-integration.spec.ts` drives a real `pino` logger in-process.
- `tests/stress/*.stress.ts` — memory soak via `pnpm run test:stress`; excluded from the default suite/CI.
- Coverage excludes `src/index.ts` (barrel); everything else stays at 100%.
- See `.claude/rules/tests.md` for test-file conventions.
