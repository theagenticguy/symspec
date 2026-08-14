/**
 * The DOCUMENT STORE — load and save a v3 document, as an Effect service.
 *
 * ## What this owns, and what it deliberately does not
 *
 * Three concerns, kept separate because each has a different failure mode:
 *
 * 1. **PATH RESOLUTION** ({@link DocPath}) — where the document is. Positional
 *    argument → `SYMSPEC_DOC` → `./requirements.json`, the donor's convention,
 *    unchanged. Kept as its own service so the resolution rule lives in one
 *    place and every operation gets it by construction.
 * 2. **SERIALIZATION** — pure functions ({@link serializeDocument},
 *    {@link parseDocumentText}). No I/O, so a caller can round-trip a document
 *    through text without touching a filesystem.
 * 3. **I/O** ({@link DocStore}) — reading, and writing ATOMICALLY.
 *
 * What it does NOT own: mutation. The store loads and saves; changing a document
 * is the ops' business. That is why there is no `update` method here.
 *
 * ## The atomic-write pattern, ported from the donor's `storage.ts`
 *
 * A write lands on a SIBLING temp file first, then `rename()`s over the target.
 * `rename()` within one filesystem is atomic, so a crash mid-write — or a write
 * that fails outright on a full disk — never leaves a half-written requirements
 * document on disk. Because the target is not touched until the final rename
 * succeeds, ANY failure leaves the original file completely intact, which is what
 * `ERR_IO`'s catalog text already promises agents. The temp file is best-effort
 * cleaned up on failure so it does not linger next to the target.
 *
 * The temp name is derived from the CLOCK plus a counter rather than from
 * `crypto.randomBytes`: `Crypto`'s `randomBytes` returns an object shape that
 * differs from the Node one on beta.102 (probed — `Buffer.from` rejects it), and
 * a collision-resistant name does not need cryptographic randomness. The temp
 * file lives for microseconds inside a directory the caller already owns.
 *
 * ## Byte-stable serialization
 *
 * Pretty-printed, 2-space indent, RECURSIVELY SORTED KEYS, trailing newline. All
 * four are load-bearing rather than aesthetic:
 *
 * - Pretty + sorted means `git diff` on a requirements document is line-level and
 *   reviewable, which is most of why the format is JSON on disk at all.
 * - Sorted keys make the file BYTE-STABLE: the same document always serializes to
 *   the same bytes regardless of the order its keys were built in, so a no-op
 *   save produces no diff and `check`'s determinism claim extends to the file.
 * - The trailing newline makes it well-formed POSIX text under `cat`.
 *
 * ## Errors: the two disjoint load failures
 *
 * `ERR_DOC_PARSE` and `ERR_SCHEMA_VERSION` are kept DISJOINT, in the donor's
 * order and for the donor's reason. The version check runs FIRST, on the raw
 * parsed JSON, before schema decoding — so a document that declares a version
 * this build does not know gets `ERR_SCHEMA_VERSION` with the migration path,
 * rather than an `ERR_DOC_PARSE` complaining about a `docVersion` literal
 * mismatch. Getting that order wrong is the difference between an agent being
 * told "run this migration" and being told "your file is malformed".
 *
 * (Note this INVERTS the donor's ordering, which checked the version after a
 * successful `safeParse`. It has to: the donor's version field was an open
 * `z.number().int()`, so a wrong version still satisfied the schema, whereas v3's
 * `docVersion` is a `Schema.Literal(3)` that a wrong version fails. Same
 * disjointness, same agent-visible outcome, opposite mechanism.)
 */

import { Effect, FileSystem, Layer, Path, type Schema } from 'effect'
import {
  DOC_VERSION,
  decodeDocument,
  type LoadedDocument,
  type RequirementsDocument,
  withUnknownKeys,
} from '../../domain/requirements/document.ts'
import {
  DOC_PATH_CONVENTION,
  DOC_PATH_ENV_VAR,
  DocPath,
  DocStore,
  makeDocPath,
  type SaveInput,
} from '../../ports/doc-store.ts'
import { ErrDocNotFound, ErrDocParse, ErrIo, ErrSchemaVersion } from '../../ports/errors.ts'

// ---------------------------------------------------------------------------
// Serialization — pure, no I/O
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys so `JSON.stringify` emits a canonical ordering
 * regardless of insertion order. Arrays keep their element order — only
 * plain-object keys are sorted, because an array's order is DATA (an edge list's
 * sequence is preserved through a round trip) while an object's key order is not.
 */
const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const input = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(input).sort()) sorted[key] = sortKeysDeep(input[key])
    return sorted
  }
  return value
}

