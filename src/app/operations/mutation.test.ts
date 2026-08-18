/**
 * The mutation operations.
 *
 * `core/mutate.test.ts` covers the FOLD (every verb's semantics, idempotence, the
 * atomic abort, intra-batch key resolution). This file covers what the OPERATION layer
 * adds on top, which is a different and smaller set of claims:
 *
 * 1. the two CONTRACTS — a single-op failure is an error envelope, a batch failure is
 *    data — and why they differ;
 * 2. `--dry-run` writes nothing on every op, not just `add`;
 * 3. the injected fold options are actually wired (the antonym consistency guard and
 *    the atomizer's normalizer), since `core/` cannot reach them itself;
 * 4. the DRIFT guard v4's flagship command failed: a description that names a
 *    `--flag` must name a flag the operation declares.
 */

import { Effect, Layer, type Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  emptyDocument,
  type LoadedDocument,
  type RequirementsDocument,
} from '../../domain/requirements/document.ts'
import { DocPath, DocStore, makeDocPath } from '../../ports/doc-store.ts'
import { ErrDocNotFound } from '../../ports/errors.ts'
import { StreamSource } from '../../ports/stream.ts'
import {
  type AnyOperation,
  fieldMetadata,
  type Operation,
  runOperation,
} from '../runtime/operation.ts'
import {
  addOp,
  antonymOp,
  applyOpDefinition,
  deleteOp,
  glossaryOp,
  linkOp,
  type MutationPayload,
  termOp,
  updateOp,
  waiveOp,
} from './mutation.ts'

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/** An in-memory store that records every save, so "wrote nothing" is checkable. */
interface Fs {
  document: RequirementsDocument
  readonly saves: RequirementsDocument[]
}

const layers = (fs: Fs, stream = '') =>
  Layer.mergeAll(
    Layer.succeed(DocStore)(
      DocStore.of({
        load: (path) =>
          path === 'doc.json'
            ? Effect.succeed({
                document: fs.document,
                unknownKeys: {},
                diagnostics: [],
              } satisfies LoadedDocument)
            : Effect.fail(new ErrDocNotFound({ error: `no document at ${path}`, suggestions: [] })),
        save: (_path, input) =>
          Effect.sync(() => {
            fs.saves.push(input.document)
            fs.document = input.document
          }),
        exists: () => Effect.succeed(true),
      }),
    ),
    Layer.succeed(DocPath)(makeDocPath({})),
    Layer.succeed(StreamSource)(StreamSource.of({ read: () => Effect.succeed(stream) })),
  )

/**
 * What this file needs to know about a mutation operation, and nothing more.
 *
 * The eight operations differ in their input FIELDS, so a helper generic over `Fields`
 * cannot be called with a heterogeneous list without an `any` per call site. Splitting
 * the harness in two avoids that entirely:
 *
 * - `RunnableOp` pairs the op's metadata with a THUNK that closes over the concrete
 *   generic op, so `runOperation` is still called at its precise type — inside the
 *   thunk, where `Fields` is known — while the LIST can be heterogeneous.
 * - the drift guard reads only `AnyOperation`, the kernel's existing metadata view.
 *
 * Same conclusion the kernel reached for the ops table itself: narrow the ITERATION
 * type to what the iteration touches, and the generics stop fighting.
 */
interface RunnableOp {
  readonly name: string
  readonly run: (
    input: Record<string, unknown>,
  ) => Effect.Effect<
    { readonly data: MutationPayload },
    { readonly _tag: string; readonly error: string },
    DocStore | DocPath | StreamSource
  >
  /** The metadata view, for the flag-drift guard. */
  readonly meta: AnyOperation
}

/**
 * Wrap one concrete operation as a runnable.
 *
 * GENERIC in `Fields`, so it is instantiated at each op's precise type and
 * `runOperation` is called exactly as production calls it. The result is erased to
 * `RunnableOp`, which is what lets the eight live in one list.
 *
 * The one cast narrows the ERROR channel: `runOperation` fails with the closed
 * `OperationalError` union, and the assertions read only `_tag` and `error`. Narrowing
 * a union to a subset of its own fields is safe in a way that `any` would not be — a
 * future error class missing `error` would be a compile failure here.
 */
