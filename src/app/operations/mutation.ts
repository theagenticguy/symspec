/**
 * THE MUTATION OPERATIONS — every way a document changes, as one table of ops over
 * one fold.
 *
 * ## Twelve operations, one implementation
 *
 * `add`, `update`, `delete`, the four edge verbs, `remove-edge`, `waive`, `glossary`,
 * `antonym`, and `apply`. Every one of them builds a `DocumentOp[]` and hands it to
 * {@link runFold}. The single-op commands fold a one-element stream; `apply` folds an
 * N-element one. So there is no per-command mutation logic that could disagree with
 * the batch path — v4's `add`/`update`/`waive`/`glossary` cores each had their
 * own, and `apply.ts` re-implemented all four a third time.
 *
 * What that buys concretely: `--dry-run` is one branch in {@link runFold} rather than
 * a per-command feature (v4 had it only on `add`), the atomic-abort semantics
 * apply to a single op as much as to a batch, and adding a verb means adding an entry
 * to `core/ops.ts` plus one table row here.
 *
 * ## `apply` is the flagship, and its op stream is the SAME vocabulary
 *
 * v4's `apply` accepted eight verbs and could not express the three side
 * tables at all — those rode out as shell command lines its `import` had to re-parse.
 * Here `apply` consumes the whole `DocumentOp` union, so a repair plan that mixes a
 * `glossary add`, two `waive`s and an `update` is ONE invocation.
 *
 * ## The manifest-vs-parser drift v4 hit, avoided by construction
 *
 * Donor lesson `manifest-single-source-derivation` records the exact failure: `apply`
 * registered `--doc` while reusing a shared `.describe()` whose prose hardcoded
 * `--file`, so the manifest told an agent to run `apply --file` and got ERR_USAGE —
 * on the flagship command. Every description here that names a flag names its OWN
 * flag, and `mutation.test.ts` asserts that property mechanically: any description
 * mentioning a backticked `--flag` must name a field this operation actually declares.
 */

import { Effect, Schema } from 'effect'
import { buildAntonymIndexWithDoc } from '../../domain/engine/formal/antonyms.ts'
import { normalize } from '../../domain/engine/formal/atomize.ts'
// STATIC. A dynamic import here bought nothing: `operations/parse.ts` imports
// `engine/parse/batch.ts` statically and that imports `result.ts` statically, so the parse
// ladder is in the main chunk on every run regardless. The lazy form only added an await
// and made the build report an ineffective dynamic import.
import { parseLine } from '../../domain/engine/parse/result.ts'
import {
  EARS_PATTERNS,
  FRAME_KINDS,
  PRIORITIES,
  RELATIONS,
  RESPONSE_KINDS,
  STATE_VAR_TYPES,
  STATUSES,
  UPDATABLE_ATTRS,
  VERIFICATION_METHODS,
} from '../../domain/requirements/document.ts'
import { type FoldResult, foldOps, type MutateOptions } from '../../domain/requirements/mutate.ts'
import { type DocumentOp, decodeOp, RELATION_EDGE_OP } from '../../domain/requirements/ops.ts'
import { DOC_PATH_CONVENTION, DocPath, DocStore } from '../../ports/doc-store.ts'
import {
  ErrDuplicateId,
  ErrDuplicateKey,
  ErrNotFound,
  ErrNullRequired,
  ErrUsage,
  type OperationalError,
} from '../../ports/errors.ts'
import { StreamSource } from '../../ports/stream.ts'
import { catalogCounts } from '../runtime/catalog.ts'
import { ok } from '../runtime/envelope.ts'
import { defineOperation } from '../runtime/operation.ts'

const lines = (...xs: readonly string[]): string => xs.join('\n')

// ---------------------------------------------------------------------------
// The shared option surface
// ---------------------------------------------------------------------------

/** The document-path field, identical across every mutation op. */
const docPathField = (verb: string) =>
  Schema.withDecodingDefaultKey<Schema.NullOr<Schema.String>>(Effect.succeed(null))(
    Schema.NullOr(Schema.String).annotate({
      default: null,
      description: lines(
        `Path to the requirements document to ${verb}.`,
        DOC_PATH_CONVENTION,
        'Example: ./requirements.json',
      ),
    }),
  )

/**
 * `--dry-run`, available on EVERY mutation op rather than just `add`.
 *
 * v4 had it only on `add`, which is backwards: the ops most worth previewing
 * are the destructive ones (`delete`) and the bulk ones (`apply`), not the additive
 * single one. Because the preview is a branch in the shared fold, giving it to all
 * twelve costs one flag declaration each and cannot behave differently per command.
 */
const dryRunField = Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
  Schema.Boolean.annotate({
    default: false,
    description: lines(
      'Preview only: compute the result and report exactly what WOULD change, then write nothing.',
      'The payload is identical to a real run apart from `written: false`, so an agent can inspect',
      'per-op outcomes, minted ids, and no-ops before committing to a file.',
    ),
  }),
)

/** An optional string field with a `null` default. NOT wrapped in `optionalKey` —
 * `withDecodingDefaultKey` already makes the key optional on the ENCODED side, and
 * adding `optionalKey` leaks `undefined` into the decoded TYPE. */
const optionalString = (description: string) =>
  Schema.withDecodingDefaultKey<Schema.NullOr<Schema.String>>(Effect.succeed(null))(
    Schema.NullOr(Schema.String).annotate({ default: null, description }),
  )

/** A required string field. */
const requiredString = (description: string) => Schema.String.annotate({ description })

/** A ref field's description, single-sourced so all nine ref-taking ops agree. */
const refDescription = (what: string): string =>
  lines(
    `The requirement to ${what}, as its stable key (e.g. TX-B6, G1) OR its UUID.`,
    'Tried as a UUID first, then as a key, so both spellings work everywhere a ref is accepted.',
    'A ref that resolves to nothing is ERR_NOT_FOUND with did-you-mean suggestions.',
  )

// ---------------------------------------------------------------------------
// The shared runner
// ---------------------------------------------------------------------------

/** The payload every mutation op returns. */
export interface MutationPayload extends Omit<FoldResult, 'document'> {
  /** The resolved document path. */
  readonly path: string
  /** Whether the document was actually WRITTEN. False on a dry run, on an atomic
   * abort, and on an all-no-op run — three different reasons, each visible in the
   * fields beside it rather than conflated into one flag. */
  readonly written: boolean
  /** Requirement count after the fold, so an agent sees the effect without a re-read. */
  readonly requirements: number
}

/**
 * The mutation-fold options the operation layer supplies.
 *
 * `core/mutate.ts` cannot import the transplanted formal tier — the dependency runs
 * the other way, and a cycle would put the atomizer in the load graph of every
 * document read. So the two functions that need it are injected HERE, which is the
 * lowest layer that legitimately knows about both.
 */