/**
 * Serialize a document to its on-disk text: pretty-printed, sorted keys,
 * trailing newline.
 *
 * Takes the preserved `unknownKeys` alongside the document so forward-compatible
 * top-level keys are written BACK (the write half of the V27 fix). A caller with
 * nothing to preserve passes `{}`; a caller that loaded a document passes the
 * `unknownKeys` it got, which is why {@link DocStore.save} takes a whole
 * {@link LoadedDocument}-shaped input rather than a bare document.
 */
export const serializeDocument = (
  document: RequirementsDocument,
  unknownKeys: Readonly<Record<string, unknown>> = {},
): string => `${JSON.stringify(sortKeysDeep(withUnknownKeys(document, unknownKeys)), null, 2)}\n`

/**
 * Parse and validate document TEXT, with no I/O — the whole load pipeline minus
 * the file read, so it is directly testable and reusable by `import`.
 *
 * The three stages, in the order that keeps the error codes disjoint:
 *
 * 1. JSON parse → `ERR_DOC_PARSE` on malformed bytes.
 * 2. VERSION check on the raw value → `ERR_SCHEMA_VERSION`, carrying the exact
 *    migration path, before any schema decoding can complain about the literal.
 * 3. Schema decode → `ERR_DOC_PARSE` with the offending JSON path, plus the V27
 *    diagnostics on success.
 *
 * `path` appears only in error messages; nothing is read from it.
 */
export const parseDocumentText = (
  text: string,
  path: string,
): Effect.Effect<LoadedDocument, ErrDocParse | ErrSchemaVersion> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) =>
        new ErrDocParse({
          error: `${path} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
          suggestions: [
            'Check the path points at a symspec requirements document (JSON).',
            `Run \`symspec init ${path}\` to create a fresh v${DOC_VERSION} document.`,
          ],
        }),
    })

    yield* checkDocVersion(raw, path)

    return yield* Effect.mapError(
      decodeDocument(raw),
      (cause) =>
        new ErrDocParse({
          error: `${path} does not satisfy the v${DOC_VERSION} document schema: ${formatSchemaError(cause)}`,
          suggestions: [
            'Fix the offending JSON path named in the message above.',
            'Run `symspec manifest` to see the exact field shapes, including which fields are optional.',
            `Or re-create the document from source: \`symspec init ${path}\` then \`symspec import\`.`,
          ],
        }),
    )
  })

/**
 * Render a `SchemaError` into one line for the envelope's `error` field.
 *
 * Its `toString` already carries the failing JSON path (`at
 * ["requirements"]["…"]["bogusField"]`), which is the actionable part, so this
 * only flattens the newlines an envelope should not contain.
 */
const formatSchemaError = (error: Schema.SchemaError): string =>
  String(error).replace(/\s*\n\s*/g, ' ')

/**
 * Check a raw parsed value's `docVersion` BEFORE schema decoding.
 *
 * Reads the field structurally on purpose: this runs on an undecoded value, and
 * its whole job is to produce a better error than the decoder would. Three cases,
 * each with a different remedy, so each gets its own message:
 *
 * - `docVersion` equals {@link DOC_VERSION} → proceed.
 * - a v2 `schemaVersion` is present instead → `ERR_SCHEMA_VERSION` naming the
 *   donor-CLI migration pipeline, which is the ONE command pair that fixes it.
 * - any other value → `ERR_SCHEMA_VERSION` stating both numbers.
 *
 * A value with NEITHER key falls through to the decoder, which reports the
 * missing `docVersion` — correct, because that is not a version mismatch, it is a
 * document missing a required field (or not a symspec document at all).
 */
