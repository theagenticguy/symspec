/**
 * `--field <paths>` jq-style projection: reduce an envelope to just the dotted
 * paths an agent asks for, so a fix loop can pull `data.verified` or
 * `data.coverage.demotions` without piping the whole envelope through a JSON
 * tool. This is an OUTPUT projection only — like `--dense`, it never changes a
 * command's data, exit code, or the typed contract; it only selects a subset of
 * the SAME envelope object for display.
 *
 * ## What it does
 *
 *   - Splits the comma-separated `--field` value into individual dotted paths
 *     (`data.verified,data.coverage.excluded` → two paths).
 *   - For each path, walks the envelope object segment-by-segment; a segment
 *     that indexes into an array by numeric key is honored (`data.findings.0.code`).
 *   - Reassembles the found values into a NESTED object mirroring the requested
 *     paths (so `data.verified` lands at `{ data: { verified: … } }`), which
 *     keeps the projection self-describing — an agent sees where each value came
 *     from — and lets multiple overlapping paths merge cleanly.
 *   - A path that does not resolve (missing key, out-of-range index) is simply
 *     OMITTED from the result rather than emitted as `null`, matching the
 *     `exactOptionalPropertyTypes` discipline: absence is absence.
 *
 * The result is serialized as JSON (the machine default). When no requested
 * path resolves, the projection is an empty object `{}` — a truthful "nothing
 * matched" rather than an error, so a projection over a partial envelope never
 * throws.
 */

/** Parse the raw `--field` flag value into individual dotted paths. */
export function parseFieldPaths(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/** Narrow to a plain record (object, not array, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve one dotted path against `root`, honoring numeric segments as array
 * indices. Returns `{ found: true, value }` when every segment resolved, or
 * `{ found: false }` when any segment was missing/out-of-range — so a caller
 * can OMIT an unresolved path rather than materialize a `null`.
 */
function resolvePath(
  root: unknown,
  segments: readonly string[],
): { found: boolean; value?: unknown } {
  let current: unknown = root
  for (const seg of segments) {
    if (Array.isArray(current)) {
      const idx = Number(seg)
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return { found: false }
      current = current[idx]
      continue
    }
    if (isPlainObject(current)) {
      if (!Object.hasOwn(current, seg)) return { found: false }
      current = current[seg]
      continue
    }
    // A scalar/undefined with path still remaining ⇒ cannot descend further.
    return { found: false }
  }
  return { found: true, value: current }
}

/**
 * Set `value` at the nested location named by `segments` inside `target`,
 * creating intermediate plain objects as needed. Numeric segments still nest as
 * string keys in the OUTPUT object (the projection mirrors the requested path
 * shape rather than reconstructing arrays), which keeps the result
 * self-describing and merges cleanly across overlapping paths.
 */
function setNested(
  target: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void {
  let cursor = target
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i] as string
    const existing = cursor[key]
    if (isPlainObject(existing)) {
      cursor = existing
    } else {
      const next: Record<string, unknown> = {}
      cursor[key] = next
      cursor = next
    }
  }
  const last = segments[segments.length - 1]
  if (last !== undefined) cursor[last] = value
}

/**
 * Project `root` down to just the requested dotted `paths`, returning a NEW
 * nested object that mirrors those paths. Paths that do not resolve are omitted.
 * When no path resolves, the result is `{}`.
 */
export function projectFields(root: unknown, paths: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const path of paths) {
    const segments = path.split('.').filter((s) => s.length > 0)
    if (segments.length === 0) continue
    const resolved = resolvePath(root, segments)
    if (resolved.found) setNested(out, segments, resolved.value)
  }
  return out
}