const MUTATE_OPTIONS: MutateOptions = {
  // The atomizer's own normalizer, so a committed antonym head is EXACTLY the key the
  // atomizer looks up. Storing "Open" where the atomizer looks up "open" would make
  // the committed pair silently inert — a decision recorded and not applied.
  normalizeHead: normalize,
  /**
   * The false-contradiction guard, and the reason it belongs at WRITE time.
   *
   * An antonym is the one committed record whose wrong value MANUFACTURES a conflict
   * rather than merely masking one. `buildAntonymIndexWithDoc` THROWS on an odd
   * polarity cycle (asserting a↔b when a and b already resolve to the same polarity
   * through the seed classes), and catching it here turns that into a clean
   * `ERR_USAGE` — which is what keeps the CHECK path throw-free. A hand-edited bad
   * document falls back to seed-only rather than crashing a verdict.
   */
  validateAntonyms: (pairs) => {
    try {
      buildAntonymIndexWithDoc(pairs.map((p) => [normalize(p.a), normalize(p.b)] as const))
      return undefined
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
  },
}

/**
 * Map a fold failure code onto its catalog error class.
 *
 * EXHAUSTIVE over `FOLD_ERROR_CODES` — `mutation.test.ts` asserts every code in that
 * closed set maps to a class, so a new fold failure cannot reach an agent as a
 * mystery. The fold returns plain code STRINGS because it lives in `core/` and the
 * catalog lives in `kernel/`; this is the one place that crossing happens.
 */
const toCatalogError = (
  code: string,
  error: string,
  suggestions: readonly string[],
): OperationalError => {
  const fields = { error, suggestions }
  switch (code) {
    case 'ERR_NOT_FOUND':
      return new ErrNotFound(fields)
    case 'ERR_DUPLICATE_ID':
      return new ErrDuplicateId(fields)
    case 'ERR_DUPLICATE_KEY':
      return new ErrDuplicateKey(fields)
    case 'ERR_NULL_REQUIRED':
      return new ErrNullRequired(fields)
    default:
      // ERR_USAGE, and anything a future fold code forgets to map. Defaulting to a
      // USAGE error rather than an internal one is the honest fallback: the fold only
      // fails on inputs it was given.
      return new ErrUsage(fields)
  }
}

/**
 * Load, fold, save, report — the body of every mutation operation.
 *
 * ## A single-op failure is an ERROR ENVELOPE; a batch failure is DATA
 *
 * The one place the single and batch paths legitimately differ, and the reason is what
 * an agent can do about it. A `symspec update BOGUS status approved` that resolves
 * nothing is a failed invocation: exit 2, `ERR_NOT_FOUND`, with did-you-mean
 * suggestions. Reporting that as a success envelope containing one failed result would
 * make every single-op caller inspect `results[0].ok` and would break the exit
 * contract.
 *
 * A batch is different: 40 ops of which one failed is a partially-successful run whose
 * per-op results ARE the payload, and failing the whole invocation would throw away
 * the report an agent needs to fix line 12. So `apply` reports failures as data and
 * lets the ERROR-severity count drive the exit code, exactly as `check` and `parse`
 * do.
 *
 * `single` selects which contract applies. It is not a style choice — it is the
 * difference between "your command was wrong" and "here is what happened to each of
 * your 40 commands".
 */
const runFold = (args: {
  readonly file: string | null
  readonly dryRun: boolean
  readonly ops: readonly DocumentOp[]
  /** Apply what succeeds instead of aborting on the first failure. */
  readonly continueOnError?: boolean
  /** True for the single-op commands — see the note above. */
  readonly single: boolean
}): Effect.Effect<MutationPayload, OperationalError, DocPath | DocStore> =>
  Effect.gen(function* () {
    const docPath = yield* DocPath
    const store = yield* DocStore
    const path = docPath.resolve(args.file)
    const loaded = yield* store.load(path)

    // The clock is injected into the fold rather than read inside it, so replaying one
    // stream with one timestamp is byte-reproducible.
    const timestamp = new Date().toISOString()
    const result = foldOps(loaded.document, args.ops, timestamp, {
      ...MUTATE_OPTIONS,
      ...(args.continueOnError === true ? { continueOnError: true } : {}),
    })

    // SINGLE-OP contract: a failure is an error envelope, not a payload.
    if (args.single) {
      const failure = result.results.find((r) => !r.ok)
      if (failure !== undefined) {
        return yield* Effect.fail(
          toCatalogError(
            failure.code ?? 'ERR_USAGE',
            failure.error ?? 'the operation failed',
            failure.suggestions ?? [],
          ),
        )
      }
    }

    const written = result.write && !args.dryRun
    if (written) {
      // The preserved unknown top-level keys ride along, so a mutation cannot strip a
      // forward-compatible table (v4 finding V27 — the defect was a mutation
      // round-tripping through a strip-mode parse).
      yield* store.save(path, {
        document: result.document,
        unknownKeys: loaded.unknownKeys,
      })
    }

    return {
      path,
      written,
      requirements: Object.keys(result.document.requirements).length,
      results: result.results,
      summary: result.summary,
      write: result.write,
      ...(result.abortedAt !== undefined ? { abortedAt: result.abortedAt } : {}),
    }
  })

/** Emit a mutation payload under the operation's own envelope type. */
const emitMutation = <T extends string>(type: T, payload: MutationPayload) => ok(type, payload)

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export const addOp = defineOperation({
  name: 'add',
  summary: 'Add one requirement from EARS slots, or from a parsed line of prose',
  type: 'add',
  input: Schema.Struct({
    patternType: optionalString(
      lines(
        'Which EARS template the requirement uses: ubiquitous, event-driven, state-driven,',
        'optional-feature, or unwanted-behavior.',
        `Required unless \`--from-parse\` is supplied. Legal values: ${EARS_PATTERNS.join(', ')}.`,
      ),
    ),
    systemName: optionalString(
      lines(
        "The subject of the requirement — the 'X' in 'the X shall ...'. Omit any leading article.",
        'Required unless `--from-parse` is supplied. Example: "auth service".',
      ),
    ),
    systemResponse: optionalString(
      lines(
        "What the system shall do — the verb phrase after 'shall'. Do not include 'shall' itself.",
        "Do NOT bake negation in with a leading 'not'; leave this POSITIVE and pass `--negated`.",
        'Required unless `--from-parse` is supplied. Example: "issue a session token".',
      ),
    ),
    preCondition: optionalString(
      lines(
        'Pre-condition clause. Required by the state-driven and optional-feature patterns.',
        "Phrase as a state, present tense, with no leading 'while'/'where' — the renderer adds those.",
      ),
    ),
    trigger: optionalString(
      lines(
        'Trigger clause. Required by the event-driven and unwanted-behavior patterns.',
        "Phrase as a discrete event, with no leading 'when'/'if' — the renderer adds those.",
      ),
    ),
    negated: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
      Schema.Boolean.annotate({
        default: false,
        description: lines(
          'Response-polarity flag: the requirement PROHIBITS the response.',
          "Renders 'shall not <response>' and encodes as the NEGATED atom — which is what lets",
          "'shall X' and 'shall not X' share one atom at opposite polarity so the contradiction",
          'checker sees them as opposites rather than two unrelated strings.',
          "Keep `--system-response` positive and set this flag; never write a leading 'not'.",
        ),
      }),
    ),
    key: optionalString(
      lines(
        'Optional stable human key (e.g. G1, AUTH-3, TX-B6), usable wherever a UUID is.',
        'Assigned once and NEVER changed, so it is as safe to reference as the UUID. Must be unique',
        'in the document (a duplicate is ERR_DUPLICATE_KEY).',
        'Supplying one is what lets a later op in the SAME `apply` batch reference this requirement',
        'before its minted UUID is known.',
      ),
    ),
    responseKind: optionalString(
      lines(
        'How the response relates to the declared state model (v3).',
        `Legal values: ${RESPONSE_KINDS.join(', ')}. Optional — an unclassified response is valid,`,
        'and the reachability tier reports it as a demotion rather than guessing.',
      ),
    ),
    priority: optionalString(
      `Business priority. Legal values: ${PRIORITIES.join(', ')}. Defaults to medium.`,
    ),
    status: optionalString(
      `Lifecycle status. Legal values: ${STATUSES.join(', ')}. Defaults to draft.`,
    ),
    verificationMethod: optionalString(
      `How this will be checked. Legal values: ${VERIFICATION_METHODS.join(', ')}. Optional.`,
    ),
    verificationNote: optionalString(
      'Free-text verification-plan note — which suite, which theorem, which harness. Optional.',
    ),
    fromParse: optionalString(
      lines(
        'One line of prose to parse through the Tier-1/2/3 ladder instead of supplying slots.',
        'Mutually exclusive with the slot fields. A line that will not parse is reported as the',
        'ladder`s own ERR_PARSE_* failure with its recovered `partial` skeleton and rewrite',
        'suggestions — never a half-created requirement.',
        'A COMPOUND line ("shall X and Y") is refused with the split ops attached, so the remedy is',
        '`symspec apply` on those rather than a hand rewrite.',
      ),
    ),
    file: docPathField('add to'),
    dryRun: dryRunField,
  }),
  handler: (input) =>
    Effect.gen(function* () {
      const hasSlots =
        input.patternType !== null || input.systemName !== null || input.systemResponse !== null

      if (input.fromParse !== null && hasSlots) {
        return yield* Effect.fail(
          new ErrUsage({
            error:
              '--from-parse and the structured slot flags are mutually exclusive: parse prose OR supply slots, not both.',
            suggestions: [
              'Drop --from-parse to use the slots you supplied.',
              'Drop the slot flags to parse the prose.',
            ],
          }),
        )
      }

      // THE PARSE PATH. Delegated to the same ladder `parse` uses, and its
      // `proposedOp` is consumed directly — no field-by-field transcription, which is
      // where v4 lost the `negated` flag unless `cli/add.ts` remembered it.
      if (input.fromParse !== null) {
        const parsed = yield* Effect.promise(() => parseLine(input.fromParse as string))

        if (parsed.outcome === 'skipped') {
          return yield* Effect.fail(
            new ErrUsage({
              error: `Input carries no obligation (no modal), so it cannot become a requirement: "${parsed.text}"`,
              suggestions: [
                'Phrase it as an obligation: "the <system> shall <response>".',
                'Or supply the structured slots instead of --from-parse.',
              ],
            }),
          )
        }
        if (parsed.outcome === 'error') {
          return yield* Effect.fail(
            new ErrUsage({
              error: parsed.error,
              suggestions: parsed.suggestions,
              ...(parsed.partial !== undefined ? { partial: parsed.partial } : {}),
              // The split ops when there are any — the one parse failure with a
              // MECHANICAL fix. Omitted otherwise, since an empty repair is a worse
              // signal than none.
              ...(parsed.proposedOps !== undefined && parsed.proposedOps.length > 0
                ? {
                    repair: {
                      ops: parsed.proposedOps,
                      commands: ['symspec apply --file <ops.jsonl>'],
                    },
                  }
                : {}),
            }),
          )
        }

        // A `--key` supplied alongside `--from-parse` still applies: the prose gives
        // the slots, the flag gives the handle.
        const op: DocumentOp = {
          ...parsed.proposedOp,
          ...(input.key !== null ? { key: input.key } : {}),
        }
        return emitMutation(
          'add',
          yield* runFold({ file: input.file, dryRun: input.dryRun, ops: [op], single: true }),
        )
      }

      // THE SLOTS PATH. Decoded through the op schema rather than validated here, so
      // a bad `patternType` is caught by the SAME schema `apply` uses — one validator,
      // not two that could disagree about what an `add` is.
      const raw: Record<string, unknown> = {
        op: 'add',
        ...(input.patternType !== null ? { patternType: input.patternType } : {}),
        ...(input.systemName !== null ? { systemName: input.systemName } : {}),
        ...(input.systemResponse !== null ? { systemResponse: input.systemResponse } : {}),
        ...(input.preCondition !== null ? { preCondition: input.preCondition } : {}),
        ...(input.trigger !== null ? { trigger: input.trigger } : {}),
        ...(input.negated ? { negated: true } : {}),
        ...(input.key !== null ? { key: input.key } : {}),
        ...(input.responseKind !== null ? { responseKind: input.responseKind } : {}),
        ...(input.priority !== null ? { priority: input.priority } : {}),
        ...(input.status !== null ? { status: input.status } : {}),
        ...(input.verificationMethod !== null
          ? { verificationMethod: input.verificationMethod }
          : {}),
        ...(input.verificationNote !== null ? { verificationNote: input.verificationNote } : {}),
      }

      const op = yield* Effect.mapError(
        decodeOp(raw),
        (cause) =>
          new ErrUsage({
            error: `The add is not a valid requirement: ${String(cause).replace(/\s*\n\s*/g, ' ')}`,
            suggestions: [
              '--pattern-type, --system-name and --system-response are all required (or use --from-parse).',
              `--pattern-type must be one of: ${EARS_PATTERNS.join(', ')}.`,
              'Run `symspec manifest` for every field`s exact shape.',
            ],
          }),
      )

      return emitMutation(
        'add',
        yield* runFold({ file: input.file, dryRun: input.dryRun, ops: [op], single: true }),
      )
    }),
})

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