const checkDocVersion = (raw: unknown, path: string): Effect.Effect<void, ErrSchemaVersion> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return Effect.void
  const record = raw as Record<string, unknown>
  const declared = record.docVersion
  if (declared === DOC_VERSION) return Effect.void

  const legacy = record.schemaVersion
  // NEITHER key present ⇒ not a version mismatch at all. Fall through to the
  // decoder, which reports the missing required `docVersion` field. Getting this
  // branch wrong (and it was wrong first, caught by `store.test.ts`) tells a user
  // whose file is not a symspec document at all to run a migration.
  if (declared === undefined && legacy === undefined) return Effect.void

  if (declared === undefined) {
    return Effect.fail(
      new ErrSchemaVersion({
        error: `${path} is a v${String(legacy)} document (it declares \`schemaVersion\`, not \`docVersion\`); symspec expects document format v${DOC_VERSION}.`,
        suggestions: [
          `v${DOC_VERSION} deliberately has no read-compatibility with v2. Migration is a one-shot import through the op stream the v4 CLI already emits.`,
          `Step 1 — get the op stream: run the v4 CLI against ${path} on a bumped schemaVersion; its ERR_SCHEMA_VERSION envelope carries one \`{"op":…}\` JSONL record per requirement and per edge in dependency order, plus \`symspec glossary\`/\`antonym\`/\`waive\` commands for the side tables.`,
          `Step 2 — consume it: \`symspec import --file <ops.jsonl> --doc <new.json>\`, or pipe the records to \`symspec import\` on stdin.`,
          'The import reports what it created and passes the donor`s gaps[] through unchanged, so nothing is claimed to reproduce that does not.',
        ],
      }),
    )
  }

  return Effect.fail(
    new ErrSchemaVersion({
      error: `${path} declares docVersion ${JSON.stringify(declared)}; symspec expects ${DOC_VERSION}.`,
      suggestions: [
        `Only document format v${DOC_VERSION} is readable by this build.`,
        `If this document is NEWER than v${DOC_VERSION}, upgrade symspec rather than editing the file — a downgrade would have to guess at fields it does not know.`,
        `If it is older, migrate it: \`symspec init <new.json>\` then \`symspec import\` the op stream that rebuilds it.`,
      ],
    }),
  )
}

/** The production {@link DocPath} layer, sampling `process.env` once at init. */
export const docPathLayer = Layer.sync(DocPath)(() => makeDocPath(process.env))

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** A monotonic counter for temp-file names, so two saves in the same millisecond
 * cannot collide. */
let tempCounter = 0

/**
 * The production {@link DocStore}, over the platform `FileSystem` and `Path`.
 *
 * `Layer.effect` (NOT `Layer.scoped`, which does not exist on beta.102) because
 * acquiring the two platform services is itself an Effect. The store holds no
 * resource of its own, so there is nothing to release.
 */
export const docStoreLayer = Layer.effect(DocStore)(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const exists = (target: string): Effect.Effect<boolean> =>
      fs.exists(target).pipe(Effect.orElseSucceed(() => false))

    const load = (
      target: string,
    ): Effect.Effect<LoadedDocument, ErrDocNotFound | ErrDocParse | ErrSchemaVersion> =>
      Effect.gen(function* () {
        const text = yield* Effect.mapError(
          fs.readFileString(target),
          () =>
            new ErrDocNotFound({
              error: `Could not read a requirements document at ${target}.`,
              suggestions: [
                `Run \`symspec init ${target}\` to create one.`,
                `Or point ${DOC_PATH_ENV_VAR} at an existing document.`,
                DOC_PATH_CONVENTION,
              ],
            }),
        )
        return yield* parseDocumentText(text, target)
      })

    /**
     * Atomic write: temp sibling, then rename.
     *
     * The temp file is a SIBLING (same directory), not in `/tmp`, because
     * `rename()` is only atomic within one filesystem — a cross-device rename
     * fails outright, and on some platforms silently degrades to copy+unlink,
     * which is exactly the non-atomic behavior this exists to avoid.
     */
    const save = (target: string, input: SaveInput): Effect.Effect<void, ErrIo> =>
      Effect.gen(function* () {
        const contents = serializeDocument(input.document, input.unknownKeys ?? {})
        tempCounter += 1
        const temp = path.join(
          path.dirname(target),
          `.${Date.now().toString(36)}${tempCounter.toString(36)}.symspec.tmp`,
        )

        const cleanup = fs.remove(temp).pipe(Effect.catchCause(() => Effect.void))

        yield* Effect.mapError(fs.writeFileString(temp, contents), (cause) => {
          return new ErrIo({
            error: `Failed to write the temp file ${temp}: ${describePlatformError(cause)}`,
            suggestions: [
              'Check filesystem permissions and available disk space.',
              `The original document at ${target} was NOT modified.`,
            ],
          })
        }).pipe(Effect.tapError(() => cleanup))

        yield* Effect.mapError(fs.rename(temp, target), (cause) => {
          return new ErrIo({
            error: `Failed to rename ${temp} to ${target}: ${describePlatformError(cause)}`,
            suggestions: [
              'Check filesystem permissions and that the target directory exists.',
              `The original document at ${target} was NOT modified.`,
            ],
          })
        }).pipe(Effect.tapError(() => cleanup))
      })

    return DocStore.of({ load, save, exists })
  }),
)

/** One line describing a platform failure, for an `ERR_IO` message. */
const describePlatformError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** Both store layers, for an entry point that wants the whole document surface. */
export const storeLayer = Layer.mergeAll(docStoreLayer, docPathLayer)
