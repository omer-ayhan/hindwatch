export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drop null / undefined / empty-string / empty-object keys; keep [] / 0 / false. */
export function omitEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitEmpty);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "string" && raw.length === 0) continue;
    const next = omitEmpty(raw);
    if (isPlainObject(next) && Object.keys(next).length === 0) continue;
    out[key] = next;
  }
  return out;
}