export const updateOp = defineOperation({
  name: 'update',
  summary:
    'Set or clear one attribute on one requirement, or on every requirement matching a filter',
  type: 'update',
  input: Schema.Struct({
    ref: optionalString(
      lines(
        refDescription('update'),
        'Omit it and pass `--where` instead to update EVERY matching requirement.',
      ),
    ),
    attr: requiredString(
      lines(
        `The attribute to change. Legal values: ${UPDATABLE_ATTRS.join(', ')}.`,
        'NOT updatable, each for its own reason: `id` and `key` are immutable handles (every edge',
        'references them), `sentence` is a denormalized rendering the next slot edit would overwrite,',
        'and the timestamps are runtime-owned.',
      ),
    ),
    value: optionalString(
      lines(
        'The new value, stored verbatim. The literal string "null" is TEXT, not a clear.',
        'Omit it and pass `--clear` to remove a clearable attribute instead.',
      ),
    ),
    clear: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
      Schema.Boolean.annotate({
        default: false,
        description: lines(
          'Remove the attribute rather than setting it. Mutually exclusive with `--value`.',
          'A separate flag because argv cannot express JSON null, so "clear" and the literal string',
          '"null" would otherwise be indistinguishable. (An `apply` op stream needs no such flag —',
          'it writes `"value": null` directly.)',
          'Refused on a non-clearable attribute, and refused on a slot the requirement`s OWN pattern',
          'needs — clearing an event-driven requirement`s trigger would render "When , the ...".',
        ),
      }),
    ),
    where: optionalString(
      lines(
        'Bulk filter, as `<attr>=<value>`: apply the change to every requirement whose `<attr>`',
        'equals `<value>`. Mutually exclusive with `--ref`.',
        'The end-of-authoring promotion ritual in one call: `--where status=draft status approved`.',
        'Zero matches is a successful no-op, so it is safe to run unconditionally.',
      ),
    ),
    file: docPathField('update'),
    dryRun: dryRunField,
  }),
  handler: (input) =>
    Effect.gen(function* () {
      const usage = (error: string, ...suggestions: readonly string[]) =>
        Effect.fail(new ErrUsage({ error, suggestions }))

      if (input.clear && input.value !== null) {
        return yield* usage(
          '--clear and --value are mutually exclusive: clear REMOVES the attribute, a value SETS it.',
          'Drop --clear to set the value.',
          'Drop --value to clear the attribute.',
        )
      }
      if (!input.clear && input.value === null) {
        return yield* usage(
          'update requires --value, or --clear to remove the attribute.',
          'Pass --value <text> to set it.',
          'Pass --clear to remove it (only preCondition, trigger, verificationMethod, verificationNote and responseKind are clearable).',
        )
      }
      if (input.ref !== null && input.where !== null) {
        return yield* usage(
          '--ref and --where are mutually exclusive: update ONE requirement or every MATCHING one.',
          'Drop --where to update the named requirement.',
          'Drop --ref to update every match.',
        )
      }
      if (input.ref === null && input.where === null) {
        return yield* usage(
          'update requires --ref <key|uuid>, or --where <attr>=<value> for a bulk update.',
        )
      }

      // The value the ops carry: `null` CLEARS, a string SETS.
      const value = input.clear ? null : input.value

      // SINGLE-REF path.
      if (input.ref !== null) {
        const op = yield* decodeUpdate({ ref: input.ref, attr: input.attr, value })
        return emitMutation(
          'update',
          yield* runFold({ file: input.file, dryRun: input.dryRun, ops: [op], single: true }),
        )
      }

      // BULK path. The filter is resolved against the document, so the op stream is
      // built from real refs and every one of them then goes through the SAME fold —
      // the bulk path has no privileged access to the document.
      const where = input.where as string
      const eq = where.indexOf('=')
      if (eq <= 0) {
        return yield* usage(
          `--where expects <attr>=<value>, got "${where}".`,
          'Example: --where status=draft',
        )
      }
      const whereAttr = where.slice(0, eq)
      const whereValue = where.slice(eq + 1)

      const docPath = yield* DocPath
      const store = yield* DocStore
      const path = docPath.resolve(input.file)
      const loaded = yield* store.load(path)

      if (!(UPDATABLE_ATTRS as readonly string[]).includes(whereAttr)) {
        return yield* usage(
          `--where names "${whereAttr}", which is not a filterable attribute.`,
          `Legal values: ${UPDATABLE_ATTRS.join(', ')}.`,
        )
      }

      const matched = Object.values(loaded.document.requirements).filter(
        (r) => (r as unknown as Record<string, unknown>)[whereAttr] === whereValue,
      )
      const ops: DocumentOp[] = []
      for (const requirement of matched) {
        ops.push(yield* decodeUpdate({ ref: requirement.id, attr: input.attr, value }))
      }

      return emitMutation(
        'update',
        // NOT `single`: a bulk update over 40 requirements reports per-op results, so a
        // partial outcome is data rather than a failed invocation.
        yield* runFold({ file: input.file, dryRun: input.dryRun, ops, single: false }),
      )
    }),
})