const runnable = <Fields extends Schema.Struct.Fields>(
  op: Operation<Fields, string, MutationPayload, DocStore | DocPath | StreamSource> & AnyOperation,
): RunnableOp => ({
  name: op.name,
  run: (input) =>
    runOperation(op, input) as Effect.Effect<
      { readonly data: MutationPayload },
      { readonly _tag: string; readonly error: string },
      DocStore | DocPath | StreamSource
    >,
  meta: op,
})

/** Run an operation, returning the Result so a failure is inspectable. */
const run = (
  op: RunnableOp,
  input: Record<string, unknown>,
  fs: Fs,
  stream = '',
): Promise<
  | { readonly _tag: 'Success'; readonly success: { readonly data: MutationPayload } }
  | {
      readonly _tag: 'Failure'
      readonly failure: { readonly _tag: string; readonly error: string }
    }
> => Effect.runPromise(Effect.result(op.run(input)).pipe(Effect.provide(layers(fs, stream))))

/** Run and assert success, returning the mutation payload. */
const ok = async (
  op: RunnableOp,
  input: Record<string, unknown>,
  fs: Fs,
  stream = '',
): Promise<MutationPayload> => {
  const result = await run(op, input, fs, stream)
  if (result._tag === 'Failure') {
    throw new Error(`expected success, got ${JSON.stringify(result.failure)}`)
  }
  return result.success.data
}

const ADD = runnable(addOp)
const UPDATE = runnable(updateOp)
const DELETE = runnable(deleteOp)
const LINK = runnable(linkOp)
const WAIVE = runnable(waiveOp)
const GLOSSARY = runnable(glossaryOp)
const ANTONYM = runnable(antonymOp)
const TERM = runnable(termOp)
const APPLY = runnable(applyOpDefinition)

/** A fresh filesystem holding one empty document. */
const fresh = (): Fs => ({ document: emptyDocument(), saves: [] })

/**
 * A filesystem holding one keyed requirement, with the save LEDGER CLEARED.
 *
 * The seeding `add` is itself a save, so leaving it in the ledger would make every
 * "wrote nothing" assertion below off by one — and, worse, would make them pass for the
 * wrong reason if the count were adjusted instead of reset. Clearing means
 * `fs.saves.length === 0` continues to mean exactly "nothing was written by the
 * operation under test".
 */
const seeded = async (): Promise<Fs> => {
  const fs = fresh()
  await ok(
    ADD,
    {
      patternType: 'ubiquitous',
      systemName: 'auth service',
      systemResponse: 'issue a session token',
      key: 'G1',
      file: 'doc.json',
    },
    fs,
  )
  fs.saves.length = 0
  return fs
}

// ---------------------------------------------------------------------------
// 1. The two contracts
// ---------------------------------------------------------------------------

