# 2. Reuse the CloudWatch backend by vendor-copy

**Date**: 2026-06-16

**Status**: Accepted

## Context

The logger-agnostic delivery core — `Relay` (batching, throttling, bounded
queue, retry/drop), `CloudWatchClient` (AWS SDK v3, auto-create, byte-aware
batching), `CloudWatchEventFormatter`, `Queue`, `LogItem`, `typeGuards` — was
already built, hardened, and shipped at 100% coverage in the sibling project
`@ubercode/winston-cloudwatch`. Only the front-end adapter (Winston transport
vs. pino transport) differs.

## Decision

Vendor-copy the backend modules and their tests into this repository, adapting
only the logger-specific touch points (debug namespace, a couple of comments).
Keep the two packages independent for now.

## Alternatives Considered

- **Extract a shared `@ubercode/cloudwatch-core` package** that both Winston and
  pino packages depend on. Best long-term (no drift), but it requires
  refactoring and re-releasing the already-published Winston package and adds
  release coupling. Deferred.
- **pnpm monorepo** containing core + both transports. Largest restructure;
  relocates the published Winston repo. Deferred.

## Consequences

### Positive

- Fastest path to a solid, independently releasable pino package; no changes
  forced on the published Winston package.

### Negative

- The backend now exists in two repositories and can drift.

### Risks

- A bug fixed in one copy must be ported to the other. Mitigation: the backend
  is small, fully tested at 100%, and changes rarely; if churn increases, revisit
  the shared-core extraction.

## Compliance Notes

Backend ported verbatim with namespace-only edits; the full unit suite and
memory soak were carried over and pass at 100% coverage.
