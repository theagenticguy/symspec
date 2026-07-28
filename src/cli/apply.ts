/**
 * The `apply` command core (wishlist #1): apply a batch of mutation ops from a
 * JSONL stream in ONE process and ONE save.
 *
 * The single biggest authoring lever: authoring a 42-requirement spec took
 * ~150 subprocess calls (one per `add`/`update`/`derive`) plus a label→UUID
 * sidecar file, and a mid-batch crash had no resume story. `apply` collapses all
 * of that: a stream of `{op, ...}` records — one JSON object per line — folded
 * against one loaded document and written atomically once.
 *
 * ## Op shape
 *
 * Each line is a JSON object with an `op` discriminant and the same fields the
 * matching command takes. Requirement references (`ref`, `from`, `to`) accept a
 * stable key OR a UUID, resolved through {@link resolveId}. An `add` op may
 * carry its own `key`, so LATER ops in the same batch can reference the new
 * requirement by that key before its minted UUID is ever known — which is what
 * removes the sidecar map.
 *
 *   {"op":"add","key":"G1","patternType":"ubiquitous","systemName":"auth service","systemResponse":"log every attempt"}
 *   {"op":"update","ref":"G1","status":"approved"}
 *   {"op":"derive","from":"G1","to":"S3"}
 *   {"op":"satisfy","from":"S3","to":"G1"}
 *   {"op":"remove-edge","from":"G1","relation":"derives","to":"S3"}
 *   {"op":"delete","ref":"S3"}      // `delete` also accepts `id` as an alias for `ref`:
 *   {"op":"delete","id":"S3"}       // identical to the line above (both key-or-UUID).
 *
 * ## Atomicity (fixes the report's "no resume story")
 *
 * ATOMIC by default: every op is validated and folded in memory, and the caller
 * writes the document exactly once ONLY when all ops succeed. Any op error
 * aborts with `ok:false` and the failing op's index, and the returned result has
 * NO `next`, so a crashed batch never leaves the document half-mutated — the
 * resume story is simply "fix the line and re-run". `--continue-on-error` opts
 * into best-effort mode: apply what succeeds, still save once, and report a
 * per-op results array plus an `{ok, failed}` summary (mirrors `parseBatch`).
 *
 * Pure and I/O-free like the other command cores: {@link runApply} takes the
 * loaded document and the raw JSONL text and returns `{next?, envelope}`. The
 * wiring reads the file/stdin, calls this, saves on `next`, and emits.
 */

import { applyChange } from '../core/changes.js'
import { ErrCodeSchema } from '../core/codes.js'
import { resolveId } from '../core/doc.js'
import type { RequirementsDoc } from '../core/schema.js'
import type { Envelope } from './envelope.js'
import { failure, success } from './envelope.js'

/** The usage line apply `ERR_USAGE` suggestions cite. */
export const APPLY_USAGE = 'symspec apply [file] [--stdin] [--continue-on-error]'

/** The op verbs `apply` accepts, mapped to core Change kinds internally. */
export const APPLY_OPS = [
  'add',
  'update',
  'derive',
  'satisfy',
  // AC-1-8 — `verify`/`refine` join the batch op set so `apply` has parity with
  // the single-edge commands. Previously `remove-edge` accepted all four
  // relations while only two could ever be created, in either surface.
  'verify',
  'refine',
  'remove-edge',
  'delete',
] as const
export type ApplyOp = (typeof APPLY_OPS)[number]

/**
 * Edge-creating op → the schema relation it adds. One table so the op set and
 * the relation set cannot drift (AC-1-8).
 */
const EDGE_OP_RELATION: Record<
  'derive' | 'satisfy' | 'verify' | 'refine',
  'derives' | 'satisfies' | 'verifies' | 'refines'
> = {
  derive: 'derives',
  satisfy: 'satisfies',
  verify: 'verifies',
  refine: 'refines',
}

/** One op's outcome in the per-op results array. */
export interface OpResult {
  /** 0-based line index among the non-blank, non-comment JSONL records. */
  readonly index: number
  readonly op?: string
  readonly ok: boolean
  /** Present on success: the requirement UUID the op created or targeted. */
  readonly id?: string
  /** Present on failure: the stable error code + human message. */
  readonly code?: string
  readonly error?: string
}