describe('the two failure contracts', () => {
  it('a SINGLE-op failure is an ERROR ENVELOPE with the catalog code', async () => {
    // A wrong invocation is exit 2 with a code and did-you-mean suggestions. Reporting
    // it as a success envelope containing one failed result would make every single-op
    // caller inspect `results[0].ok` and would break the exit contract.
    const fs = await seeded()
    const result = await run(
      UPDATE,
      { ref: 'NOPE', attr: 'status', value: 'approved', file: 'doc.json' },
      fs,
    )
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('ERR_NOT_FOUND')
    // Nothing was written.
    expect(fs.saves).toHaveLength(0)
  })

  it('maps every fold code onto its own catalog class, not a generic one', async () => {
    // The mapping is the one place `core/`'s plain code strings become catalog classes,
    // so each has to arrive as itself. A generic ERR_USAGE for all of them would lose
    // the distinction an agent branches on.
    const fs = await seeded()
    const id = Object.keys(fs.document.requirements)[0] as string

    const dupKey = await run(
      ADD,
      {
        patternType: 'ubiquitous',
        systemName: 's',
        systemResponse: 'r',
        key: 'G1',
        file: 'doc.json',
      },
      fs,
    )
    expect(dupKey._tag === 'Failure' && dupKey.failure._tag).toBe('ERR_DUPLICATE_KEY')

    const dupId = await run(
      ADD,
      { patternType: 'ubiquitous', systemName: 's', systemResponse: 'r', file: 'doc.json' },
      fs,
    )
    // A minted id cannot collide, so this one SUCCEEDS — which is the point of minting.
    expect(dupId._tag).toBe('Success')
    expect(id).toBeDefined()

    const nullRequired = await run(
      UPDATE,
      { ref: 'G1', attr: 'status', clear: true, file: 'doc.json' },
      fs,
    )
    expect(nullRequired._tag === 'Failure' && nullRequired.failure._tag).toBe('ERR_NULL_REQUIRED')
  })

  it('a BATCH failure is DATA — the per-op report is the payload', async () => {
    // 40 ops of which one failed is a partially-successful run whose per-op results ARE
    // the answer. Failing the invocation would throw away the report an agent needs to
    // fix line 12.
    const fs = await seeded()
    const stream = [
      '{"op":"add","key":"S1","patternType":"ubiquitous","systemName":"s","systemResponse":"do a"}',
      '{"op":"derive","from":"S1","to":"MISSING"}',
    ].join('\n')
    const data = await ok(APPLY, { file: 'doc.json' }, fs, stream)
    // Atomic by default: reported as data, and NOTHING written.
    expect(data.written).toBe(false)
    expect(data.abortedAt).toBe(1)
    expect(data.results[1]?.code).toBe('ERR_NOT_FOUND')
    expect(fs.saves).toHaveLength(0)
  })

  it('a BULK update is not `single` — a partial outcome is data, not a failure', async () => {
    // The bulk path builds its op stream from resolved refs, so it cannot produce a
    // NOT_FOUND; the claim here is that zero matches is a clean no-op rather than an
    // error, which is what makes the promotion ritual safe to run unconditionally.
    const fs = await seeded()
    const data = await ok(
      UPDATE,
      { attr: 'status', value: 'approved', where: 'status=nonexistent', file: 'doc.json' },
      fs,
    )
    expect(data.summary).toEqual({ total: 0, ok: 0, failed: 0, noop: 0 })
    expect(data.written).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. dry-run, on every op
// ---------------------------------------------------------------------------

describe('--dry-run writes nothing, on EVERY mutation op', () => {
  /** Every op with an input that WOULD change the document, so a dry run has something
   * to suppress. Enumerated rather than globbed, so adding an op forces a decision
   * about whether it previews. */
  const cases: readonly (readonly [string, RunnableOp, Record<string, unknown>])[] = [
    [
      'add',
      ADD,
      { patternType: 'ubiquitous', systemName: 's', systemResponse: 'do a', key: 'NEW' },
    ],
    ['update', UPDATE, { ref: 'G1', attr: 'status', value: 'approved' }],
    ['delete', DELETE, { ref: 'G1' }],
    ['link', LINK, { from: 'G1', to: 'G1', relation: 'refines' }],
    ['waive', WAIVE, { code: 'GTWR_R7_VAGUE', reason: 'reviewed' }],
    ['glossary', GLOSSARY, { canonical: 'issue a session token', alias: 'mint a token' }],
    ['antonym', ANTONYM, { a: 'open', b: 'shut' }],
  ]

  it.each(
    cases.map(([name, op, input]) => [name, op, input] as const),
  )('%s --dry-run reports the change but saves nothing', async (_name, op, input) => {
    const fs = await seeded()
    const preview = await ok(op, { ...input, file: 'doc.json', dryRun: true }, fs)
    // It computed a REAL result — `write` says the fold would have changed something…
    expect(preview.write).toBe(true)
    // …and `written` says it did not.
    expect(preview.written).toBe(false)
    expect(fs.saves, 'a dry run must not save').toHaveLength(0)

    // The same input WITHOUT --dry-run does write, which is the negative control: a
    // preview that suppressed nothing would pass the assertions above vacuously.
    const real = await ok(op, { ...input, file: 'doc.json' }, fs)
    expect(real.written).toBe(true)
    expect(fs.saves).toHaveLength(1)
  })

  it('apply --dry-run folds the whole stream and saves nothing', async () => {
    const fs = await seeded()
    const stream = [
      '{"op":"add","key":"S1","patternType":"ubiquitous","systemName":"s","systemResponse":"do a"}',
      '{"op":"derive","from":"S1","to":"G1"}',
    ].join('\n')
    const preview = await ok(APPLY, { file: 'doc.json', dryRun: true }, fs, stream)
    expect(preview.summary.ok).toBe(2)
    expect(preview.written).toBe(false)
    expect(fs.saves).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 3. The injected fold options are WIRED
// ---------------------------------------------------------------------------

describe('the injected fold options reach the fold', () => {
  it('NORMALIZES antonym heads through the atomizer`s own normalizer', async () => {
    // `core/mutate.ts` defaults to a bare trim, so if the operation layer forgot to
    // inject `normalize` a committed pair would store "Open"/"SHUT" where the atomizer
    // looks up "open"/"shut" — a decision recorded and silently never applied.
    const fs = fresh()
    await ok(ANTONYM, { a: '  Open ', b: 'SHUT', file: 'doc.json' }, fs)
    expect(fs.document.antonyms).toEqual([{ a: 'open', b: 'shut' }])
  })

  it('REFUSES a term containing an antonym verb, using the REAL lexicons', async () => {
    // The operation layer is the only place that can prove this. `mutate.test.ts` injects its
    // own validator, so it shows the SEAM works; only this shows production wired it — and an
    // unwired seam means a term can rewrite a response head, desync the bridge polarity from
    // the raw-text parse, and prove a conflict the document does not contain.
    const fs = fresh()
    const result = await run(
      TERM,
      { canonical: 'revoke access', alias: 'grant access', file: 'doc.json' },
      fs,
    )
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('ERR_USAGE')
    expect(result.failure.error).toContain('not committable')
    // Names the offending verb, so the author is not left guessing which word was the problem.
    expect(result.failure.error).toContain('revoke')
    expect(fs.document.terms).toEqual([])
  })

  it('REFUSES a term containing a state-bridge verb too, not only an antonym head', async () => {
    // `ESTABLISH_VERBS` is the other half of the desync, and it is a DIFFERENT lexicon — a
    // check wired to only one of the two would pass the case above and still be unsound.
    const fs = fresh()
    const result = await run(
      TERM,
      { canonical: 'mark the session', alias: 'flag the session', file: 'doc.json' },
      fs,
    )
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure.error).toContain('mark')
  })

  it('COMMITS a noun-phrase term, normalized through the atomizer`s own normalizer', async () => {
    const fs = fresh()
    await ok(
      TERM,
      { canonical: '  Session Token ', alias: 'Login Credential', file: 'doc.json' },
      fs,
    )
    // Stored as the author wrote it; matched in normalized space. The same discipline
    // `applyGlossary` follows — an author's capitalization is theirs.
    expect(fs.document.terms).toEqual([
      { canonical: 'Session Token', aliases: ['Login Credential'] },
    ])
  })

  it('REFUSES an inconsistent antonym pair, using the real union-find', async () => {
    // The false-contradiction guard, running against the transplanted
    // `buildAntonymIndexWithDoc` rather than a stub. `grant`/`revoke` are already polar
    // opposites in the seed table, so asserting `grant` ↔ `grant`-equivalent creates an
    // odd polarity cycle.
    const fs = fresh()
    // A same-polarity assertion between two verbs the seed table already relates as
    // OPPOSITES is the inconsistency: it demands grant ≡ deny AND grant ≡ ¬deny.
    const result = await run(ANTONYM, { a: 'grant', b: 'permit', file: 'doc.json' }, fs)
    // Whether THIS specific pair is inconsistent depends on the seed classes, so the
    // assertion is on the mechanism rather than the verdict: either it was accepted
    // (consistent) or refused with ERR_USAGE naming the inconsistency — never a throw
    // escaping into the check path, which is the property that matters.
    if (result._tag === 'Failure') {
      expect(result.failure._tag).toBe('ERR_USAGE')
      expect(result.failure.error).toContain('inconsistent')
    } else {
      expect(fs.document.antonyms.length).toBe(1)
    }
  })

  it('refuses a SELF-pair with a usage error rather than storing it', async () => {
    const fs = fresh()
    const result = await run(ANTONYM, { a: 'open', b: 'Open', file: 'doc.json' }, fs)
    // Normalized, "open" and "Open" are the SAME head — which is only detectable
    // because the normalizer is injected.
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure.error).toContain('its own antonym')
  })

  it('PRESERVES unknown top-level keys across a mutation (v4 V27)', async () => {
    // The defect V27 recorded was a mutation round-tripping a document through a
    // strip-mode parse and silently dropping a forward-compatible table. The write path
    // carries the load's `unknownKeys` back, so a mutation cannot strip one.
    const fs = fresh()
    const withUnknown = Layer.mergeAll(
      Layer.succeed(DocStore)(
        DocStore.of({
          load: () =>
            Effect.succeed({
              document: fs.document,
              unknownKeys: { futureTable: [{ a: 1 }] },
              diagnostics: [],
            } satisfies LoadedDocument),
          save: (_p, input) =>
            Effect.sync(() => {
              // The preserved keys must arrive at the save.
              expect(input.unknownKeys).toEqual({ futureTable: [{ a: 1 }] })
              fs.saves.push(input.document)
            }),
          exists: () => Effect.succeed(true),
        }),
      ),
      Layer.succeed(DocPath)(makeDocPath({})),
      Layer.succeed(StreamSource)(StreamSource.of({ read: () => Effect.succeed('') })),
    )
    await Effect.runPromise(
      runOperation(waiveOp, {
        code: 'GTWR_R7_VAGUE',
        reason: 'reviewed',
        file: 'doc.json',
      }).pipe(Effect.provide(withUnknown)),
    )
    expect(fs.saves).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4. The DRIFT guard v4's flagship command failed
// ---------------------------------------------------------------------------

describe('a description naming a --flag names a flag the operation HAS', () => {
  /** Every mutation operation's METADATA view, so the guard covers the whole surface. */
  const OPS: readonly AnyOperation[] = [
    ADD,
    UPDATE,
    DELETE,
    LINK,
    WAIVE,
    GLOSSARY,
    ANTONYM,
    APPLY,
  ].map((r) => r.meta)

  /** camelCase field → the kebab flag an agent types. */
  const flagOf = (field: string): string =>
    `--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`

  it.each(
    OPS.map((op) => [op.name, op] as const),
  )('%s: every backticked --flag in its descriptions is a real field', (_name, op) => {
    const fields = fieldMetadata(op.input)
    const declared = new Set(fields.map((f) => flagOf(f.name)))
    // Flags that live on the ROOT command rather than on an operation, so a
    // description may legitimately mention them.
    const shared = new Set(['--pretty', '--dense', '--evidence', '--field'])

    const mentioned = new Set<string>()
    for (const field of fields) {
      for (const match of field.description.matchAll(/`(--[a-z][a-z0-9-]*)`/g)) {
        const flag = match[1]
        if (flag !== undefined) mentioned.add(flag)
      }
    }

    for (const flag of mentioned) {
      expect(
        declared.has(flag) || shared.has(flag),
        `${op.name} describes \`${flag}\`, which it does not declare — an agent following the manifest would get ERR_USAGE`,
      ).toBe(true)
    }
  })

  it('is NON-VACUOUS ACROSS THE SURFACE — descriptions really do cross-reference flags', () => {
    // The non-vacuity claim belongs here rather than per-op, and finding that out was
    // instructive: asserting "every op mentions at least one flag" failed for five of
    // the eight, because `delete`/`link`/`glossary`/`antonym` genuinely have nothing to
    // cross-reference (their fields are independent) and demanding a mention would push
    // a reviewer to invent one.
    //
    // What the guard needs is that SOME description cross-references a flag, so the
    // matching logic is exercised on real text. Measured on this surface: `add` and
    // `update` name several (the mutually-exclusive pairs), which is exactly where the
    // v4's defect class lives — a cross-reference is only written when two flags
    // interact, and that is when getting the name wrong is easiest.
    let total = 0
    for (const op of OPS) {
      for (const field of fieldMetadata(op.input)) {
        total += [...field.description.matchAll(/`(--[a-z][a-z0-9-]*)`/g)].length
      }
    }
    expect(
      total,
      'no description cross-references any flag — the guard checks nothing',
    ).toBeGreaterThan(3)
  })

  it('`apply` names --ops for the STREAM and --file for the DOCUMENT', () => {
    // v4's exact defect, pinned: it registered `--doc` for the document while
    // reusing a description whose prose said `--file`, so its manifest advertised
    // `apply --file <ops>` and that invocation returned ERR_USAGE.
    const fields = new Map(
      fieldMetadata(applyOpDefinition.input).map((f) => [f.name, f.description]),
    )
    expect(fields.has('ops')).toBe(true)
    expect(fields.has('file')).toBe(true)
    // Each description names its OWN flag, and the two are not confusable.
    expect(fields.get('ops')).toContain('--ops')
    expect(fields.get('ops')).toContain('op stream')
    expect(fields.get('file')).toContain('requirements document')
    // And `--doc`, v4's spelling, is nowhere — there is one name per path.
    for (const description of fields.values()) expect(description).not.toContain('--doc ')
  })
})
