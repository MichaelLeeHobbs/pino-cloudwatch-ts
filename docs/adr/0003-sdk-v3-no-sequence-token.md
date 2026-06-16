# 3. AWS SDK v3 and removal of the sequence-token protocol

**Date**: 2026-06-16

**Status**: Accepted

## Context

The upstream implementation used AWS SDK v2 (in maintenance mode, upstream #50)
and the classic `PutLogEvents` flow: `describeLogStreams` to read the
`uploadSequenceToken`, then submit with that token, retrying on
`InvalidSequenceTokenException`. AWS removed the sequence-token requirement from
`PutLogEvents` in 2023 — tokens are now accepted but ignored, and the
describe-per-batch round-trip is pure overhead (and counts against API quota).

## Decision

Use AWS SDK v3 (`@aws-sdk/client-cloudwatch-logs`) and submit `PutLogEvents`
**without** a sequence token. Do not call `describeLogStreams` on the hot path.
Retain defensive handling of `DataAlreadyAcceptedException` /
`InvalidSequenceTokenException` in the relay as harmless, no-cost safety.

## Alternatives Considered

- **Keep the sequence-token handshake for older regions.** Rejected: the field
  is universally optional now; the handshake only adds latency, quota usage, and
  a whole class of `InvalidSequenceToken` failure modes.

## Consequences

### Positive

- Fewer API calls, lower latency, no sequence-token failure class. Modular,
  tree-shakeable SDK v3 with first-class credential providers (enables #35).

### Negative

- None material. SDK v3's client config shape differs from v2; handled in the
  migration guide's option mapping.

### Risks

- Concurrent writers to the same stream are fine without tokens (AWS no longer
  enforces ordering via the token); event ordering within a batch is preserved
  by sorting on timestamp before submit.

## Compliance Notes

Covered by `CloudWatchClient.spec.ts` (auto-create, byte-limit splitting,
timeouts) at 100% coverage.
