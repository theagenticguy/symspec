/**
 * GENERATIVE-ADVERSARIAL BAD-SPEC GENERATOR — the searcher, not the scoreboard.
 *
 * `eval-rounds.ts` pins twelve rounds a red team already won. This produces defects nobody
 * has seen: symspec documents carrying a KNOWN, LABELLED flaw — a contradiction, a numeric
 * conflict, a temporal ordering conflict, an ambiguity, or a missing-link/DAG defect — so
 * `harness.ts` can run the real pipeline over each and score whether the right finding fired
 * on the right requirement ids.
 *
 * Difficulty escalates. Tier 1 defects are blatant (verbatim opposites); higher tiers bury
 * the defect under paraphrase, unit mismatch, indirection, and distractor requirements, so a
 * detector passing at tier N is a real capability claim rather than a passing example.
 *
 * ## Why a generator earns its keep next to a green suite
 *
 * A unit test proves a detector fires on the one input its author imagined. It says nothing
 * about the inputs the author did not imagine, and that gap is where every missed conflict
 * lives. The first run of this generator surfaced three real defects a fully green suite had
 * hidden: the numeric tier ran only over gate-INCLUDED requirements so a missing-units lint
 * error hid a real numeric contradiction; quantity-label capture kept trailing prepositions,
 * splitting one quantity so a conflict escaped; and "no less than" also matched the substring
 * "less than", emitting a spurious opposite predicate. None had a failing test.
 *
 * ## Deterministic by construction
 *
 * Pure in a numeric `seed` — no `Math.random`, no clock. Variety comes from indexing fixed
 * template banks by `seed`, so a run is byte-reproducible and a caught or missed defect is
 * replayable. A model can author fixtures in this same shape for open-ended pressure; the
 * built-in generator is the deterministic floor the regression gate rides on.
 *
 * ## The fixtures are not sacred
 *
 * When the harness reports a miss, check whether the FIXTURE is a valid instance of the
 * defect before touching a detector — dropping a `negated` flag or double-negating a pattern
 * makes a "contradiction" secretly consistent. A miss is either a real detector gap or an
 * invalid fixture. Both are worth fixing and they are different fixes.
 */

import { renderSentence } from '../domain/engine/core/render.ts'
import {
  type Requirement,
  type RequirementsDoc,
  SCHEMA_VERSION,
} from '../domain/engine/core/schema.ts'

/** The defect class a generated spec is seeded with — the ground-truth label. */
export type DefectKind = 'contradiction' | 'numeric' | 'temporal' | 'ambiguity' | 'missing-link'

/** One labelled adversarial fixture. */
export interface AdversarialCase {
  /** Stable case id, e.g. `contradiction-t2-7`. */
  readonly id: string
  /** The defect class the detector is expected to catch. */
  readonly kind: DefectKind
  /** Difficulty tier (1 = blatant … 4 = subtle). */
  readonly tier: number
  /** The FND_* codes any of which counts as a correct detection. */
  readonly expectedCodes: readonly string[]
  /** The requirement ids that SHOULD appear in the finding (localization target). */
  readonly culpritIds: readonly string[]
  /** The document to hand to `check`. */
  readonly doc: RequirementsDoc
  /** Human note describing what was planted. */
  readonly note: string
}

/**
 * An empty v2 document.
 *
 * Inlined because v4's `emptyDoc` did not survive into this package.
 */
function emptyDoc(): RequirementsDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    requirements: {},
    glossary: [],
    waivers: [],
    antonyms: [],
  }
}

const TS = '2026-01-01T00:00:00.000Z'

/** Build a requirement with sensible defaults + rendered sentence. */
function mkReq(partial: Partial<Requirement> & Pick<Requirement, 'id'>): Requirement {
  const base: Requirement = {
    id: partial.id,
    patternType: partial.patternType ?? 'ubiquitous',
    systemName: partial.systemName ?? 'system',
    systemResponse: partial.systemResponse ?? 'operate',
    negated: partial.negated ?? false,
    sentence: '',
    priority: 'medium',
    status: 'draft',
    createdAt: TS,
    updatedAt: TS,
    derives: partial.derives ?? [],
    satisfies: partial.satisfies ?? [],
    verifies: partial.verifies ?? [],
    refines: partial.refines ?? [],
    ...(partial.trigger !== undefined ? { trigger: partial.trigger } : {}),
    ...(partial.preCondition !== undefined ? { preCondition: partial.preCondition } : {}),
  }
  base.sentence = renderSentence(base)
  return base
}

/** Deterministic pick from a bank by seed. */
function pick<T>(bank: readonly T[], seed: number): T {
  return bank[seed % bank.length] as T
}

/** Assemble a doc from requirements + optional glossary. */
function docOf(reqs: Requirement[], glossary: RequirementsDoc['glossary'] = []): RequirementsDoc {
  const doc = emptyDoc()
  for (const r of reqs) doc.requirements[r.id] = r
  doc.glossary = glossary
  return doc
}

