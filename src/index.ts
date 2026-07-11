/**
 * symspec's public library entry point (AC-6-5).
 *
 * symspec ships as an importable library first, CLI second: every command in
 * `src/cli/index.ts` is a thin formatter over the exact functions re-exported
 * here — `symspec add` calls `applyChange` + `saveDoc`, `symspec check` calls
 * `analyze`/lint/formal-tier functions, and so on. Nothing the CLI does is
 * reachable only through a shelled-out subprocess; an agent (or any Node
 * program) that wants the EARS validation engine without a CLI round-trip can
 * `import { applyChange, analyze, checkGtWRules } from 'symspec'` and get the
 * same behavior the CLI's `dist/cli.mjs` binary invokes.
 *
 * `package.json`'s `exports` map points `.` at this module's build output
 * (`dist/index.mjs` + `dist/index.d.ts`, emitted by `tsdown` with `dts: true`
 * — `tsdown.config.ts`), so `"private": true` no longer blocks a workspace
 * consumer or a published-package consumer from resolving `symspec` as a
 * library. `bin/symspec.mjs` remains the CLI entry (`dist/cli.mjs`) — the two
 * build outputs are independent tsdown entries sharing one source tree.
 *
 * ## Organization
 *
 * Re-exports are grouped by subsystem, mirroring `src/`'s directory layout:
 *   - `core/*`   — document schema, storage, load-time validation, the
 *                  Change-record mutation API, structural analysis, SysML export.
 *   - `parse/*`  — the NL parse ladder (Tier 1 regex cascade, Tier 2 wink-nlp
 *                  escalation, preprocessing).
 *   - `lint/*`   — INCOSE GtWR rule codes + the free-tier lint checker.
 *   - `pipeline/*` — the Tier-0/lint/formal pipeline guard and the AC-3-7
 *                    exclusion gate.
 *   - `certify/*`  — the Lean 4 toolchain discovery, emitter, and runner.
 *   - `formal/*` and `solvers/*` — the SMT-backed formal tier (encoder,
 *                    atomizer, contradiction/subsumption/vacuity/similarity
 *                    checks, evidence enrichment) plus the free-tier solver
 *                    orchestrator.
 *
 * Two module pairs export a same-named type for genuinely distinct concepts
 * (`formal/atomize.ts` vs `formal/encode.ts` both define a slot-kind
 * `AtomKind`; `parse/tier1.ts` vs `solvers/types.ts` both define a
 * `Confidence` union with different members) — `export *` would make both
 * ambiguous under TypeScript's re-export rules, so those two subsystems
 * (`formal/atomize.js` + `formal/encode.js`, and `solvers/types.js`) are
 * re-exported explicitly below rather than via a blanket `export *`, with
 * `solvers/types.ts`'s `Confidence` renamed to `SolverConfidence` at this
 * barrel to disambiguate it from the parse ladder's `Confidence` (re-exported
 * via `parse/index.js`, which already carries that name for Tier 1/2 results).
 */

// ---------------------------------------------------------------------------
// certify — Lean 4 toolchain discovery, emitter, and NDJSON-parsing runner
// ---------------------------------------------------------------------------
export * from './certify/discover.js'
export * from './certify/emit.js'
export * from './certify/run.js'
// ---------------------------------------------------------------------------
// cli contract — the envelope/manifest shapes an agent validates output
// against (library parity for the CLI's --json surface; validate-agent-ux F2)
// ---------------------------------------------------------------------------
export {
  API_VERSION,
  type Envelope,
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  type FailureOptions,
  failure,
  PartialSlotsSchema,
  type SuccessEnvelope,
  SuccessEnvelopeSchema,
  success,
} from './cli/envelope.js'
export { buildManifest, type Manifest, ManifestSchema } from './cli/manifest.js'
export { EnvelopeTypeSchema, EnvelopeTypes } from './cli/types-enum.js'
// ---------------------------------------------------------------------------
// core — document schema, storage, mutation, load-time validation, analysis
// ---------------------------------------------------------------------------
export * from './core/analyze.js'
export * from './core/changes.js'
export * from './core/codes.js'
export * from './core/doc.js'
export * from './core/load.js'
export * from './core/render.js'
export * from './core/schema.js'
export * from './core/storage.js'
export * from './core/sysml-export.js'
// ---------------------------------------------------------------------------
// formal — the SMT-backed formal tier (all members except the two
// `AtomKind`-colliding modules, re-exported explicitly below)
// ---------------------------------------------------------------------------
export * from './formal/antonyms.js'
export type { Atom, AtomizeArgs, AtomKind } from './formal/atomize.js'
// `atomize.ts` (AC-4-2a) and `encode.ts` (AC-4-2) both declare a slot-kind
// `AtomKind` type — the same three-member union by coincidence, but two
// independent declarations, so `export *` from both is a genuine TS2308
// ambiguity. Re-export each module's full named surface explicitly instead.
export { atomize, glossaryIndex, normalize } from './formal/atomize.js'
export * from './formal/backend.js'
export * from './formal/binary-backend.js'
export * from './formal/codes.js'
export * from './formal/contradiction.js'
export * from './formal/embed.js'
export * from './formal/emit-smt2.js'
export type {
  Atomize,
  AtomLit,
  AtomTableEntry,
  EncodableRequirement,
  EncodedRequirement,
  Formula,
  Z3Bool,
} from './formal/encode.js'
export { and, atom, encode, implies, materialize, not, or } from './formal/encode.js'
export * from './formal/finding.js'
export {
  type AssetReport,
  type DownloadReport,
  downloadModelAssets,
  modelCacheDir,
} from './formal/model-cache.js'
export * from './formal/needs-review.js'
export { extractNumericPredicates, type NumericPredicate } from './formal/numeric.js'
export {
  findNumericContradictions,
  type NumericContradictionFinding,
  type RequirementPredicates,
} from './formal/numeric-contradiction.js'
export * from './formal/semantic.js'
export * from './formal/similar.js'
export * from './formal/subsumption.js'
export * from './formal/vacuity.js'
// ---------------------------------------------------------------------------
// lint — INCOSE Guide to Writing Requirements (GtWR) rule engine
// ---------------------------------------------------------------------------
export * from './lint/codes.js'
export * from './lint/gtwr.js'
// ---------------------------------------------------------------------------
// parse — NL requirement-prose parse ladder (Tier 1 regex, Tier 2 wink-nlp)
// ---------------------------------------------------------------------------
export * from './parse/index.js'
export * from './parse/negation.js'
export * from './parse/normalize.js'
export * from './parse/preprocess.js'
// ---------------------------------------------------------------------------
// pipeline — the check-command guard and the AC-3-7 exclusion gate
// ---------------------------------------------------------------------------
export * from './pipeline/check.js'
export * from './pipeline/gate.js'

// ---------------------------------------------------------------------------
// solvers — free-tier orchestrator + shared solver types
// ---------------------------------------------------------------------------
export * from './solvers/index.js'
export type {
  CandidatePair,
  Confidence as SolverConfidence,
  ReqView,
  SolverFinding,
  SolverSource,
} from './solvers/types.js'
// `solvers/types.ts`'s `Confidence` ('high' | 'low') is a distinct type from
// the parse ladder's `Confidence` ('high' | 'medium' | 'low', re-exported via
// `parse/index.js` above) — renamed here to `SolverConfidence` to disambiguate
// at this barrel without touching either owning module.
export { asView } from './solvers/types.js'
