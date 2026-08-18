/**
 * `propose-glossary` — design the vocabulary across the whole document, in one pass.
 *
 * ## Why this exists as its own operation
 *
 * `check` already proposes vocabulary, and it proposes it PAIRWISE: one
 * `FND_SIMILAR_SEMANTIC` per requirement pair, each with one inline `glossary` command. An
 * agent following that discovers its vocabulary one pair at a time, commits N independent
 * decisions that may not cohere, and never sees the partition — which is the object a
 * glossary actually is.
 *
 * So this is not a new detector. It is the same evidence asked a different question: not
 * "do these two look alike" but "which phrasings in this document name one thing". The
 * answer is an equivalence partition with a canonical per class, which is exactly the
 * shape `symspec glossary` commits.
 *
 * ## Propose-only, and it exits 0
 *
 * It writes nothing, and it never picks. `data.ops` carries only classes with zero
 * ambiguous pairs and zero collisions; everything else is a `data.unresolved` entry naming
 * the choice and the consequence of each remedy.
 *
 * The exit code is always 0 on success, which is doctrine rather than convenience: a
 * propose-only signal may push toward abstention but must never drive a gate (see
 * `.erpaval/solutions/architecture/verified-is-decide-tier-not-any-comparison.md`). An
 * unresolved choice is a request for a decision, not a defect in the document. `check
 * --strict` is the gate; this is the authoring aid that makes passing it cheap.
 *
 * ## The embedder is required, and fails closed
 *
 * Same posture as `check`'s always-on semantic tier and for the same red-team reason: a
 * detector that can be skipped silently is a gate that can be gamed by omission. Without
 * the model this exits 2 with `ERR_EMBED_MODEL_MISSING` rather than returning an empty
 * plan that looks like "your vocabulary is already coherent".
 *
 * It never touches `SolverService`. Nothing here needs Z3 — `encodeIncluded` is
 * deliberately Z3-free — so a vocabulary pass must not pay a WASM boot.
 */

import { Effect, Schema } from 'effect'
import { toEngineDoc } from '../../domain/compat.ts'
import { DEFAULT_SEMANTIC_THRESHOLD } from '../../domain/engine/formal/semantic.ts'
import { buildGlossaryPlan, type GlossaryPlan } from '../../domain/glossary/glossary-plan.ts'
import { opLine } from '../../domain/requirements/ops.ts'
import { DocPath, DocStore } from '../../ports/doc-store.ts'
import { EmbedderService } from '../../ports/embedder.ts'
import { ok } from '../runtime/envelope.ts'
import { defineOperation } from '../runtime/operation.ts'

const lines = (...xs: readonly string[]): string => xs.join('\n')

/** The envelope payload: the plan, plus the JSONL an agent pipes into `apply`. */
export interface GlossaryProposalPayload extends GlossaryPlan {
  readonly path: string
  /**
   * `ops` as newline-delimited JSON, so `--field data.opsJsonl` writes a file `apply`
   * consumes with no JSON tool in between. Empty string when there is nothing to apply —
   * NOT `"\n"`, so a redirect produces an empty file rather than a blank op line.
   */
  readonly opsJsonl: string
  /** Counts INTERPOLATED from the plan, never written out. */
  readonly summary: string
}

const ProposeGlossaryInput = Schema.Struct({
  file: Schema.withDecodingDefaultKey<Schema.optionalKey<Schema.NullOr<Schema.String>>>(
    Effect.succeed(null),
  )(
    Schema.optionalKey(
      Schema.NullOr(Schema.String).annotate({
        default: null,
        description: lines(
          'Path to the requirements document to read. Never written.',
          'Resolution precedence, in order: the supplied path, then the SYMSPEC_DOC environment',
          'variable, then the ./requirements.json default.',
        ),
      }),
    ),
  ),
  semanticThreshold: Schema.withDecodingDefaultKey<Schema.NullOr<Schema.Number>>(
    Effect.succeed(null),
  )(
    Schema.NullOr(Schema.Number).annotate({
      default: null,
      description: lines(
        `Cosine threshold for clustering. Omit for the measured default of ${DEFAULT_SEMANTIC_THRESHOLD}.`,
        'The SAME constant `check --semantic-threshold` uses, deliberately: a second number would be',
        'a second thing to calibrate against the model, and two clustering thresholds that disagreed',
        'would make this pass propose merges `check` then declines to act on.',
        'FAVOR RECALL when tuning. Over-clustering surfaces as an extra class you decline; a MISS',
        'leaves two phrasings on distinct atoms, which is the silence this operation exists to break.',
      ),
    }),
  ),
})

/**
 * The oppositions clause, appended to either branch below.
 *
 * Reported even when nothing clusters, because an opposition that formed no class is
 * exactly the case the plan used to be silent about — and it is the half that manufactures
 * a false contradiction if committed the wrong way, so it must not be reachable only by
 * reading `data.oppositions` directly.
 */
const oppositionClause = (plan: GlossaryPlan): string => {
  const found = plan.oppositions.length
  if (found === 0) {
    return plan.corpus.oppositionSignals > 0
      ? ` ${plan.corpus.oppositionSignals} pair(s) carried an opposition signal but sat below the ` +
          `${plan.oppositionCosineFloor} topical floor, so they read as unrelated rather than opposed.`
      : ''
  }
  const quarantined = plan.oppositions.filter((o) => o.formsClass).length
  return (
    ` ${found} structurally-opposed pair(s) reported` +
    (quarantined > 0
      ? `, ${quarantined} of which quarantined a merge`
      : ', none of which a merge threatened') +
    '. Each offers BOTH readings: committing the wrong one manufactures a false contradiction, so ' +
    'none of them is in `ops`.'
  )
}

