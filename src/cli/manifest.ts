/**
 * The `manifest` command (AC-6-1): a single self-describing JSON blob an agent
 * fetches once to learn symspec's entire surface — the command inventory, each
 * command's argument schema, and the stable error/finding code catalogs —
 * WITHOUT reading hand-written prose that can drift from the code.
 *
 * ## Single-source derivation (the load-bearing property of this task)
 *
 * Every argument schema in the manifest is produced by running Zod's own
 * `z.toJSONSchema` over the SAME atomic-field schemas the runtime validates
 * with (`src/core/schema.ts`). Because those fields carry a rich `.describe()`
 * corpus, the description text an agent reads in the manifest is byte-for-byte
 * the description the validator enforces against — edit a field's `.describe()`
 * once and the manifest entry changes with it (AC-7-5 later asserts this
 * propagation across manifest + AGENTS.md + `--json`). Nothing here is
 * hand-transcribed from the schema; the transcription IS the schema.
 *
 * Likewise the three code tables (`error`/`gtwr`/`fnd`) are derived from the
 * exported Zod enums (`ErrCodeSchema`, `GtwrCodeSchema`, `FndCodeSchema`) plus
 * their per-code `.describe()` corpus (`ErrCodeMeta`/`GtwrCodeMeta`/
 * `FndCodeMeta`) rather than a parallel hand-maintained list — so a code added
 * to an enum appears in the manifest automatically, a code's description is
 * byte-for-byte its `.describe()` metadata, and the two can never disagree
 * (AC-6-3). Editing a code's `.describe()` is the single edit that moves the
 * manifest table; an append-only snapshot test in each enum's `codes.test.ts`
 * guards all three catalogs against removal/renaming.
 *
 * ## Single-sourcing
 *
 *   - Command *summaries* (the one-line "what/when" prose) come from
 *     `src/cli/descriptions.ts` (AC-6-9); the *argument schemas* derive from
 *     the Zod field corpus (AC-6-1); the honest-scope text from
 *     `src/cli/scope-text.ts` (AC-4-11). Every agent-facing string has exactly
 *     one origin.
 *   - `apiVersion` (AC-6-12) is the envelope-contract integer, imported from
 *     the ONE constant in `cli/envelope.ts` so the manifest and the envelopes
 *     can never disagree; it is distinct from the package `version` field
 *     beside it and from the document `schemaVersion`. The envelope `type` enum
 *     table (AC-6-13) and the `backends` availability report (AC-6-14) are
 *     derived likewise. Code entries are objects with an optional `description`
 *     so appended codes validate without reshaping the manifest.
 *
 * Cite: AC-6-1 (self-describing manifest from Zod + `.describe()`); pattern 1
 * (explore-surface.md §1; explore-core.md §3; orchestrator decision 7).
 */

import { z } from 'zod'
import pkg from '../../package.json' with { type: 'json' }
import { buildCodeCatalog, type CodeCatalogEntry, errCodeCatalog } from '../core/codes.js'
import {
  f,
  RelationshipAddInputShape,
  RelationshipRemoveInputShape,
  RequirementCreateInputShape,
  RequirementDeleteInputShape,
  RequirementUpdateInputShape,
} from '../core/schema.js'
import { FndCodeMeta, FndCodes } from '../formal/codes.js'
import { GtwrCodeMeta, GtwrCodes } from '../lint/codes.js'
import { type BackendsReport, BackendsReportSchema, collectBackends } from './backends.js'
import { COMMAND_SUMMARIES, type CommandName } from './descriptions.js'
import { API_VERSION } from './envelope.js'
import { SCOPE, ScopeSchema } from './scope-text.js'
import { EnvelopeTypes } from './types-enum.js'

const lines = (...xs: string[]) => xs.join('\n')

// ---------------------------------------------------------------------------
// CLI-level argument fields not part of the requirement domain model.
// The document path is a CLI concern (resolution precedence is owned by
// AC-6-6's `resolve-doc.ts`), so its describe lives here, not in schema.ts.
// ---------------------------------------------------------------------------

