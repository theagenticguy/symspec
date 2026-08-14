/**
 * The DOCUMENT operations: `init`, `list`, `show`.
 *
 * Appending each to the table in `./index.ts` is the ONLY edit that makes it
 * appear in the CLI tree, the manifest, and `--help` — no second registration, no
 * hand-written manifest row, no description corpus.
 *
 * ## The shared doc-path field
 *
 * All three take the same optional `file` field with the same description, built
 * by one {@link docPathField} factory rather than restated three times. The
 * resolution rule itself is a single exported constant in `store.ts`, quoted here,
 * so `--help`, the manifest, and every error message that mentions precedence all
 * cite the same string.
 *
 * ## Reads disclose, they do not gate
 *
 * `list` and `show` both surface the load's `diagnostics` on their payload. That
 * is the V27 disclosure reaching an agent: a document carrying an unknown
 * top-level key or a hand-edited sentence says so on every read, at `info`
 * severity, so the exit code stays 0 and the fact is nonetheless visible. A
 * disclosure an agent never sees is not a disclosure.
 */

import { Effect, Schema } from 'effect'
import {
  DOC_VERSION,
  type DocumentDiagnostic,
  emptyDocument,
  type Requirement,
} from '../../domain/requirements/document.ts'
import { requireRequirement } from '../../domain/requirements/resolve.ts'
import { DOC_PATH_CONVENTION, DocPath, DocStore } from '../../ports/doc-store.ts'
import { ErrDocExists, type ErrNotFound } from '../../ports/errors.ts'
import { ok } from '../runtime/envelope.ts'
import { defineOperation } from '../runtime/operation.ts'

// ---------------------------------------------------------------------------
// The shared doc-path input field
// ---------------------------------------------------------------------------

/**
 * The optional document-path field every document operation takes.
 *
 * `NullOr` + a `null` default rather than `optionalKey`, because this field
 * crosses the CLI boundary: an unsupplied positional argument or flag arrives as
 * "nothing", and `null` is the one JSON value that says so on a wire an agent may
 * also be writing by hand. Inside the handler it goes straight to
 * `DocPath.resolve`, which treats `null` and `undefined` identically — so the
 * boundary convention costs no branch at the point of use.
 *
 * The annotation carries the DEFAULT explicitly alongside the decoding default,
 * because `withDecodingDefaultKey` does not emit one into the JSON Schema and
 * `defineOperation` fails construction on an optional field the manifest cannot
 * describe.
 */
const docPathField = (verb: string) =>
  Schema.withDecodingDefaultKey<Schema.optionalKey<Schema.NullOr<Schema.String>>>(
    Effect.succeed(null),
  )(
    Schema.optionalKey(
      Schema.NullOr(Schema.String).annotate({
        default: null,
        description: [
          `Path to the requirements document to ${verb}.`,
          DOC_PATH_CONVENTION,
          'Example: ./requirements.json',
        ].join('\n'),
      }),
    ),
  )

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/**
 * `init` — create an empty v3 document.
 *
 * ## It REFUSES to overwrite, and that is the whole design
 *
 * A requirements document is hand-authored work; `init` clobbering one would be
 * unrecoverable. So an existing file at the resolved path is `ERR_DOC_EXISTS` —
 * whose catalog text already promises "the existing file is left intact" — and
 * `--force` is the explicit opt-in. Refusing by default is not caution, it is the
 * only behavior that lets an agent call `init` speculatively (to make sure a
 * document exists) without risking the document it was about to read.
 *
 * The check is a genuine TOCTOU race in principle — the file could appear between
 * the `exists` and the `save`. It is not worth closing here: the failure mode is
 * "an agent's own concurrent init overwrote its own empty document with another
 * empty document", which is harmless, and closing it would mean an exclusive-create
 * primitive the atomic-rename write deliberately does not use.
 */