/** Decode one `update` op, mapping a bad attr onto the catalog's own error. */
const decodeUpdate = (fields: {
  readonly ref: string
  readonly attr: string
  readonly value: string | null
}): Effect.Effect<DocumentOp, ErrUsage> =>
  Effect.mapError(
    decodeOp({ op: 'update', ...fields }),
    () =>
      new ErrUsage({
        error: `"${fields.attr}" is not an updatable attribute.`,
        suggestions: [
          `Legal values: ${UPDATABLE_ATTRS.join(', ')}.`,
          '`id`, `key` and `sentence` are deliberately immutable — see the --attr description.',
        ],
      }),
  )

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export const deleteOp = defineOperation({
  name: 'delete',
  summary: 'Delete one requirement, leaving any inbound edges as dangling references',
  type: 'delete',
  input: Schema.Struct({
    ref: requiredString(refDescription('delete')),
    file: docPathField('delete from'),
    dryRun: dryRunField,
  }),
  handler: (input) =>
    Effect.gen(function* () {
      const op: DocumentOp = { op: 'delete', ref: input.ref }
      return emitMutation(
        'delete',
        yield* runFold({ file: input.file, dryRun: input.dryRun, ops: [op], single: true }),
      )
    }),
})

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * `link` — every edge verb behind ONE operation with a `--relation` flag, plus
 * `--remove` for the inverse.
 *
 * v4 shipped five commands (`derive`, `satisfy`, `verify`, `refine`,
 * `remove-edge`) whose only difference was one string. Five table entries means five
 * manifest rows, five help blocks, and five places a description can drift; one entry
 * with a closed `--relation` means the relation set is published ONCE, from
 * `RELATIONS`, and cannot disagree with what the fold accepts.
 *
 * The `apply` op stream keeps v4's per-verb spellings (`{"op":"derive"}`),
 * because those are what a v4-emitted stream contains and the vocabulary is
 * append-only. So the CLI is one command and the stream has four verbs — a projection
 * difference, not two vocabularies.
 */