const docPathArg = z
  .string()
  .min(1)
  .describe(
    lines(
      'Path to the requirements document (JSON).',
      'Resolution precedence: this positional argument, then the SYMSPEC_DOC',
      'environment variable, then the ./requirements.json default.',
      "Example: './requirements.json'",
    ),
  )

/**
 * The `--file <path>` OPTION form of {@link docPathArg} (M2): commands that
 * carry a required positional (id/fromId/relation/…) take the doc path as an
 * option so commander never mistakes a required UUID for the file. Same
 * resolution precedence and description; optional because SYMSPEC_DOC / the
 * default path can supply it.
 */
const docFileOpt = z
  .string()
  .min(1)
  .describe(
    lines(
      'Path to the requirements document (JSON), supplied as the `--file <path>` option.',
      'Resolution precedence: this option, then the SYMSPEC_DOC environment',
      'variable, then the ./requirements.json default.',
      'Example: --file ./requirements.json',
    ),
  )
  .optional()

const idArg = f.id

const sentenceArg = z
  .string()
  .min(1)
  .describe(
    lines(
      'A single natural-language requirement sentence to parse into EARS slots.',
      "Example: 'When the user submits valid credentials, the auth service shall issue a session token.'",
    ),
  )
  .optional()

// ---------------------------------------------------------------------------
// CLI option fields absent from the requirement domain model but part of the
// real command surface (MD2): parse's batch inputs, check's solver knobs, and
// the global output flags. Each carries a `.describe()` so an agent reading the
// manifest sees the whole surface, not just the domain arguments.
// ---------------------------------------------------------------------------

const parseFileOpt = z
  .string()
  .min(1)
  .describe('`--file <path>`: read requirement lines (one per line) from a file (AC-2-9 batch).')
  .optional()

const parseStdinOpt = z
  .boolean()
  .describe('`--stdin`: read requirement lines (one per line) from stdin (AC-2-9 batch).')
  .optional()

const CheckOptionShape = {
  'similarity-threshold': z
    .string()
    .describe('`--similarity-threshold <n>`: pairwise lexical-similarity threshold (0..1).')
    .optional(),
  'timeout-ms': z
    .string()
    .describe('`--timeout-ms <n>`: per-group solver timeout in ms (default 2000).')
    .optional(),
  'solver-budget-ms': z
    .string()
    .describe(
      '`--solver-budget-ms <n>`: whole-run solver budget in ms (ERR_SOLVER_TIMEOUT boundary).',
    )
    .optional(),
  'emit-smt2': z
    .string()
    .describe(
      '`--emit-smt2 <path>`: also write the portable SMT-LIB2 artifact for the included requirements (AC-4-8).',
    )
    .optional(),
  solver: z
    .enum(['z3-wasm', 'z3-bin', 'cvc5'])
    .describe(
      '`--solver <backend>`: formal backend — z3-wasm (default, in-process WASM) | z3-bin | cvc5 (external binary cross-check, AC-4-9). A missing binary yields ERR_SOLVER_MISSING.',
    )
    .optional(),
  'solver-path': z
    .string()
    .describe('`--solver-path <path>`: explicit path to an external z3/cvc5 binary (AC-4-9).')
    .optional(),
  temporal: z
    .boolean()
    .describe(
      '`--temporal`: opt-in bounded LTL→SMT temporal-ordering conflict detection (FND_TEMPORAL_CONTRADICTION, AC-33-2). Sound-for-UNSAT over a finite trace bound.',
    )
    .optional(),
  'temporal-bound': z
    .string()
    .describe('`--temporal-bound <k>`: trace bound k for --temporal (default 10).')
    .optional(),
}

/**
 * The global output flags every command inherits (AC-6-2a / AC-6-4). Projected
 * into the manifest's top-level `globalOptions` so an agent discovers them once
 * rather than fail-then-learn. These shape OUTPUT only; they never change a
 * command's data or exit code.
 */