/** Distractor requirements — plausible, conflict-free noise to bury the defect. */
function distractors(n: number, seed: number): Requirement[] {
  const bank = [
    { sys: 'auth service', resp: 'log the authentication attempt' },
    { sys: 'billing service', resp: 'record the invoice' },
    { sys: 'notifier', resp: 'send a confirmation email' },
    { sys: 'cache', resp: 'evict the stale entry' },
    { sys: 'scheduler', resp: 'enqueue the job' },
  ]
  const out: Requirement[] = []
  for (let i = 0; i < n; i++) {
    const b = pick(bank, seed + i)
    out.push(
      mkReq({
        id: `distractor-${seed}-${i}`,
        systemName: b.sys,
        systemResponse: b.resp,
        patternType: 'ubiquitous',
      }),
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-kind generators, parameterized by difficulty tier
// ---------------------------------------------------------------------------

/**
 * A CONTRADICTION fixture. Tier escalates from a verbatim antonym pair (tier 1)
 * to a glossary-bridged paraphrase under distractors (tier 4).
 */
function genContradiction(tier: number, seed: number): AdversarialCase {
  const a = `c-${seed}-a`
  const b = `c-${seed}-b`
  const trigger = 'the user submits valid credentials'
  const sys = 'auth service'
  let reqs: Requirement[]
  let glossary: RequirementsDoc['glossary'] = []
  let note: string

  if (tier <= 1) {
    // Blatant: same trigger, grant vs revoke (seed antonym table).
    reqs = [
      mkReq({
        id: a,
        patternType: 'event-driven',
        systemName: sys,
        trigger,
        systemResponse: 'grant access',
      }),
      mkReq({
        id: b,
        patternType: 'event-driven',
        systemName: sys,
        trigger,
        systemResponse: 'revoke access',
      }),
    ]
    note = 'verbatim antonym responses under one trigger (grant vs revoke)'
  } else if (tier === 2) {
    // shall / shall-not on the same response atom.
    reqs = [
      mkReq({
        id: a,
        patternType: 'event-driven',
        systemName: sys,
        trigger,
        systemResponse: 'issue a session token',
      }),
      mkReq({
        id: b,
        patternType: 'event-driven',
        systemName: sys,
        trigger,
        systemResponse: 'issue a session token',
        negated: true,
      }),
    ]
    note = 'shall vs shall-not on the same response atom'
  } else {
    // Paraphrase bridged by a committed glossary, buried under distractors.
    reqs = [
      mkReq({
        id: a,
        patternType: 'event-driven',
        systemName: sys,
        trigger,
        systemResponse: 'issue a session token',
      }),
      mkReq({
        id: b,
        patternType: 'event-driven',
        systemName: sys,
        trigger,
        systemResponse: 'issue a login credential',
        negated: true,
      }),
      ...distractors(tier === 4 ? 4 : 2, seed),
    ]
    glossary = [{ canonical: 'issue a session token', aliases: ['issue a login credential'] }]
    note = 'glossary-bridged paraphrase contradiction buried under distractors'
  }

  return {
    id: `contradiction-t${tier}-${seed}`,
    kind: 'contradiction',
    tier,
    expectedCodes: ['FND_CONTRADICTION'],
    culpritIds: [a, b],
    doc: docOf(reqs, glossary),
    note,
  }
}

/** A NUMERIC conflict fixture; tier escalates via unit mismatch + distractors. */
function genNumeric(tier: number, seed: number): AdversarialCase {
  const a = `n-${seed}-a`
  const b = `n-${seed}-b`
  const sys = 'api'
  let reqs: Requirement[]
  let note: string

  if (tier <= 1) {
    reqs = [
      mkReq({ id: a, systemName: sys, systemResponse: 'keep latency below 100' }),
      mkReq({ id: b, systemName: sys, systemResponse: 'keep latency above 500' }),
    ]
    note = 'same unit, obviously disjoint latency bounds'
  } else if (tier === 2) {
    reqs = [
      mkReq({ id: a, systemName: sys, systemResponse: 'respond within 2 seconds' }),
      mkReq({ id: b, systemName: sys, systemResponse: 'respond over 3000 ms' }),
    ]
    note = 'unit mismatch (s vs ms) hides the conflict from a lexical check'
  } else {
    reqs = [
      mkReq({ id: a, systemName: sys, systemResponse: 'respond within 1 second' }),
      mkReq({ id: b, systemName: sys, systemResponse: 'respond in no less than 2000 ms' }),
      ...distractors(tier === 4 ? 4 : 2, seed),
    ]
    note = 'unit mismatch + phrasing variety + distractors'
  }

  return {
    id: `numeric-t${tier}-${seed}`,
    kind: 'numeric',
    tier,
    expectedCodes: ['FND_NUMERIC_CONTRADICTION'],
    culpritIds: [a, b],
    doc: docOf(reqs),
    note,
  }
}

/** A TEMPORAL ordering conflict: "when T shall R" vs "shall never R" with T reachable. */
function genTemporal(tier: number, seed: number): AdversarialCase {
  const a = `t-${seed}-a`
  const b = `t-${seed}-b`
  const sys = 'controller'
  const trigger = 'the sensor reports overheat'
  // A: event-driven → G(T → F open) — on overheat the valve must EVENTUALLY open.
  // B: ubiquitous prohibition → G(¬open) — the valve must NEVER open (a global
  // absence, not trigger-scoped, so it genuinely blocks the eventual response).
  // With T reachable, F open and G ¬open cannot both hold: a true temporal
  // contradiction the bounded LTL→SMT check proves (not just a snapshot clash).
  const reqs = [
    mkReq({
      id: a,
      patternType: 'event-driven',
      systemName: sys,
      trigger,
      systemResponse: 'open the relief valve',
    }),
    mkReq({
      id: b,
      patternType: 'ubiquitous',
      systemName: sys,
      systemResponse: 'open the relief valve',
      negated: true,
    }),
    ...(tier >= 3 ? distractors(2, seed) : []),
  ]
  return {
    id: `temporal-t${tier}-${seed}`,
    kind: 'temporal',
    tier,
    // Temporal or propositional contradiction both localize the same conflict.
    expectedCodes: ['FND_TEMPORAL_CONTRADICTION', 'FND_CONTRADICTION'],
    culpritIds: [a, b],
    doc: docOf(reqs),
    note: 'response-vs-absence on the same trigger+response (temporal conflict)',
  }
}

/** An AMBIGUITY fixture: vague/quantifier/reference by tier. */
function genAmbiguity(tier: number, seed: number): AdversarialCase {
  const a = `amb-${seed}`
  if (tier <= 1) {
    return {
      id: `ambiguity-t${tier}-${seed}`,
      kind: 'ambiguity',
      tier,
      expectedCodes: ['FND_AMBIGUOUS_VAGUE'],
      culpritIds: [a],
      doc: docOf([
        mkReq({
          id: a,
          systemName: 'api',
          systemResponse: 'respond in a fast and user-friendly manner',
        }),
      ]),
      note: 'vague terms (fast, user-friendly)',
    }
  }
  if (tier === 2) {
    return {
      id: `ambiguity-t${tier}-${seed}`,
      kind: 'ambiguity',
      tier,
      expectedCodes: ['FND_AMBIGUOUS_QUANTIFIER'],
      culpritIds: [a],
      doc: docOf([
        mkReq({
          id: a,
          systemName: 'api',
          systemResponse: 'validate all inputs and reject or sanitize them',
        }),
      ]),
      note: 'un-parenthesized and/or coordination + leading "all"',
    }
  }
  // Referential ambiguity: a pronoun ("it") with ≥2 distinct systems in scope,
  // so "it" could bind to either system — the detector's candidate condition.
  const other = `amb-${seed}-ctx`
  return {
    id: `ambiguity-t${tier}-${seed}`,
    kind: 'ambiguity',
    tier,
    expectedCodes: ['FND_AMBIGUOUS_REFERENCE'],
    culpritIds: [a],
    doc: docOf([
      mkReq({
        id: a,
        systemName: 'gateway',
        systemResponse: 'forward it to the backend',
        trigger: 'the request arrives',
        patternType: 'event-driven',
      }),
      mkReq({ id: other, systemName: 'backend', systemResponse: 'persist the record' }),
      ...(tier >= 4 ? distractors(2, seed) : []),
    ]),
    note: 'pronoun "it" with ≥2 systems in scope (referential ambiguity)',
  }
}

/** A MISSING-LINK fixture: two near-duplicate requirements with no committed edge. */
function genMissingLink(tier: number, seed: number): AdversarialCase {
  const a = `ml-${seed}-a`
  const b = `ml-${seed}-b`
  const sys = 'auth service'
  const reqs = [
    mkReq({ id: a, systemName: sys, systemResponse: 'issue a session token on login' }),
    mkReq({ id: b, systemName: sys, systemResponse: 'issue a session token after authentication' }),
    ...(tier >= 3 ? distractors(2, seed) : []),
  ]
  return {
    id: `missing-link-t${tier}-${seed}`,
    kind: 'missing-link',
    tier,
    expectedCodes: ['FND_MISSING_TRACE_LINK', 'FND_SIMILAR_SEMANTIC'],
    culpritIds: [a, b],
    doc: docOf(reqs),
    note: 'two near-duplicate requirements with no committed trace link',
  }
}

const GENERATORS: Record<DefectKind, (tier: number, seed: number) => AdversarialCase> = {
  contradiction: genContradiction,
  numeric: genNumeric,
  temporal: genTemporal,
  ambiguity: genAmbiguity,
  'missing-link': genMissingLink,
}

/** All defect kinds, in a stable order. */
export const DEFECT_KINDS: readonly DefectKind[] = [
  'contradiction',
  'numeric',
  'temporal',
  'ambiguity',
  'missing-link',
]

/**
 * Generate a batch of labelled adversarial cases for a difficulty tier: one per
 * defect kind, offset by `seed` for variety. Deterministic in `(tier, seed)`.
 */
export function generateCases(tier: number, seed = 0): AdversarialCase[] {
  return DEFECT_KINDS.map((kind, i) => GENERATORS[kind](tier, seed + i))
}