export const linkOp = defineOperation({
  name: 'link',
  summary: 'Add or remove one typed edge between two requirements',
  type: 'link',
  input: Schema.Struct({
    from: requiredString(refDescription('link FROM')),
    to: requiredString(refDescription('link TO')),
    relation: requiredString(
      lines(
        `The edge relation. Legal values: ${RELATIONS.join(', ')}.`,
        '  - derives:   a higher-level requirement this one is derived from. Must stay acyclic.',
        '  - satisfies: the goal this implementation-level requirement satisfies.',
        '  - verifies:  the requirement this verification requirement confirms.',
        '  - refines:   the requirement this one restates more specifically.',
      ),
    ),
    remove: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
      Schema.Boolean.annotate({
        default: false,
        description: lines(
          'Remove the edge instead of adding it. Both directions are IDEMPOTENT — adding an existing',
          'edge and removing an absent one are both no-op successes, so this is safe to call',
          'defensively and safe to replay.',
        ),
      }),
    ),
    file: docPathField('edit'),
    dryRun: dryRunField,
  }),
  handler: (input) =>
    Effect.gen(function* () {
      if (!(RELATIONS as readonly string[]).includes(input.relation)) {
        return yield* Effect.fail(
          new ErrUsage({
            error: `"${input.relation}" is not an edge relation.`,
            suggestions: [`Legal values: ${RELATIONS.join(', ')}.`],
          }),
        )
      }
      const relation = input.relation as (typeof RELATIONS)[number]
      // The CLI's `--relation derives` becomes the stream's `{"op":"derive"}` through
      // the ONE inverse table, which is derived from the forward one so the two cannot
      // disagree. (An earlier version matched on a name prefix; that happened to work
      // for these four verbs and would have silently mis-mapped the moment a fifth
      // relation shared a prefix with another.)
      const op: DocumentOp = input.remove
        ? { op: 'remove-edge', from: input.from, to: input.to, relation }
        : { op: RELATION_EDGE_OP[relation], from: input.from, to: input.to }

      return emitMutation(
        'link',
        yield* runFold({ file: input.file, dryRun: input.dryRun, ops: [op], single: true }),
      )
    }),
})

// ---------------------------------------------------------------------------
// The side tables
// ---------------------------------------------------------------------------

export const waiveOp = defineOperation({
  name: 'waive',
  summary: 'Commit or remove a reviewed finding waiver, optionally scoped to one requirement',
  type: 'waive',
  input: Schema.Struct({
    code: requiredString(
      lines(
        'The finding code to waive — any GTWR_*, FND_* or other code `check` emits.',
        // INTERPOLATED from the catalog, never written out — the third place this exact
        // sentence has needed it. `explain` and the installed skill body both read the
        // count for the same reason: a number that has to be hand-updated on every
        // append is a number that will be wrong, and this one reaches `waive --help`
        // and the manifest, where an agent takes it as the tool's own word.
        `Run \`symspec manifest\` for all ${catalogCounts().total} codes with their meanings.`,
        'Example: GTWR_R6_MISSING_UNITS',
      ),
    ),
    reason: optionalString(
      lines(
        'Why this finding is waived — the audit trail that distinguishes review from neglect.',
        'REQUIRED when adding. A waiver is a reasoned decision, and a future reader cannot tell one',
        'from an oversight without it.',
        'Example: "RFC 9457 is a standard identifier, not a bare quantity missing units."',
      ),
    ),
    ref: optionalString(
      lines(
        'Optional requirement scope (key or UUID). When set, only findings of `--code` naming that',
        'requirement are waived; when omitted, every finding of `--code` is waived document-wide.',
        'Resolved to the stable UUID before storing, so the waiver survives any relabeling.',
      ),
    ),
    remove: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
      Schema.Boolean.annotate({
        default: false,
        description: lines(
          'Remove the waiver instead of adding it. Matches on code AND scope, so removing an',
          'unscoped waiver does NOT remove a requirement-scoped one of the same code.',
        ),
      }),
    ),
    file: docPathField('edit'),
    dryRun: dryRunField,
  }),
  handler: (input) =>
    Effect.gen(function* () {
      if (!input.remove && input.reason === null) {
        return yield* Effect.fail(
          new ErrUsage({
            error:
              'waive requires --reason: a waiver with no audit trail is indistinguishable from neglect.',
            suggestions: [
              'Pass --reason "<why this finding does not apply>".',
              'Pass --remove to delete an existing waiver instead.',
            ],
          }),
        )
      }
      const op: DocumentOp = input.remove
        ? { op: 'unwaive', code: input.code, ...(input.ref !== null ? { ref: input.ref } : {}) }
        : {
            op: 'waive',
            code: input.code,
            reason: input.reason as string,
            ...(input.ref !== null ? { ref: input.ref } : {}),
          }
      return emitMutation(
        'waive',
        yield* runFold({ file: input.file, dryRun: input.dryRun, ops: [op], single: true }),
      )
    }),
})

export const glossaryOp = defineOperation({
  name: 'glossary',
  summary: 'Commit or remove a synonym alias — the DECIDE half of the semantic tier',
  type: 'glossary',
  input: Schema.Struct({
    canonical: requiredString(
      lines(
        'The canonical response phrasing every alias collapses to.',
        'Example: "issue a session token"',
      ),
    ),
    alias: requiredString(
      lines(
        'The synonymous phrasing that atomizes to the canonical one.',
        'Committing it here is what makes a PARAPHRASED contradiction provable rather than merely',
        'suspected: the two responses collide on one atom and the solver proves the conflict.',
        'This is the DECIDE half — the semantic tier only ever SUGGESTS these, and a cosine never',
        'reaches a verdict without this record being committed first.',
        'Example: "issue a login credential"',
      ),
    ),
    remove: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
      Schema.Boolean.annotate({
        default: false,
        description:
          'Remove the alias instead of adding it. A group left with no aliases is dropped entirely.',
      }),
    ),
    file: docPathField('edit'),
    dryRun: dryRunField,
  }),
  handler: (input) =>
    Effect.gen(function* () {
      const op: DocumentOp = {
        op: input.remove ? 'unglossary' : 'glossary',
        canonical: input.canonical,
        alias: input.alias,
      }
      return emitMutation(
        'glossary',
        yield* runFold({ file: input.file, dryRun: input.dryRun, ops: [op], single: true }),
      )
    }),
})

export const antonymOp = defineOperation({
  name: 'antonym',
  summary: 'Commit or remove a polar-opposite verb pair — the opposition twin of the glossary',
  type: 'antonym',
  input: Schema.Struct({
    a: requiredString(
      lines(
        'One response verb-head, normalized to the key the atomizer looks up. Example: "open".',
      ),
    ),
    b: requiredString('The polar-opposite verb-head, normalized the same way. Example: "shut".'),
    remove: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
      Schema.Boolean.annotate({
        default: false,
        description:
          'Remove the pair instead of adding it. The pair is UNORDERED, so either order matches.',
      }),
    ),
    file: docPathField('edit'),
    dryRun: dryRunField,
  }),
  handler: (input) =>
    Effect.gen(function* () {
      // The warning belongs on the OP, not just in the docs: this is the one committed
      // record whose wrong value MANUFACTURES a false contradiction rather than masking
      // one. The write-time consistency check (see MUTATE_OPTIONS) refuses an odd
      // polarity cycle, which is what keeps the check path throw-free — but it cannot
      // catch committing a SYNONYM pair as an antonym, because that is consistent and
      // simply wrong. Hence the emphasis in the `--b` description and in the
      // opposition finding's own message.
      const op: DocumentOp = { op: input.remove ? 'unantonym' : 'antonym', a: input.a, b: input.b }
      return emitMutation(
        'antonym',
        yield* runFold({ file: input.file, dryRun: input.dryRun, ops: [op], single: true }),
      )
    }),
})