/** The `data` payload of an `apply` envelope. */
export interface ApplyData {
  readonly results: OpResult[]
  readonly summary: { readonly total: number; readonly ok: number; readonly failed: number }
}

export type ApplyResult =
  | { readonly next: RequirementsDoc; readonly envelope: Envelope<ApplyData> }
  | { readonly envelope: Envelope<ApplyData> }

/** Options for {@link runApply}. */
export interface ApplyOptions {
  /** Best-effort mode: apply what succeeds instead of aborting on first error. */
  readonly continueOnError?: boolean
}

/** A single parsed op record (shape validated per-op when folded). */
type OpRecord = { op?: unknown } & Record<string, unknown>

/** Read a string field off an op record, or undefined when absent/non-string. */
function str(rec: OpRecord, key: string): string | undefined {
  const v = rec[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * Translate one op record into the core Change (or an error) against the
 * CURRENT folded document — resolving key/UUID refs through `doc` so a `ref`
 * minted earlier in the same batch resolves here. Returns the Change to apply
 * plus the id it targets, or a `{code, error}` for a per-op failure.
 */
function toChange(
  doc: RequirementsDoc,
  rec: OpRecord,
): { change: object; id?: string } | { code: string; error: string } {
  const op = rec.op
  if (typeof op !== 'string' || !(APPLY_OPS as readonly string[]).includes(op)) {
    return { code: 'ERR_USAGE', error: `Unknown or missing op "${String(op)}"` }
  }

  const resolveRef = (
    ref: string | undefined,
    field: string,
  ): { id: string } | { code: string; error: string } => {
    if (ref === undefined) return { code: 'ERR_USAGE', error: `${op} requires "${field}"` }
    const id = resolveId(doc, ref)
    return id === undefined
      ? { code: 'ERR_NOT_FOUND', error: `Requirement ${ref} not found` }
      : { id }
  }

  switch (op as ApplyOp) {
    case 'add': {
      // The create attrs are every field except the op discriminant; ChangeSchema
      // validates their shape, so a bad payload lifts to a per-op error below.
      const { op: _op, ...attrs } = rec
      const id = str(rec, 'id') ?? globalThis.crypto.randomUUID()
      return { change: { kind: 'CreateRequirement', id, attrs }, id }
    }
    case 'update': {
      const resolved = resolveRef(str(rec, 'ref'), 'ref')
      if ('code' in resolved) return resolved
      const attr = str(rec, 'attr')
      const value = rec.value
      if (attr === undefined || typeof value !== 'string') {
        return { code: 'ERR_USAGE', error: 'update op requires "attr" and a string "value"' }
      }
      return {
        change: { kind: 'UpdateAttribute', id: resolved.id, attr, value },
        id: resolved.id,
      }
    }
    case 'derive':
    case 'satisfy':
    case 'verify':
    case 'refine': {
      const from = resolveRef(str(rec, 'from'), 'from')
      if ('code' in from) return from
      const to = resolveRef(str(rec, 'to'), 'to')
      if ('code' in to) return to
      const relation = EDGE_OP_RELATION[op as 'derive' | 'satisfy' | 'verify' | 'refine']
      return {
        change: { kind: 'AddRelationship', from: from.id, relation, to: to.id },
        id: from.id,
      }
    }
    case 'remove-edge': {
      const from = resolveRef(str(rec, 'from'), 'from')
      if ('code' in from) return from
      const to = resolveRef(str(rec, 'to'), 'to')
      if ('code' in to) return to
      const relation = str(rec, 'relation')
      if (relation === undefined) {
        return { code: 'ERR_USAGE', error: 'remove-edge op requires "relation"' }
      }
      return {
        change: { kind: 'RemoveRelationship', from: from.id, relation, to: to.id },
        id: from.id,
      }
    }
    case 'delete': {
      // Accept EITHER `ref` OR `id` (both a key-or-UUID resolved the same way),
      // so the batch delete op agrees with the single-command `delete <id>`:
      // `{"op":"delete","ref":"S3"}` and `{"op":"delete","id":"S3"}` are
      // identical. `ref` wins when both are present.
      const resolved = resolveRef(str(rec, 'ref') ?? str(rec, 'id'), 'ref (or id)')
      if ('code' in resolved) return resolved
      return { change: { kind: 'DeleteRequirement', id: resolved.id }, id: resolved.id }
    }
  }
}

/** Split JSONL into (index, record|parse-error), skipping blank + `#` lines. */
function parseOps(text: string): Array<{ record: OpRecord } | { error: string }> {
  const out: Array<{ record: OpRecord } | { error: string }> = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        out.push({ error: 'op record must be a JSON object' })
      } else {
        out.push({ record: parsed as OpRecord })
      }
    } catch {
      out.push({ error: `not valid JSON: ${line.slice(0, 80)}` })
    }
  }
  return out
}

