/**
 * `DocPath` and `DocStore` — where the document lives and how it is read, as a
 * contract.
 *
 * The path-resolution rule (one prose string, one pure `makeDocPath`) and the
 * two service SHAPES live here; the layers that sample `process.env` and touch
 * the real filesystem live in `adapters/fs/store.ts`.
 */

import { Context, type Effect } from 'effect'
import type { LoadedDocument, RequirementsDocument } from '../domain/requirements/document.ts'
import type { ErrDocNotFound, ErrDocParse, ErrIo, ErrSchemaVersion } from './errors.ts'

/** The default document path when nothing else resolves. Donor convention. */
export const DEFAULT_DOC_PATH = './requirements.json'

/** The environment variable that overrides the default. Donor convention. */
export const DOC_PATH_ENV_VAR = 'SYMSPEC_DOC'

/**
 * The document-path resolution rule, as prose — single-sourced here so the
 * manifest, every flag description, and every error message quote ONE string
 * rather than four paraphrases that drift.
 */
export const DOC_PATH_CONVENTION = `Resolution precedence, in order: the supplied path, then the ${DOC_PATH_ENV_VAR} environment variable, then the ${DEFAULT_DOC_PATH} default.`

/**
 * The path-resolution service.
 *
 * A SERVICE rather than a bare function because the environment is a dependency:
 * reading `process.env` at each call site would make the rule untestable without
 * mutating global state, and would re-read a variable that should be sampled once
 * per process. {@link docPathLayer} samples `SYMSPEC_DOC` at layer construction —
 * the "Config snapshots env at init" discipline — so every operation in one
 * invocation resolves against the same environment.
 */
export class DocPath extends Context.Service<
  DocPath,
  {
    /**
     * Resolve the document path from an explicit value (a positional argument or
     * `--file`), falling back through the env var to the default. `null` and
     * `undefined` both mean "not supplied", so a CLI flag whose absent value
     * decodes to `null` needs no special-casing at the call site.
     */
    readonly resolve: (explicit: string | null | undefined) => string
    /** The sampled `SYMSPEC_DOC` value, or `undefined` when unset. Exposed for
     * diagnostics and for tests that assert the precedence. */
    readonly envPath: string | undefined
  }
>()('symspec/DocPath') {}

/**
 * Build a {@link DocPath} from an explicit environment map.
 *
 * Takes the environment as an ARGUMENT so the resolution rule is testable
 * without touching `process.env`. {@link docPathLayer} is the production wiring
 * that passes the real one.
 */
export const makeDocPath = (env: Readonly<Record<string, string | undefined>>) => {
  const raw = env[DOC_PATH_ENV_VAR]
  // An empty-string env var means "unset", not "the empty path". A shell that
  // exports SYMSPEC_DOC= would otherwise resolve every command to '' and fail
  // with a confusing ENOENT on a path that is not a path.
  const envPath = raw !== undefined && raw.length > 0 ? raw : undefined
  return DocPath.of({
    envPath,
    resolve: (explicit) => {
      if (explicit !== null && explicit !== undefined && explicit.length > 0) return explicit
      return envPath ?? DEFAULT_DOC_PATH
    },
  })
}

/** What {@link DocStore.save} persists: a document plus the unknown top-level
 * keys to write back alongside it. */
export interface SaveInput {
  readonly document: RequirementsDocument
  readonly unknownKeys?: Readonly<Record<string, unknown>>
}

/**
 * The document store service: read a v3 document, write one atomically, and
 * answer whether one exists.
 *
 * Every method's error channel is the catalog's `ERR_*` classes, never a raw
 * `PlatformError` — mapping happens at this boundary so no operation above it has
 * to know what a `PlatformError` is, and so every failure an agent sees carries a
 * stable code with actionable suggestions.
 */
export class DocStore extends Context.Service<
  DocStore,
  {
    /**
     * Load and validate the document at `path`.
     *
     * `ERR_DOC_NOT_FOUND` when the path does not resolve (distinct from a parse
     * failure: the remedy is `init`, not an edit), `ERR_SCHEMA_VERSION` on a
     * version mismatch, `ERR_DOC_PARSE` on malformed or invalid content.
     */
    readonly load: (
      path: string,
    ) => Effect.Effect<LoadedDocument, ErrDocNotFound | ErrDocParse | ErrSchemaVersion>
    /**
     * Serialize and write `input` to `path` ATOMICALLY (temp file + rename).
     * Fails with `ERR_IO`, leaving any existing file at `path` intact.
     */
    readonly save: (path: string, input: SaveInput) => Effect.Effect<void, ErrIo>
    /** Whether a file exists at `path`. Never fails: an unreadable path is
     * reported as "does not exist", because that is what the caller — `init`
     * deciding whether to refuse — actually needs to know. */
    readonly exists: (path: string) => Effect.Effect<boolean>
  }
>()('symspec/DocStore') {}