// ---------------------------------------------------------------------------
// The state model (G4) — the authoring surface for reachability
// ---------------------------------------------------------------------------

/**
 * `state` — declare one state variable, or undeclare it with `--remove`.
 *
 * ## Why the state model is TWO operations and not one
 *
 * `state` declares a VARIABLE; `classify` labels a REQUIREMENT's response and gives
 * its expression. That split mirrors v4's own "two tables, not one" finding
 * (spec 003's AC-2-1 note): the variable set is document-scoped and the
 * effect/constraint label is requirement-scoped, and collapsing them into one command
 * would mean a flag set where half the flags are meaningless in either mode.
 *
 * `--remove` rides on this one op rather than being a peer `unstate` command, matching
 * `waive`/`glossary`/`antonym`/`link` — the CLI has one command per TABLE and a
 * `--remove` flag, while the op STREAM has the two verbs (`state` / `unstate`). A
 * projection difference, not two vocabularies.
 *
 * The `--remove` path is the one place this operation can refuse for a reason the
 * caller did not cause directly: undeclaring a variable that expressions still
 * reference is ERR_USAGE naming those requirements. That refusal is load-bearing — see
 * the `UnstateOp` header — because the alternative is a document whose next `check`
 * hangs the solver rather than reporting anything.
 */
export const stateOp = defineOperation({
  name: 'state',
  summary: 'Declare or undeclare one state variable — the document-scoped half of the state model',
  type: 'state',
  input: Schema.Struct({
    name: requiredString(
      lines(
        'The variable name, as referenced by every effect and constraint expression.',
        'Identifier-shaped: a letter or underscore, then letters, digits, underscores or dots.',
        'Must NOT be one of the reserved words and, or, not, true, false, when — those are',
        'expression syntax, so a variable named one of them could be declared and never referenced.',
        'Examples: lock_held; run_state; retry_count.',
      ),
    ),
    type: optionalString(
      lines(
        `The declared type. Legal values: ${STATE_VAR_TYPES.join(', ')}.`,
        '  - bool: two-valued. Its domain is {true,false} and is NOT declared.',
        '  - int:  integer, optionally bounded with `--min`/`--max`. Declaring BOTH bounds makes the',
        '    variable finite-domain, which is what lets a reachability query be decided rather than',
        '    merely attempted.',
        '  - enum: a finite symbolic variable. `--domain` lists its members and is REQUIRED.',
        'Required unless `--remove` is supplied.',
      ),
    ),
    domain: optionalString(
      lines(
        'For `--type enum` ONLY: the comma-separated members this variable may take.',
        'At least one member — an empty domain would give the encoder an empty state space, over which',
        'every invariant holds VACUOUSLY, so it is refused rather than accepted as a vacuous',
        'declaration. Members are identifier-shaped, because a member is written BARE in an',
        'expression (`run_state = PENDING`).',
        'Example: --domain "PENDING,RUNNING,DONE,FAILED"',
      ),
    ),
    min: optionalString(
      lines(
        'For `--type int` ONLY: the inclusive lower bound. Omit for unbounded below.',
        'An empty range (`--min` above `--max`) is refused: it describes no states at all, so every',
        'invariant over it would hold VACUOUSLY and a reachability proof would mean nothing.',
      ),
    ),
    max: optionalString(
      'For `--type int` ONLY: the inclusive upper bound. Omit for unbounded above.',
    ),
    frame: optionalString(
      lines(
        `Whether the variable persists across a step that does not write it. Legal values: ${FRAME_KINDS.join(', ')}.`,
        'DEFAULTS TO volatile, and that default is a soundness property rather than a preference.',
        '  - volatile: the variable may change freely in any step. Nothing is assumed.',
        '  - stable:   it changes ONLY when some requirement`s effect changes it — a HYPOTHESIS the',
        '    document does not otherwise state.',
        'Declaring `stable` makes `check` prove the question TWICE (once with no frame, once with the',
        'declared frames) and report the strongest honest verdict: a property that needs the frame is',
        'reported as PROVED_UNDER_HYPOTHESES naming the variables relied on, and DEMOTES `verified`.',
        'Why volatile by default: measured on this solver, a model whose variable is written by no',
        'requirement returns UNREACHABLE *with an inductive invariant* under a frame and REACHABLE',
        'without one — so a frame-by-default would make the tool prove a false answer and certify it.',
      ),
    ),
    initial: optionalString(
      lines(
        'Optional initial-state predicate over this variable, e.g. "lock_held = false".',
        'Omit when the initial value is unconstrained — an omission is a genuine `any value` rather',
        'than an implied false/zero, so it WEAKENS what can be proven rather than strengthening it.',
      ),
    ),
    remove: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
      Schema.Boolean.annotate({
        default: false,
        description: lines(
          'Undeclare the variable instead of declaring it. Removing an already-absent variable is a',
          'no-op success, so this is safe to replay.',
          'REFUSED while any requirement`s effect or constraint still references the variable — the',
          'referencing requirements are named. Allowing it would leave an UNDECLARED reference in the',
          'document, and the failure that produces at check time is an unkillable solver hang rather',
          'than an error message.',
        ),
      }),
    ),
    file: docPathField('edit'),
    dryRun: dryRunField,
  }),
  handler: (input) =>
    Effect.gen(function* () {
      if (input.remove) {
        const op: DocumentOp = { op: 'unstate', name: input.name }
        return emitMutation(
          'state',
          yield* runFold({ file: input.file, dryRun: input.dryRun, ops: [op], single: true }),
        )
      }

      if (input.type === null) {
        return yield* Effect.fail(
          new ErrUsage({
            error: 'state requires --type when declaring a variable.',
            suggestions: [
              `Legal values: ${STATE_VAR_TYPES.join(', ')}.`,
              `Example: \`symspec state --name ${input.name} --type bool\`.`,
              'Pass --remove to undeclare an existing variable instead.',
            ],
          }),
        )
      }

      // The numeric bounds arrive as STRINGS because argv has no integers, and they are
      // parsed HERE rather than declared as integer flags for one reason: `--min` and
      // `--max` are optional, and an optional integer flag would need a sentinel for
      // "absent" — which is exactly the trap `check --fail-on-unmatched` documents (a
      // negative sentinel is unreachable from a shell, and 0 is a meaningful value).
      // A string flag whose absence is `null` says it without a sentinel.
      const bound = (raw: string | null, flag: string) =>
        raw === null
          ? undefined
          : /^-?\d+$/.test(raw.trim())
            ? Number(raw.trim())
            : `--${flag} expects an integer, got ${JSON.stringify(raw)}.`

      const min = bound(input.min, 'min')
      const max = bound(input.max, 'max')
      for (const value of [min, max]) {
        if (typeof value === 'string') {
          return yield* Effect.fail(
            new ErrUsage({
              error: value,
              suggestions: [
                'Bounds are whole numbers, e.g. --min 0 --max 5.',
                'Omit the flag entirely for an unbounded direction.',
              ],
            }),
          )
        }
      }

      const raw: Record<string, unknown> = {
        op: 'state',
        name: input.name,
        type: input.type,
        ...(input.domain !== null ? { domain: input.domain.split(',').map((m) => m.trim()) } : {}),
        ...(typeof min === 'number' ? { min } : {}),
        ...(typeof max === 'number' ? { max } : {}),
        ...(input.frame !== null ? { frame: input.frame } : {}),
        ...(input.initial !== null ? { initial: input.initial } : {}),
      }

      // Decoded through the OP schema, so a bad `--type` or `--frame` is rejected by the
      // same schema `apply` uses — one validator, not two that could disagree.
      const op = yield* Effect.mapError(
        decodeOp(raw),
        (cause) =>
          new ErrUsage({
            error: `The state declaration is not valid: ${String(cause).replace(/\s*\n\s*/g, ' ')}`,
            suggestions: [
              `--type must be one of: ${STATE_VAR_TYPES.join(', ')}.`,
              `--frame must be one of: ${FRAME_KINDS.join(', ')}.`,
              'Run `symspec manifest` for every field`s exact shape.',
            ],
          }),
      )

      return emitMutation(
        'state',
        yield* runFold({ file: input.file, dryRun: input.dryRun, ops: [op], single: true }),
      )
    }),
})

