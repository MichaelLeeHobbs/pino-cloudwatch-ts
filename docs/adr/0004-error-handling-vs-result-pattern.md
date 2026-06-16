# 4. Exceptions/events over the Result pattern (waiver of Rule 6.2)

**Date**: 2026-06-16

**Status**: Accepted

## Context

`docs/CodingStandards.md` Rule 6.2 states that functions which can fail
**shall** return a `Result<T, E>` union. This codebase instead signals failure
via `throw` / promise rejection, an EventEmitter `'error'` event, and a Node-
style `callback(err, ok)`. A formal waiver is required (Rule 2 / §13).

## Decision

Keep the throw + event + callback model. Do not adopt `Result<T, E>` in the
delivery path.

## Alternatives Considered

- **Return `Result<T, E>` from `CloudWatchClient.submit` / `putLogEvents`.**
  Rejected: `submit` implements `RelayClient.submit(): Promise<void>` and is
  consumed by Bottleneck, which only understands promise resolve/reject for
  scheduling and retry. A `Result`-returning submit could not signal "retry this
  batch" to the limiter without an adapter that re-throws anyway.
- **Wrap the pino-abstract-transport consumer in `Result`.** Rejected: the
  `for await (const obj of source)` contract throws; pino's `build()` expects a
  promise that rejects on fatal error (it calls `stream.destroy(err)`).

Both third-party contracts (Bottleneck, pino-abstract-transport) are
exception/promise-based, so a `Result` layer would be a thin re-wrapping that
adds surface without removing any unchecked-exception risk.

## Consequences

### Positive

- Matches the libraries we integrate with; no impedance-mismatch adapters.
- Error paths are still explicit and bounded: the relay never throws into the
  host (drops are reported as `callback(null, false)`, never as an `Error`), and
  delivery failures surface through a single `onError`/`'error'` channel.

### Negative

- Deviates from the house Result-pattern rule; callers reason about errors via
  events/callbacks rather than a typed `Result`.

### Risks

- A new fallible **pure** helper added later should still prefer `Result`; this
  waiver covers only the delivery path constrained by Bottleneck/pino.

## Compliance Notes

Floating-promise (Rule 4.1) and timeout/cancellation (Rule 4.2) rules remain
fully enforced; this waiver is scoped to Rule 6.2 only.