/**
 * Fold a JSONL op stream over a loaded document. See the module header for the
 * atomic-by-default vs `--continue-on-error` contract.
 */
export function runApply(
  doc: RequirementsDoc,
  text: string,
  options: ApplyOptions = {},
): ApplyResult {
  const parsed = parseOps(text)
  if (parsed.length === 0) {
    return {
      envelope: failure({
        error: 'apply received no ops (empty or comment-only input)',
        code: 'ERR_USAGE',
        suggestions: [`Usage: ${APPLY_USAGE}`, 'Provide one JSON op record per line.'],
      }),
    }
  }

  const continueOnError = options.continueOnError === true
  const results: OpResult[] = []
  let current = doc
  let anyFailure = false

  for (let index = 0; index < parsed.length; index += 1) {
    const entry = parsed[index]
    if (entry === undefined) continue

    // A line that did not even parse as a JSON object.
    if ('error' in entry) {
      results.push({ index, ok: false, code: 'ERR_USAGE', error: entry.error })
      anyFailure = true
      if (!continueOnError) return abort(results, parsed.length, entry.error, 'ERR_USAGE')
      continue
    }

    const rec = entry.record
    const opName = typeof rec.op === 'string' ? rec.op : undefined
    const built = toChange(current, rec)
    if ('code' in built) {
      results.push({ index, ...(opName ? { op: opName } : {}), ok: false, ...built })
      anyFailure = true
      if (!continueOnError) return abort(results, parsed.length, built.error, built.code)
      continue
    }

    try {
      current = applyChange(current, built.change)
      results.push({
        index,
        ...(opName ? { op: opName } : {}),
        ok: true,
        ...(built.id !== undefined ? { id: built.id } : {}),
      })
    } catch (e) {
      const code =
        e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : 'ERR_USAGE'
      const error = e instanceof Error ? e.message : String(e)
      results.push({ index, ...(opName ? { op: opName } : {}), ok: false, code, error })
      anyFailure = true
      if (!continueOnError) return abort(results, parsed.length, error, code)
    }
  }

  const okCount = results.filter((r) => r.ok).length
  const summary = { total: parsed.length, ok: okCount, failed: parsed.length - okCount }

  // Atomic mode with a failure never reaches here (it returns via abort). In
  // continue-on-error mode we still save whatever succeeded; a run with zero
  // successful ops writes nothing (no `next`) but reports the per-op failures.
  const envelope = success('apply', { results, summary })
  if (anyFailure && okCount === 0) return { envelope }
  return { next: current, envelope }
}

/**
 * Atomic-mode abort: nothing is written (`next` omitted). The failing op's
 * 0-based index and stable code go on the envelope, so the caller sees exactly
 * which line broke and knows the document is untouched. `code` is validated
 * against the ERR_* enum by {@link failure}; an unrecognized code (from an
 * unexpected core throw) falls back to ERR_USAGE so the envelope always types.
 */
function abort(results: OpResult[], total: number, error: string, code: string): ApplyResult {
  const failingIndex = results.length - 1
  const parsedCode = ErrCodeSchema.safeParse(code)
  return {
    envelope: failure({
      error: `apply aborted at op ${failingIndex} of ${total}: ${error} (atomic mode — nothing written)`,
      code: parsedCode.success ? parsedCode.data : 'ERR_USAGE',
      suggestions: [
        `Op ${failingIndex} failed with ${code}; the document is unchanged — fix that op and re-run.`,
        'Or pass --continue-on-error to apply the ops that do succeed and save once.',
      ],
    }),
  }
}
