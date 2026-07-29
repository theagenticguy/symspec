/**
 * Load-time validation for the on-disk requirements document (AC-1-4, AC-1-9).
 *
 * The v2 document is a hand-editable, pretty-printed JSON file (`storage.ts`,
 * AC-1-1), so it MUST be checked on every read: a stray hand-edit, an
 * accidental truncation, or any other malformed input must never reach the
 * rest of the pipeline unvalidated. `loadRequirementsDoc` is the single funnel
 * every command runs a document through before touching it.
 *
 * Two error paths, kept deliberately disjoint (AC-1-9's "buildability" note):
 *
 *   1. `ERR_DOC_PARSE` — the bytes are not valid JSON at all, OR they parse
 *      as JSON but fail {@link RequirementsDocSchema}. The suggestion set is
 *      generic: check the path, or `symspec init` a fresh document.
 *
 *   2. `ERR_SCHEMA_VERSION` — the bytes ARE valid JSON and DO satisfy
 *      `RequirementsDocSchema` (so this is a well-formed, current-shaped
 *      document), but `schemaVersion` does not equal the current
 *      `SCHEMA_VERSION`. This can only be reached once ERR_DOC_PARSE's gate
 *      has already passed, so the two codes never compete for the same
 *      input. Forward-looking only — it fires for a current-shaped doc
 *      carrying a version symspec does not recognize.
 *
 * Both are typed `DocLoadError` instances so callers (the CLI envelope
 * layer, later waves) can pattern-match on `.code` without re-deriving the
 * trigger logic here.
 *
 * ## AC-1-5: the schemaVersion failure reports EXECUTABLE ops
 *
 * AC-1-5 is a disjunction — the loader shall carry a prior-schema document
 * forward, OR shall report the exact ops that reproduce it. This module
 * implements the second disjunct, and it is the only one that is even
 * reachable here: the version check runs strictly AFTER
 * `RequirementsDocSchema.safeParse` succeeds, so the rejected document is
 * always readable in full and never needs its format guessed. `reproduce.ts`
 * turns that readable content into the `symspec apply` op stream (plus the
 * commands for the glossary/antonym/waiver tables `apply` has no op for, plus
 * an explicit statement of what does not come back), and the ops travel on
 * `DocLoadError.suggestions` — the one field `cli/errors.ts`'s
 * `toErrorEnvelope` forwards onto the CLI error envelope — with the structured
 * plan additionally on `DocLoadError.reproduce` for library callers.
 */

import { readFile } from 'node:fs/promises'
import type { ReproducePlan } from './reproduce.js'
import { reproducePlan, reproduceSuggestions } from './reproduce.js'
import { RequirementsDocSchema, SCHEMA_VERSION } from './schema.js'
import { deserializeDoc } from './storage.js'

export const DOC_LOAD_ERROR_CODES = ['ERR_DOC_PARSE', 'ERR_SCHEMA_VERSION'] as const
export type DocLoadErrorCode = (typeof DOC_LOAD_ERROR_CODES)[number]

/**
 * Thrown by {@link loadRequirementsDoc} / {@link parseRequirementsDoc} for
 * either of the two disjoint load-time failure modes. Carries the same
 * `{error, code, suggestions}` fields the CLI's error envelope (AC-6-2) will
 * read directly, so the envelope layer never needs to re-derive them.
 *
 * `reproduce` is set on the `ERR_SCHEMA_VERSION` path only (AC-1-5): that
 * document already satisfied `RequirementsDocSchema`, so the ops that rebuild
 * it are derivable. The `ERR_DOC_PARSE` path never sets it — a document that
 * failed to parse has no readable content to derive ops from — and per
 * `exactOptionalPropertyTypes` the key is OMITTED rather than set to
 * `undefined` there.
 */
export class DocLoadError extends Error {
  readonly code: DocLoadErrorCode
  readonly suggestions: string[]
  /**
   * The structured, machine-applicable plan that reproduces the document at the
   * current schema. Present on `ERR_SCHEMA_VERSION` only; the same ops are also
   * rendered into {@link DocLoadError.suggestions} so they survive the lift onto
   * the CLI error envelope.
   *
   * `declare` on purpose: `target: ES2022` implies `useDefineForClassFields`, so
   * a plain field declaration would emit `Object.defineProperty(this,
   * 'reproduce', {value: undefined})` and give every ERR_DOC_PARSE error an OWN
   * `reproduce` key holding `undefined` — exactly what the
   * `exactOptionalPropertyTypes` idiom forbids. `declare` emits no field, so the
   * key is genuinely ABSENT unless the constructor assigns it.
   */
  declare readonly reproduce?: ReproducePlan

  constructor(
    code: DocLoadErrorCode,
    message: string,
    suggestions: string[],
    reproduce?: ReproducePlan,
  ) {
    super(message)
    this.name = 'DocLoadError'
    this.code = code
    this.suggestions = suggestions
    if (reproduce !== undefined) this.reproduce = reproduce
  }
}

/**
 * Validate already-decoded document text against the load-time contract
 * (AC-1-4, AC-1-9). Pure — no I/O.
 *
 * Throws {@link DocLoadError} on either failure mode; returns the validated,
 * schema-parsed document (with Zod defaults applied) otherwise.
 */
export function parseRequirementsDoc(text: string) {
  let raw: unknown
  try {
    raw = deserializeDoc(text)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new DocLoadError('ERR_DOC_PARSE', `Document is not valid JSON: ${reason}`, [
      'Check the path points at a symspec requirements document (JSON).',
      'If you need a new document, run `symspec init <file>`.',
    ])
  }

  const result = RequirementsDocSchema.safeParse(raw)
  if (!result.success) {
    throw new DocLoadError(
      'ERR_DOC_PARSE',
      `Document does not satisfy RequirementsDocSchema: ${result.error.message}`,
      [
        'Fix the reported field(s), or restore from a known-good backup.',
        'If you need a new document, run `symspec init <file>`.',
      ],
    )
  }

  const doc = result.data
  // Reachable only once the document is confirmed valid JSON that satisfies
  // RequirementsDocSchema, so the two error paths never compete for one input —
  // and so the document's whole content is readable here. AC-1-5's second
  // disjunct: report the exact ops that reproduce it, not prose telling the
  // caller to retype it.
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    const plan = reproducePlan(doc)
    throw new DocLoadError(
      'ERR_SCHEMA_VERSION',
      `Document schemaVersion is ${doc.schemaVersion}, but symspec expects ${SCHEMA_VERSION}. It satisfies the current document schema, so the exact ops that reproduce it are reported: ${plan.ops.length} \`symspec apply\` op record(s)${
        plan.commands.length > 0 ? ` and ${plan.commands.length} command(s)` : ''
      } in the suggestions.`,
      reproduceSuggestions(plan, doc.schemaVersion, SCHEMA_VERSION),
      plan,
    )
  }

  return doc
}

/**
 * Read + validate the requirements document at `path`. The single funnel
 * every command runs a document through before use.
 */
export async function loadRequirementsDoc(path: string) {
  const text = await readFile(path, 'utf8')
  return parseRequirementsDoc(text)
}
