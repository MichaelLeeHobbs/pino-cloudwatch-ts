# 1. Adopt a pino v7+ worker-thread transport (drop the legacy CLI)

**Date**: 2026-06-16

**Status**: Accepted

## Context

The upstream `pino-cloudwatch@0.7.0` was a legacy transport: a CLI
(`bin/pino-cloudwatch.js`) that read pino's stdout via `split2`/`pump` and
shipped it through a stream pipeline. This model required piping the whole
process stdout, which also captured non-pino output such as `console.log`
(upstream #34), and pino has since introduced the v7+ transport architecture
(upstream #42) that runs transports in a dedicated worker thread.

## Decision

Implement the package as a pino v7+ transport using `pino-abstract-transport`,
default-exported so it can be loaded via `transport: { target:
'@ubercode/pino-cloudwatch' }`. Drop the stdin-pipe CLI entirely. Support an
in-process form (`pino(options, stream)`) for cases that need to pass functions
or a pre-built client across what would otherwise be a worker boundary.

## Alternatives Considered

- **Keep the legacy CLI alongside the transport.** Rejected: larger surface and
  maintenance burden, and it perpetuates the `console.log`-capture footgun.
- **Ship both modes as first-class.** Rejected for the initial release: the
  worker transport is the modern, recommended path; the in-process stream form
  already covers advanced needs without a separate CLI.

## Consequences

### Positive

- Only pino's own records are shipped (fixes #34).
- Aligns with the supported pino architecture (#42); clean `close`/flush hook
  for graceful shutdown (#20).

### Negative

- Breaking for anyone using the old `node app | pino-cloudwatch` pipeline;
  documented in the migration guide.

### Risks

- Worker-thread transports receive **JSON-serializable options only**. Function
  options and a custom client require the in-process form — called out
  explicitly in the README and option table.

## Compliance Notes

Validated by a real-pino integration suite and a built-package worker-thread
load smoke test.