const GlobalOptionsSchema = z
  .object({
    json: z
      .boolean()
      .describe('`--json`: no-op alias for the default JSON envelope output (AC-6-2a).')
      .optional(),
    pretty: z
      .boolean()
      .describe('`--pretty`: render human-readable prose instead of the default JSON envelope.')
      .optional(),
    human: z.boolean().describe('`--human`: alias of --pretty.').optional(),
    dense: z
      .boolean()
      .describe('`--dense`: minified, default/null-omitting, evidence-elided JSON (AC-6-4).')
      .optional(),
    evidence: z
      .boolean()
      .describe('`--evidence`: keep the heavy evidence/atom-table fields under --dense.')
      .optional(),
  })
  .describe('Global output-shaping flags inherited by every command (AC-6-2a / AC-6-4).')

// ---------------------------------------------------------------------------
// Command inventory. Each entry's `args` is a Zod object composed from the
// shared atomic-field schemas so its JSON-schema projection carries the
// single-source `.describe()` corpus (AC-6-1). The one-line `summary` is
// single-sourced from the description corpus (`descriptions.ts`, AC-6-9) via
// {@link COMMAND_SUMMARIES}, so the manifest summary and the CLI
// `.description()` for a command read from the ONE map and cannot drift.
// ---------------------------------------------------------------------------

interface CommandSpec {
  readonly name: CommandName
  readonly args: z.ZodObject
}

// Commands split into two doc-path conventions (M2):
//   - single-positional `[file]` commands (init/add/check/certify/list/export)
//     keep the doc path as the leading positional — unambiguous, no required
//     args follow it.
//   - commands with a required positional (update/show/derive/satisfy/
//     remove-edge/delete) take the doc path as the `--file <path>` OPTION so
//     commander never eats a required UUID as the file path.
const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: 'manifest', args: z.object({}) },
  { name: 'init', args: z.object({ file: docPathArg }) },
  { name: 'add', args: z.object({ file: docPathArg, ...RequirementCreateInputShape }) },
  {
    name: 'update',
    args: z.object({ ...RequirementUpdateInputShape, file: docFileOpt }),
  },
  {
    name: 'parse',
    args: z.object({ text: sentenceArg, file: parseFileOpt, stdin: parseStdinOpt }),
  },
  { name: 'check', args: z.object({ file: docPathArg, ...CheckOptionShape }) },
  { name: 'certify', args: z.object({ file: docPathArg }) },
  { name: 'list', args: z.object({ file: docPathArg }) },
  { name: 'show', args: z.object({ id: idArg, file: docFileOpt }) },
  {
    name: 'derive',
    args: z.object({
      from: RelationshipAddInputShape.from,
      to: RelationshipAddInputShape.to,
      file: docFileOpt,
    }),
  },
  {
    name: 'satisfy',
    args: z.object({
      from: RelationshipAddInputShape.from,
      to: RelationshipAddInputShape.to,
      file: docFileOpt,
    }),
  },
  { name: 'remove-edge', args: z.object({ ...RelationshipRemoveInputShape, file: docFileOpt }) },
  { name: 'delete', args: z.object({ ...RequirementDeleteInputShape, file: docFileOpt }) },
  { name: 'export', args: z.object({ file: docPathArg }) },
  {
    name: 'glossary',
    args: z.object({
      op: z
        .enum(['add', 'remove', 'list'])
        .describe('The glossary operation: add | remove | list (AC-9-6).'),
      canonical: z.string().describe('The canonical response phrasing (add/remove).').optional(),
      alias: z.string().describe('A synonymous phrasing to merge (add/remove).').optional(),
      file: docFileOpt,
    }),
  },
  { name: 'download-model', args: z.object({}) },
  {
    name: 'apply',
    args: z.object({
      file: z
        .string()
        .min(1)
        .describe(
          lines(
            'Path to a JSONL op file — one {"op":"add|update|derive|satisfy|remove-edge|delete", ...} record',
            'per line. Blank lines and #-comment lines are skipped. Requirement refs (ref/from/to) accept a',
            'stable key or a UUID; an `add` op may carry "key" so later ops in the SAME batch reference it.',
            'Omit and pass --stdin to read the op stream from standard input instead.',
          ),
        )
        .optional(),
      stdin: z
        .boolean()
        .describe('Read the JSONL op stream from stdin instead of a file.')
        .optional(),
      doc: docFileOpt,
      'continue-on-error': z
        .boolean()
        .describe(
          'Best-effort mode: apply the ops that succeed and save once, instead of the atomic default (abort on first error, write nothing).',
        )
        .optional(),
    }),
  },
  {
    name: 'waive',
    args: z.object({
      op: z
        .enum(['add', 'remove', 'list'])
        .describe('The waiver operation: add | remove | list (wishlist #3).'),
      code: z
        .string()
        .describe('The finding code to waive/unwaive (e.g. GTWR_R6_MISSING_UNITS) (add/remove).')
        .optional(),
      ref: f.id
        .describe(
          'Optional requirement scope (stable key or UUID). When set, only findings naming this requirement are waived.',
        )
        .optional(),
      reason: z.string().describe('Why the finding is waived — the audit trail (add).').optional(),
      file: docFileOpt,
    }),
  },
  {
    name: 'install',
    args: z.object({
      global: z
        .boolean()
        .describe(
          'Install into your home config (~/.agents/skills, ~/.kiro/steering, …) instead of the current project.',
        )
        .optional(),
      target: z
        .string()
        .describe(
          'Which hosts to install into: `auto` (default — detected hosts), `all`, or a CSV of ids (agents-standard, kiro, windsurf, copilot).',
        )
        .optional(),
      uninstall: z
        .boolean()
        .describe("Remove symspec's skill file from each target host.")
        .optional(),
      check: z
        .boolean()
        .describe('Report what would be written and whether it is already present; write nothing.')
        .optional(),
      print: z
        .string()
        .describe('Print one target host’s exact skill-file content and exit; write nothing.')
        .optional(),
    }),
  },
]

