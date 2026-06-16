# 5. Raw primitives over branded types for log fields (waiver of Rule 7.3)

**Date**: 2026-06-16

**Status**: Accepted

## Context

`docs/CodingStandards.md` Rule 7.3 says domain values **shall** use branded /
nominal types (e.g. `Brand<string, 'LogGroupName'>`) with validating factories,
rather than raw `string`/`number`. This codebase uses raw `string` for
`logGroupName`/`logStreamName`/`level`/`message` and raw `number` for
timestamps. A formal waiver is required (Rule 2 / §13).

## Decision

Use raw primitives for these fields. Validate at the boundary instead of
branding: `CloudWatchClient` validates `logGroupName`/`logStreamName` length
(1-512) in `validateConfig`, and `toLogItem` narrows the untrusted pino record's
`level`/`time`/`message` with explicit type checks and safe fallbacks.

## Alternatives Considered

- **Brand every field with validating factories.** Rejected as
  disproportionate: the public API surface is a single options object and a pino
  destination stream; values originate from pino's own serialized record (for
  log fields) or from developer-supplied config (for group/stream names). The
  values never flow between domain functions where they could be transposed —
  the classic branding hazard (e.g. using a UserId as a timestamp) does not
  arise here. Branding would add factory ceremony and `Result`-returning
  constructors to a hot per-log path for negligible safety gain.

## Consequences

### Positive

- Simpler API and hot path; boundary validation still rejects malformed config
  (throws on construction) and malformed records (safe defaults).

### Negative

- Deviates from Rule 7.3; the type system does not nominally distinguish a log
  group name from any other string.

### Risks

- If the public surface grows to pass multiple same-typed identifiers between
  functions, revisit and introduce brands there.

## Compliance Notes

Boundary validation (Rule 7.2) is honored via `validateConfig` and the
`toLogItem` narrowing + `isRecord` guard; this waiver is scoped to Rule 7.3.
