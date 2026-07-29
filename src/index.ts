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
 * `parse/tier1.ts` and `solvers/types.ts` both define a `Confidence` union with
 * different members, so `export *` from both would be ambiguous under
 * TypeScript's re-export rules; `solvers/types.js` is re-exported explicitly
 * below with its `Confidence` renamed to `SolverConfidence`, disambiguating it
 * from the parse ladder's `Confidence` (re-exported via `parse/index.js`, which
 * already carries that name for Tier 1/2 results).
 *
 * `formal/atomize.js` and `formal/encode.js` used to need the same treatment for
 * a duplicated slot-kind `AtomKind`. AC-2-7 removed the duplicate declaration —
 * `atomize.ts` owns the atom vocabulary and `encode.ts` re-exports it — so the
 * ambiguity is gone at the source rather than papered over at the barrel. Their
 * explicit re-export lists are kept anyway, because `encode.ts` re-exporting
 * `atomize.ts`'s types means a blanket `export *` from both would still route two
 * names to one declaration, and an explicit list documents each module's public
 * surface at the one place a library consumer reads.
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
export * from './core/reproduce.js'
export * from './core/schema.js'
export * from './core/storage.js'
export * from './core/sysml-export.js'
export {
  type AmbiguityCode,
  type AmbiguityFinding,
  detectAmbiguity,
} from './formal/ambiguity.js'
// ---------------------------------------------------------------------------
// formal — the SMT-backed formal tier. Most modules ride `export *`; the
// atomizer/encoder/temporal trio is listed explicitly (see the header note).
// ---------------------------------------------------------------------------
export * from './formal/antonyms.js'
// The atom vocabulary (AC-4-2a, deduplicated by AC-2-7): `atomize.ts` is the ONE
// declaration site for `AtomKind` / `AtomLit` / `Atomize` / `AtomRef`, which
// `encode.ts` re-exports for its existing import sites. Exported from here so a
// library consumer building its own atomizer (or reading an atom's structured
// kind instead of substring-matching its name) has the types.
export type {
  Atom,
  Atomize,
  AtomizeArgs,
  AtomKind,
  AtomLit,
  AtomRef,
} from './formal/atomize.js'
export {
  atomize,
  GUARD_KINDS,
  glossaryIndex,
  makeAtomize,
  normalize,
  renderAtom,
} from './formal/atomize.js'
export * from './formal/backend.js'
export * from './formal/binary-backend.js'
export * from './formal/codes.js'
export * from './formal/contradiction.js'
export * from './formal/embed.js'
export * from './formal/emit-smt2.js'
export type {
  AndNode,
  AtomNode,
  AtomTableEntry,
  CmpNode,
  EncodableRequirement,
  EncodedRequirement,
  Formula,
  ImpliesNode,
  NotNode,
  NumericComparator,
  OrNode,
  Z3Bool,
} from './formal/encode.js'
export {
  and,
  atom,
  cmp,
  encode,
  implies,
  materialize,
  not,
  or,
  slotIsEmpty,
} from './formal/encode.js'
export * from './formal/finding.js'
export {
  buildSimilarityGraph,
  type DuplicateClusterFinding,
  type GraphFinding,
  type GraphOptions,
  type GraphRequirement,
  type MissingTraceLinkFinding,
} from './formal/graph.js'
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
export {
  findTemporalContradictions,
  lowerAt,
  type RequirementTemporal,
  type TemporalContradictionFinding,
} from './formal/temporal.js'
export {
  earsToTemporal,
  F,
  type FNode,
  G,
  type GNode,
  type TemporalFormula,
  tAnd,
  tAtom,
  tImplies,
  tNot,
  tOr,
  U,
  type UNode,
  X,
  type XNode,
} from './formal/temporal-patterns.js'
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