// ---------------------------------------------------------------------------
// Manifest schema — the manifest validates against this (AC-6-1 verification).
// ---------------------------------------------------------------------------

/** One JSON-Schema-projected argument schema for a command. */
const JsonSchemaValue: z.ZodType<unknown> = z.unknown()

/**
 * One command's manifest entry: its name, one-line summary, and the JSON-Schema
 * projection of its argument shape (derived from the Zod field corpus).
 */
export const ManifestCommandSchema = z.object({
  name: z.string(),
  summary: z.string(),
  arguments: JsonSchemaValue,
})
export type ManifestCommand = z.infer<typeof ManifestCommandSchema>

/**
 * One code-catalog entry: the stable code plus its single-sourced description.
 * The description is derived (AC-6-3) from the per-code `.describe()` corpus
 * next to each enum (`ErrCodeMeta`/`GtwrCodeMeta`/`FndCodeMeta`), so mutating a
 * code's `.describe()` changes this manifest entry. It stays `.optional()` so a
 * newly appended code that has not yet been described still validates rather
 * than crashing the manifest.
 */
export const ManifestCodeSchema = z.object({
  code: z.string(),
  description: z.string().optional(),
})
export type ManifestCode = z.infer<typeof ManifestCodeSchema>

/** The whole manifest blob. */
export const ManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  // The envelope-contract integer (AC-6-12). Pinned as a literal of the ONE
  // exported constant so a drifted manifest fails its own schema. Distinct
  // from `version` above (the package release) and from the document
  // `schemaVersion` (core/schema.ts SCHEMA_VERSION).
  apiVersion: z.literal(API_VERSION),
  /**
   * The global output-shaping flags every command inherits (AC-6-2a / AC-6-4),
   * as a JSON-Schema projection (MD2). Surfaced once at the top level so an
   * agent discovers `--json`/`--pretty`/`--dense`/`--evidence` without reading
   * each command entry.
   */
  globalOptions: JsonSchemaValue,
  commands: z.array(ManifestCommandSchema),
  /**
   * The closed, append-only set of envelope `type` discriminants (AC-6-13),
   * derived from the ONE exported `EnvelopeTypeSchema` enum (`cli/types-enum.ts`)
   * — never a parallel hand-list — so an agent reads the full discriminant set
   * it switches on from the same self-describing blob. Append-only and
   * snapshot-guarded alongside the code catalogs below.
   */
  types: z.array(z.string()),
  codes: z.object({
    error: z.array(ManifestCodeSchema),
    gtwr: z.array(ManifestCodeSchema),
    fnd: z.array(ManifestCodeSchema),
  }),
  /**
   * The formal tier's honest-scope disclosure (AC-4-11), single-sourced from
   * `cli/scope-text.ts`: the "sound modulo atomization" claim, the "silence is
   * not a consistency certificate" dual, the over-unification false-positive
   * risk and its mitigations, and the contextual-ambiguity not-checked
   * boundary. An agent reads these exact claims from the manifest before
   * trusting a `check` verdict.
   */
  scope: ScopeSchema,
  /**
   * Runtime backend availability report (AC-6-14). Optional and
   * forward-tolerant: `buildManifest()` (pure, byte-stable, environment-free)
   * omits it; `buildManifestWithBackends()` populates it from live probes so
   * an agent can query-then-decide before invoking `certify`/`--solver`.
   */
  backends: BackendsReportSchema.optional(),
})
export type Manifest = z.infer<typeof ManifestSchema>

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Project a command's Zod argument object into JSON Schema (input side), so the
 * emitted schema reflects what a caller supplies (optionals stay optional,
 * defaults are not pre-applied) and carries the single-source `.describe()`
 * text on every field.
 */