/**
 * `state-initial` — set or clear the model-wide initial-state predicate.
 *
 * Its own operation rather than a flag on `state`, because it is scoped to the MODEL
 * and not to a variable: it exists precisely for the cross-variable constraints a
 * per-variable `--initial` cannot express (`not (lock_held and pending)`). Hanging it
 * off `state --name` would require naming a variable it is not about.
 */
export const stateInitialOp = defineOperation({
  name: 'state-initial',
  summary: 'Set or clear the model-wide initial-state predicate over the declared variables',
  type: 'stateInitial',
  input: Schema.Struct({
    predicate: optionalString(
      lines(
        'The initial-state predicate over the DECLARED state variables — what holds before any',
        'requirement has fired. Conjoined with every per-variable `initial`, so the two are additive',
        'and adding either can only NARROW the initial states.',
        'Use this for the cross-variable constraints a per-variable initial cannot express.',
        'Every referenced name must be declared: an undeclared reference is ERR_USAGE here rather',
        'than a solver hang later.',
        'Omit it and pass `--clear` to remove the predicate instead.',
        'Examples: "run_state = PENDING and retry_count = 0"; "not (lock_held and pending)".',
      ),
    ),
    clear: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
      Schema.Boolean.annotate({
        default: false,
        description: lines(
          'Remove the model-wide initial predicate. Mutually exclusive with `--predicate`.',
          'Clearing WIDENS the initial states (every state becomes a possible start), which can only',
          'make fewer things provable — the safe direction.',
        ),
      }),
    ),
    file: docPathField('edit'),
    dryRun: dryRunField,
  }),
  handler: (input) =>
    Effect.gen(function* () {
      if (input.clear && input.predicate !== null) {
        return yield* Effect.fail(
          new ErrUsage({
            error:
              '--clear and --predicate are mutually exclusive: clear REMOVES the predicate, a value SETS it.',
            suggestions: ['Drop --clear to set the predicate.', 'Drop --predicate to clear it.'],
          }),
        )
      }
      if (!input.clear && input.predicate === null) {
        return yield* Effect.fail(
          new ErrUsage({
            error: 'state-initial requires --predicate, or --clear to remove it.',
            suggestions: [
              'Pass --predicate "<expression over declared variables>".',
              'Pass --clear to remove the model-wide initial predicate.',
            ],
          }),
        )
      }
      const op: DocumentOp = {
        op: 'state-initial',
        predicate: input.clear ? null : (input.predicate as string),
      }
      return emitMutation(
        'stateInitial',
        yield* runFold({ file: input.file, dryRun: input.dryRun, ops: [op], single: true }),
      )
    }),
})

/**
 * `classify` — label one requirement's response as an effect or a constraint, WITH the
 * expression that says what it does.
 *
 * ## Why the label and the expression are one command
 *
 * Because a label alone is a classification that reads as finished and is not: a
 * requirement marked `effect` with no `stateEffect` contributes nothing to the
 * transition relation, so the reachability tier sees a document that looks classified
 * and has no state model to encode. `--kind` and `--expression` therefore arrive
 * together and the fold refuses one without the other, which makes the easy path the
 * complete one.
 *
 * The alternative — `update responseKind` then `update stateEffect` — still WORKS
 * (both are updatable attributes, because a state model is authored iteratively and
 * editing one expression without restating the label has to be possible), and the
 * `update` path carries the same validation. This op exists so the COMMON case is one
 * call that cannot land half-done.
 */