/**
 * The guard clause, appended to either branch below.
 *
 * Guard alignment is the highest-leverage thing the plan proposes — context groups are keyed
 * on guard atoms, so two requirements whose triggers are paraphrases are never compared at
 * all — and it is the only thing the plan proposes that is NEVER applyable. Both facts belong
 * in the one line a reader sees, because an agent that pipes `opsJsonl` needs to know that
 * the biggest suggestions are not in it.
 */
const guardClause = (plan: GlossaryPlan): string => {
  const total = plan.guardClasses.length
  if (total === 0) {
    return plan.corpus.guardNodes > 0
      ? ` Compared ${plan.corpus.guardPairsCompared} guard pair(s) across ` +
          `${plan.corpus.guardNodes} distinct trigger/precondition phrasing(s): nothing to align.`
      : ''
  }
  const withheld = plan.guardClasses.filter((g) => g.withheldBy.length > 0).length
  const unlocks = new Set(plan.guardClasses.flatMap((g) => g.unlocks)).size
  return (
    ` ${total} guard alignment(s) across ${plan.corpus.guardNodes} trigger/precondition ` +
    `phrasing(s)` +
    (withheld > 0 ? `, ${withheld} of them WITHHELD as likely-different conditions` : '') +
    (unlocks > 0
      ? `; aligning the rest would make ${unlocks} requirement(s) comparable for the first time`
      : '') +
    '. Guard alignments are suggestions only and never appear in `ops`: a wrong one asserts two ' +
    'different conditions are one and can prove a conflict the document does not contain.'
  )
}

/**
 * The term clause.
 *
 * A term generalizes a phrase class to the noun underneath it, so the same alignment keeps
 * applying to requirements written later. Reported with its blast radius because one record
 * reaching many atoms is the whole difference from a phrase entry — and reported as
 * suggest-only for the same reason a guard class is.
 */
const termClause = (plan: GlossaryPlan): string => {
  const total = plan.termCandidates.length
  if (total === 0) return ''
  const withheld = plan.termCandidates.filter((c) => c.withheldBy.length > 0).length
  const atoms = new Set(plan.termCandidates.flatMap((c) => c.blastRadius)).size
  return (
    ` ${total} of those class(es) differ only in a NOUN, so a single \`symspec term\` would ` +
    `align ${atoms} atom(s) and keep aligning them as the document grows` +
    (withheld > 0
      ? `; ${withheld} is WITHHELD because its noun carries a verb the formal tier reads`
      : '') +
    '. Term candidates are suggestions only and never appear in `ops`.'
  )
}

/** One line a human can read before deciding whether to read the rest. */
const summarize = (plan: GlossaryPlan): string => {
  const merges = plan.ops.length
  const classes = plan.classes.length
  const held = plan.unresolved.length
  if (classes === 0 && held === 0) {
    return (
      `Compared ${plan.corpus.pairsCompared} same-system pair(s) across ` +
      `${plan.corpus.responseNodes} distinct response phrasing(s): nothing clusters above ` +
      `${plan.threshold}. The vocabulary is already distinct, or already unified — ` +
      `${plan.corpus.alreadyUnified} phrasing(s) were folded by the committed tables before ` +
      'this pass ran.' +
      oppositionClause(plan) +
      guardClause(plan) +
      termClause(plan)
    )
  }
  const transitive = plan.classes.filter((c) => c.transitive).length
  return (
    `${classes} class(es) proposing ${merges} alias(es), and ${held} class(es) withheld for ` +
    `review. Compared ${plan.corpus.pairsCompared} same-system pair(s) across ` +
    `${plan.corpus.responseNodes} distinct response phrasing(s) at threshold ${plan.threshold}` +
    (transitive > 0
      ? `; ${transitive} class(es) formed by CHAINING rather than direct similarity and are listed first.`
      : '.') +
    oppositionClause(plan) +
    guardClause(plan) +
    termClause(plan)
  )
}

export const proposeGlossaryOp = defineOperation({
  name: 'propose-glossary',
  summary:
    'Propose a whole-document glossary in one pass — the PROPOSE half of the semantic tier, at document scale',
  type: 'glossaryProposal',
  input: ProposeGlossaryInput,
  handler: (input) =>
    Effect.gen(function* () {
      const docPath = yield* DocPath
      const store = yield* DocStore
      const path = docPath.resolve(input.file)
      const loaded = yield* store.load(path)

      // AFTER the document read, so a missing file costs no model load — and BEFORE the
      // plan, so a missing model is ERR_EMBED_MODEL_MISSING (exit 2) rather than an empty
      // plan that reads as "nothing to propose".
      const service = yield* EmbedderService
      const embedder = yield* service.load

      const plan = yield* Effect.promise(() =>
        buildGlossaryPlan(toEngineDoc(loaded.document), embedder, {
          embedderIsStub: service.isStub,
          ...(input.semanticThreshold !== null && Number.isFinite(input.semanticThreshold)
            ? { threshold: input.semanticThreshold }
            : {}),
        }),
      )

      return ok('glossaryProposal', {
        ...plan,
        path,
        opsJsonl: plan.ops.length > 0 ? `${plan.ops.map(opLine).join('\n')}\n` : '',
        summary: summarize(plan),
      } satisfies GlossaryProposalPayload)
    }),
})