export const initOp = defineOperation({
  name: 'init',
  summary: 'Create an empty requirements document at the resolved path',
  type: 'init',
  input: Schema.Struct({
    file: docPathField('create'),
    force: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
      Schema.Boolean.annotate({
        default: false,
        description: [
          'Overwrite an existing document at the resolved path.',
          'Without this, an existing file is an ERR_DOC_EXISTS failure and is left completely intact —',
          'so `init` is safe to call speculatively against a document you were about to read.',
        ].join('\n'),
      }),
    ),
  }),
  handler: (input) =>
    Effect.gen(function* () {
      const docPath = yield* DocPath
      const store = yield* DocStore
      const path = docPath.resolve(input.file)

      if (!input.force && (yield* store.exists(path))) {
        return yield* Effect.fail(
          new ErrDocExists({
            error: `A document already exists at ${path}; init refused to overwrite it.`,
            suggestions: [
              'Pass --force to recreate it, or choose a different path.',
              'The existing file was NOT modified.',
              `Run \`symspec list ${path}\` to see what is in it.`,
            ],
            repair: { ops: [], commands: [`symspec list ${path}`] },
          }),
        )
      }

      const document = emptyDocument()
      yield* store.save(path, { document })
      return ok('init', {
        path,
        docVersion: DOC_VERSION,
        created: true,
        overwritten: input.force,
        requirements: 0,
      })
    }),
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * One row of `list` output: enough to identify and triage a requirement without
 * fetching it, and no more.
 *
 * Deliberately NOT the whole requirement. `list` over a 42-requirement document
 * is the call an agent makes to ORIENT, and returning every field would make it as
 * expensive as reading the file — which the agent could have done itself. `sentence`
 * is included because it is the one field that makes a row humanly identifiable;
 * everything else here is a handle or a triage axis.
 */
interface ListRow {
  readonly id: string
  readonly key?: string
  readonly patternType: string
  readonly priority: string
  readonly status: string
  readonly sentence: string
}

/** Project a requirement onto its list row, omitting an absent key rather than
 * emitting `null` — the same absence-is-absence rule the schema follows. */
const listRow = (r: Requirement): ListRow => ({
  id: r.id,
  ...(r.key !== undefined ? { key: r.key } : {}),
  patternType: r.patternType,
  priority: r.priority,
  status: r.status,
  sentence: r.sentence,
})

/**
 * `list` — every requirement's handles and triage axes, plus the document's
 * summary counts.
 *
 * Rows are sorted by KEY where present (keys are what a human reads and reasons
 * about), then by UUID for keyless requirements, so output is deterministic across
 * runs and diffable between them. A document mixing keyed and keyless requirements
 * — both hex-bonk fixtures do, one way or the other — gets a stable, readable
 * order rather than whatever the map iteration happened to produce.
 */
export const listOp = defineOperation({
  name: 'list',
  summary: 'List every requirement in the document with its key, UUID, and canonical sentence',
  type: 'list',
  input: Schema.Struct({ file: docPathField('read') }),
  handler: (input) =>
    Effect.gen(function* () {
      const docPath = yield* DocPath
      const store = yield* DocStore
      const path = docPath.resolve(input.file)
      const loaded = yield* store.load(path)
      const doc = loaded.document

      const rows = Object.values(doc.requirements)
        .map(listRow)
        .sort((a, b) => {
          // Keyed requirements first, in key order; then keyless, in UUID order.
          // Two keyless rows compare by id, two keyed rows by key, and a keyed row
          // always precedes a keyless one.
          if (a.key !== undefined && b.key !== undefined) return a.key.localeCompare(b.key)
          if (a.key !== undefined) return -1
          if (b.key !== undefined) return 1
          return a.id.localeCompare(b.id)
        })

      return ok('list', {
        path,
        docVersion: doc.docVersion,
        count: rows.length,
        requirements: rows,
        counts: {
          edges: countEdges(doc.requirements),
          glossary: doc.glossary.length,
          antonyms: doc.antonyms.length,
          waivers: doc.waivers.length,
          stateVariables: doc.stateModel.variables.length,
        },
        diagnostics: loaded.diagnostics satisfies readonly DocumentDiagnostic[],
      })
    }),
})

/** Total outbound edges across every relation — the one aggregate that tells an
 * agent whether a document has a graph at all. */
const countEdges = (requirements: Readonly<Record<string, Requirement>>): number => {
  let total = 0
  for (const r of Object.values(requirements)) {
    total += r.derives.length + r.satisfies.length + r.verifies.length + r.refines.length
  }
  return total
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

/**
 * `show <ref>` — one requirement in full, addressed by UUID or stable key.
 *
 * Resolution goes through {@link requireRequirement}, the single chokepoint, so
 * `show` accepts a key for free and a miss produces `ERR_NOT_FOUND` with
 * did-you-mean suggestions and a runnable repair command. Nothing about key
 * handling lives in this operation, which is the point: the next ref-taking
 * operation gets the same behavior by calling the same guard, and cannot get it
 * subtly different.
 *
 * The payload includes `resolvedFrom` — the raw ref the caller passed — alongside
 * the requirement's own `id`. An agent that resolved by key then wants to write an
 * edge needs the UUID, and making the mapping explicit in the response saves it a
 * second lookup and stops it from persisting the key by mistake.
 */
export const showOp = defineOperation({
  name: 'show',
  summary: 'Show one requirement in full, addressed by its stable key or its UUID',
  type: 'requirement',
  input: Schema.Struct({
    ref: Schema.String.annotate({
      description: [
        'The requirement to show, as its stable key (e.g. TX-B6, G1) OR its UUID.',
        'Tried as a UUID first, then as a key, so both spellings work everywhere a ref is accepted.',
      ].join('\n'),
    }),
    file: docPathField('read'),
  }),
  handler: (input) =>
    Effect.gen(function* () {
      const docPath = yield* DocPath
      const store = yield* DocStore
      const path = docPath.resolve(input.file)
      const loaded = yield* store.load(path)

      const found = requireRequirement(loaded.document, input.ref)
      if (isNotFound(found)) return yield* Effect.fail(found)

      return ok('requirement', {
        path,
        resolvedFrom: input.ref,
        requirement: found,
        diagnostics: loaded.diagnostics satisfies readonly DocumentDiagnostic[],
      })
    }),
})

/**
 * Narrow `requireRequirement`'s return to its failure branch.
 *
 * `Requirement | ErrNotFound` needs a discriminator, and `_tag` is the honest one:
 * it is the ERR_* class's own tag, so this cannot drift from the catalog. Checking
 * for the tag (rather than for the absence of a requirement field) also means a
 * future requirement field named `_tag` would be a compile error here instead of a
 * silent misclassification.
 */
const isNotFound = (value: Requirement | ErrNotFound): value is ErrNotFound =>
  '_tag' in value && value._tag === 'ERR_NOT_FOUND'
