/** Type guard that narrows `unknown` to `Error`. */
export function isError(value: unknown): value is Error {
  return value instanceof Error
}

/** Type guard that narrows `unknown` to a non-null object (record). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