function argumentsSchemaOf(args: z.ZodObject): unknown {
  return z.toJSONSchema(args, { io: 'input' })
}

/**
 * Adapt a `{code, description}` catalog row (built from an enum + its
 * `.describe()` corpus) into a manifest code entry. Deriving from the enum's
 * options AND its per-code `.describe()` — never a parallel hand-list — is the
 * AC-6-1/AC-6-3 single-source guarantee: a code added to an enum appears here
 * automatically, and mutating a code's `.describe()` changes this table.
 */
function toManifestCodes(rows: readonly CodeCatalogEntry[]): ManifestCode[] {
  return rows.map(({ code, description }): ManifestCode => ({ code, description }))
}

/**
 * Build the manifest by deriving every argument schema from the Zod field
 * corpus and every code table from the exported Zod enums. Pure and
 * deterministic: same code + same schemas → byte-identical manifest.
 */
export function buildManifest(): Manifest {
  return {
    name: pkg.name,
    version: pkg.version,
    apiVersion: API_VERSION,
    globalOptions: argumentsSchemaOf(GlobalOptionsSchema),
    commands: COMMAND_SPECS.map((c) => ({
      name: c.name,
      summary: COMMAND_SUMMARIES[c.name],
      arguments: argumentsSchemaOf(c.args),
    })),
    // Derived from the ONE exported enum (AC-6-13), so the manifest `type`
    // table and the envelope discriminant can never drift.
    types: [...EnvelopeTypes],
    // The formal tier's honest-scope claims (AC-4-11), single-sourced from
    // `cli/scope-text.ts` so the manifest and finding output can never disagree.
    scope: SCOPE,
    codes: {
      error: toManifestCodes(errCodeCatalog()),
      gtwr: toManifestCodes(buildCodeCatalog(GtwrCodes, GtwrCodeMeta)),
      fnd: toManifestCodes(buildCodeCatalog(FndCodes, FndCodeMeta)),
    },
  }
}

/**
 * Build the manifest and attach the live `backends` availability report
 * (AC-6-14). Unlike {@link buildManifest} this is async and environment-
 * dependent: it awaits the WASM z3 probe and spawns the binary/Lean probes,
 * so its output reflects the host it runs on. The `manifest` command uses this
 * variant so an agent can read backend availability once and query-then-decide
 * before invoking `certify` or `--solver`, rather than fail-then-learn.
 */
export async function buildManifestWithBackends(): Promise<Manifest> {
  const backends: BackendsReport = await collectBackends()
  return { ...buildManifest(), backends }
}