export const classifyOp = defineOperation({
  name: 'classify',
  summary:
    "Classify one requirement's response as an effect or a constraint, with its state expression",
  type: 'classify',
  input: Schema.Struct({
    ref: requiredString(refDescription('classify')),
    kind: optionalString(
      lines(
        `How the response relates to the state model. Legal values: ${RESPONSE_KINDS.join(', ')}.`,
        '  - effect:     the response CHANGES state. `--expression` is one or more comma-separated',
        '    updates, `<variable> := <expression>`. Several updates happen in ONE step.',
        '  - constraint: the response RESTRICTS state. `--expression` is a PREDICATE the reachability',
        '    tier tries to violate — if no reachable state violates it, that is a proof.',
        'Required unless `--retract` is supplied.',
      ),
    ),
    expression: optionalString(
      lines(
        'What the response does, in the state-model expression language.',
        'For `--kind effect`: an optional GUARD then the updates —',
        '`when <predicate>: <variable> := <value>`, comma-separated for simultaneous updates.',
        'Note `:=` ASSIGNS; a single `=` is the equality COMPARISON and belongs in a constraint.',
        'THE GUARD is what an EARS trigger means formally, written explicitly over declared',
        'variables rather than inferred from the prose trigger slot (guessing one would make the',
        'solver prove the wrong thing). OMITTING it means the effect fires from EVERY state — the',
        'sound default, since it admits more transitions and so proves strictly less, but usually',
        'not what a triggered requirement means.',
        'For `--kind constraint`: a predicate that must hold in every reachable state.',
        'GRAMMAR: comparisons = != < <= > >=; arithmetic + - on ints; and/or/not; parentheses;',
        'true/false and integer literals; and bare names resolved against the declared state model.',
        'No multiplication (it makes the transition relation nonlinear, where an unbounded solver',
        'hang was measured), no quantifiers, no chained comparisons (write `a < b and b < c`).',
        '< <= > >= are INTEGER-ONLY: an enum has a declared DOMAIN, not an ORDER.',
        'EVERY referenced name must be declared with `symspec state` first. An undeclared reference',
        'is refused HERE, at authoring time, because reaching the Horn encoder it would hang the',
        'solver unkillably rather than produce an error.',
        'Examples: "when pending: lock_held := true"; "when granted = 0: granted := granted + 1";',
        '"run_state := RUNNING, retry_count := 0"; "not (lock_held and pending)"; "retry_count <= 3".',
      ),
    ),
    retract: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
      Schema.Boolean.annotate({
        default: false,
        description: lines(
          'Remove the classification: clears the responseKind AND its expression.',
          'Both, deliberately — an expression left behind with no label is a predicate nothing reads,',
          'i.e. a decision recorded and not applied.',
          'Retracting DEMOTES the reachability tier for this requirement (its response becomes',
          'unclassified again), which is the honest direction: the tier now knows less, and says so.',
        ),
      }),
    ),
    file: docPathField('edit'),
    dryRun: dryRunField,
  }),
  handler: (input) =>
    Effect.gen(function* () {
      if (input.retract) {
        if (input.kind !== null || input.expression !== null) {
          return yield* Effect.fail(
            new ErrUsage({
              error:
                '--retract removes the classification, so it cannot be combined with --kind or --expression.',
              suggestions: [
                'Drop --retract to set a classification.',
                'Drop --kind/--expression to retract the existing one.',
              ],
            }),
          )
        }
        const op: DocumentOp = { op: 'classify', ref: input.ref, kind: null }
        return emitMutation(
          'classify',
          yield* runFold({ file: input.file, dryRun: input.dryRun, ops: [op], single: true }),
        )
      }

      if (input.kind === null) {
        return yield* Effect.fail(
          new ErrUsage({
            error: 'classify requires --kind, or --retract to remove an existing classification.',
            suggestions: [
              `Legal values: ${RESPONSE_KINDS.join(', ')}.`,
              `Example: \`symspec classify ${input.ref} --kind constraint --expression "not (lock_held and pending)"\`.`,
            ],
          }),
        )
      }

      const raw: Record<string, unknown> = {
        op: 'classify',
        ref: input.ref,
        kind: input.kind,
        ...(input.expression !== null ? { expression: input.expression } : {}),
      }
      const op = yield* Effect.mapError(
        decodeOp(raw),
        (cause) =>
          new ErrUsage({
            error: `The classification is not valid: ${String(cause).replace(/\s*\n\s*/g, ' ')}`,
            suggestions: [
              `--kind must be one of: ${RESPONSE_KINDS.join(', ')}.`,
              'Run `symspec manifest` for every field`s exact shape.',
            ],
          }),
      )

      return emitMutation(
        'classify',
        yield* runFold({ file: input.file, dryRun: input.dryRun, ops: [op], single: true }),
      )
    }),
})

// ---------------------------------------------------------------------------
// apply — the flagship
// ---------------------------------------------------------------------------

export const applyOpDefinition = defineOperation({
  name: 'apply',
  summary: 'Apply a JSONL stream of document ops in one process and one atomic write',
  type: 'apply',
  input: Schema.Struct({
    // NAMED `--ops`, and the name matters: v4's `apply` registered `--doc` for
    // the DOCUMENT while reusing a shared description whose prose said `--file`, so its
    // manifest told an agent to run `apply --file` and got ERR_USAGE. Here the stream
    // is `--ops` and the document is `--file`, each described by its own text naming
    // its own flag.
    ops: optionalString(
      lines(
        'Path to the JSONL op stream: one `{"op":...}` record per line. Omit to read STDIN.',
        'Blank lines and `#` comments are skipped, so a stream can be annotated.',
        'Every op verb `symspec manifest` publishes is accepted — including the three side tables',
        '(`glossary`, `antonym`, `waive`) v4 could only express as shell commands.',
        'A `key` minted by an `add` earlier in the SAME stream is referenceable by later ops, which',
        'is what removes the label-to-UUID sidecar file entirely.',
        'Example: --ops ./repair-plan.jsonl',
      ),
    ),
    file: docPathField('apply to'),
    continueOnError: Schema.withDecodingDefaultKey<Schema.Boolean>(Effect.succeed(false))(
      Schema.Boolean.annotate({
        default: false,
        description: lines(
          'Best-effort mode: apply the ops that succeed instead of aborting on the first failure.',
          'ATOMIC by default — any failure writes NOTHING and reports the failing op`s index, so a',
          'crashed batch leaves the document untouched and the resume story is "fix that line and',
          're-run" rather than "work out how far it got".',
          'Best-effort is the mode a REPAIR PLAN wants: an op that is already applied (a no-op) or',
          'that names a requirement someone deleted should not block the eight repairs that do apply.',
        ),
      }),
    ),
    dryRun: dryRunField,
  }),
  handler: (input) =>
    Effect.gen(function* () {
      const reader = yield* StreamSource
      const text = yield* reader.read(input.ops)

      if (text.trim().length === 0) {
        return yield* Effect.fail(
          new ErrUsage({
            error:
              input.ops === null
                ? 'No op stream on stdin. Pipe records in, or pass --ops <path>.'
                : `The op stream at ${input.ops} is empty or contains only comments.`,
            suggestions: [
              'Pipe a plan: `symspec check --field data.coverage.demotions | ... | symspec apply`.',
              'Or read a file: `symspec apply --ops ./repair-plan.jsonl`.',
              'Get a ready-made stream from `symspec parse --field data.opsJsonl`.',
            ],
          }),
        )
      }

      // Decode EVERY line before folding any of it, so a malformed record is reported
      // with its line number rather than as an abort partway through.
      const ops: DocumentOp[] = []
      const problems: { readonly line: number; readonly detail: string }[] = []
      const rawLines = text.split(/\r?\n/)
      for (let i = 0; i < rawLines.length; i += 1) {
        const line = (rawLines[i] ?? '').trim()
        if (line.length === 0 || line.startsWith('#')) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch (cause) {
          problems.push({
            line: i + 1,
            detail: `not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
          })
          continue
        }
        const decoded = yield* Effect.result(decodeOp(parsed))
        if (decoded._tag === 'Failure') {
          problems.push({
            line: i + 1,
            detail: `rejected: ${String(decoded.failure).replace(/\s*\n\s*/g, ' ')}`,
          })
          continue
        }
        ops.push(decoded.success)
      }

      // A malformed line is a USAGE error in atomic mode: the stream as given cannot be
      // applied, and applying the well-formed subset would be a partial write the
      // caller did not ask for.
      if (problems.length > 0 && input.continueOnError !== true) {
        return yield* Effect.fail(
          new ErrUsage({
            error:
              `${problems.length} op record(s) could not be read, so nothing was applied ` +
              `(atomic mode): ${problems.map((p) => `line ${p.line} ${p.detail}`).join('; ')}`,
            suggestions: [
              'Fix the named lines and re-run — the document is unchanged.',
              'Or pass --continue-on-error to apply the records that ARE valid.',
              'Run `symspec manifest` for every op verb and its exact fields.',
            ],
          }),
        )
      }

      const payload = yield* runFold({
        file: input.file,
        dryRun: input.dryRun,
        ops,
        ...(input.continueOnError === true ? { continueOnError: true } : {}),
        single: false,
      })
      return ok('apply', { ...payload, problems })
    }),
})
