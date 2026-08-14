/**
 * THE PINNED ADVERSARIAL ROUNDS — ground truth for the gate in
 * `../formal/adversarial.test.ts`.
 *
 * Twelve documents reconstructed from the Run 1-3 red-team eval: the rounds where a
 * proposer authored specs whose z3-confirmed contradictions symspec certified clean
 * (`exit 0`, `data.verified: true`, under `--strict --semantic --temporal`). Nine plant a
 * contradiction a sound extractor can reach; three plant one it cannot, where the required
 * behavior is to decline rather than to guess.
 *
 * Each case reproduces one WINNING PATTERN and pins the fix that closes it:
 *   - lexicon rounds (commit/rollback, seal/expose, quarantine/release, publish/retract,
 *     suspend/resume in 3sg, exclude-from/include-in) prove `FND_CONTRADICTION` through the
 *     expanded antonym seeds, de-inflection, and the preposition rule;
 *   - bridge-chain rounds (grant-vs-deny behind authenticated -> verified -> trusted ->
 *     privileged; "keeps the reactor online" behind a copula guard) prove through the
 *     widened establish-verb lexicon, copula normalization, and the
 *     grant/allow/permit-deny class merge;
 *   - the beyond-the-lexicon rounds assert that `verified` DEMOTES instead of certifying.
 *
 * ## Ground truth, never a verdict
 *
 * These fixtures label what was planted. They do not decide what the tool should conclude —
 * the tool under test does that, and the gate scores it. A fixture that authored verdicts
 * would be an oracle marking its own homework.
 *
 * ## The fixtures are not sacred
 *
 * When the gate reports a miss, check whether the FIXTURE is a valid instance of the defect
 * before touching a detector: dropping a `negated` flag or double-negating a pattern makes a
 * "contradiction" secretly consistent. A miss is either a real detector gap or an invalid
 * fixture. Both are worth fixing and they are different fixes.
 *
 * ## Shape
 *
 * `AdversarialCase` comes from `./generate.ts`, which owns it: these rounds and the generated
 * ladder are scored by the same harness, so they are the same shape by construction rather
 * than by coincidence. Nothing here generates a case — the `tier` field carries the recorded
 * difficulty of a round a red team actually won.
 *
 * The documents are v2-shaped, which is what the eval authored and what
 * `engine/core/schema.ts` still describes. `../formal/adversarial.test.ts` projects them onto
 * the v3 shape at the point of use.
 */

import { renderSentence } from '../domain/engine/core/render.ts'
import {
  type Requirement,
  type RequirementsDoc,
  SCHEMA_VERSION,
} from '../domain/engine/core/schema.ts'
import type { AdversarialCase } from './generate.ts'

/**
 * An empty v2 document.
 *
 * Inlined because v4's `emptyDoc` did not survive into this package, and the only
 * caller is this file. Six fields, all required by `RequirementsDoc`.
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

function docOf(reqs: Requirement[]): RequirementsDoc {
  const doc = emptyDoc()
  for (const r of reqs) doc.requirements[r.id] = r
  return doc
}

/** Stable ids: readable, deterministic, unique per case. */
const rid = (caseTag: string, n: number): string => `eval-${caseTag}-r${n}`

/**
 * The Run 3 winning-pattern fixtures. Cases 1–8 expect a proven
 * FND_CONTRADICTION naming the planted culprits; case 9 (`verified-demotion`)
 * expects NO contradiction but a demoted `verified` (asserted in the test, not
 * via expectedCodes).
 */
export function evalRoundCases(): AdversarialCase[] {
  const cases: AdversarialCase[] = []

  // ---- 1. Run 3 Round 1/20: grant vs deny behind a 4-hop privilege chain.
  // symspec verdict then: exit 0, verified=true, pairsChecked 6, unmatched 12.
  {
    const t = 'privchain'
    const reqs = [
      mkReq({
        id: rid(t, 1),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the session is authenticated',
        systemResponse: 'deny access to the vault',
      }),
      mkReq({
        id: rid(t, 2),
        patternType: 'event-driven',
        systemName: 'controller',
        trigger: 'a user signs in',
        systemResponse: 'mark the session authenticated',
      }),
      mkReq({
        id: rid(t, 3),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the session is authenticated',
        systemResponse: 'mark the session verified',
      }),
      mkReq({
        id: rid(t, 4),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the session is verified',
        systemResponse: 'mark the session trusted',
      }),
      mkReq({
        id: rid(t, 5),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the session is trusted',
        systemResponse: 'mark the session privileged',
      }),
      mkReq({
        id: rid(t, 6),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the session is privileged',
        systemResponse: 'grant access to the vault',
      }),
      // Distractor weave (same vocabulary, individually consistent) — the
      // eval used these to buy pairsChecked > 0 under the old predicate.
      mkReq({
        id: rid(t, 7),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the session is trusted',
        systemResponse: 'record the vault access in the ledger',
      }),
      mkReq({
        id: rid(t, 8),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the session is verified',
        systemResponse: 'refresh the session token',
      }),
      mkReq({
        id: rid(t, 9),
        patternType: 'event-driven',
        systemName: 'controller',
        trigger: 'a user signs out',
        systemResponse: 'clear the session',
      }),
      mkReq({
        id: rid(t, 10),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the session is privileged',
        systemResponse: 'audit the vault access',
      }),
    ]
    cases.push({
      id: 'eval-r3-privchain',
      kind: 'contradiction',
      tier: 5,
      expectedCodes: ['FND_CONTRADICTION'],
      culpritIds: [rid(t, 1), rid(t, 6)],
      doc: docOf(reqs),
      note:
        'Run 3 R1/R20: authenticated→verified→trusted→privileged bridge chain forces grant AND ' +
        'deny on the vault. Closed by: establish-verb bridges + copula strip (E/A3) + the ' +
        'grant/allow/permit–deny antonym class merge (B).',
    })
  }

  // ---- 2. Run 3 R2/5/8/11/13/14/16/17/18/21/22/27/29: commit vs "roll back".
  {
    const t = 'commitrb'
    const reqs = [
      mkReq({
        id: rid(t, 1),
        patternType: 'event-driven',
        systemName: 'engine',
        trigger: 'a payment request arrives',
        systemResponse: 'mark the transaction validated',
      }),
      mkReq({
        id: rid(t, 2),
        patternType: 'state-driven',
        systemName: 'engine',
        preCondition: 'the transaction is validated',
        systemResponse: 'mark the transaction reconciled',
      }),
      mkReq({
        id: rid(t, 3),
        patternType: 'state-driven',
        systemName: 'engine',
        preCondition: 'the transaction is reconciled',
        systemResponse: 'commit the settlement',
      }),
      mkReq({
        id: rid(t, 4),
        patternType: 'state-driven',
        systemName: 'engine',
        preCondition: 'the transaction is reconciled',
        systemResponse: 'rolls back the settlement',
      }),
      mkReq({
        id: rid(t, 5),
        patternType: 'state-driven',
        systemName: 'engine',
        preCondition: 'the transaction is validated',
        systemResponse: 'timestamp the transaction',
      }),
    ]
    cases.push({
      id: 'eval-r3-commit-rollback',
      kind: 'contradiction',
      tier: 5,
      expectedCodes: ['FND_CONTRADICTION'],
      culpritIds: [rid(t, 3), rid(t, 4)],
      doc: docOf(reqs),
      note:
        'Run 3 settlement rounds: commit vs "rolls back" the same settlement under one reachable ' +
        'guard. Closed by: commit/roll_back seed pair + multiword head lookup + 3sg de-inflection (A/B).',
    })
  }

  // ---- 3. Run 3 R10/12/24/26: seal vs expose behind a bridged guard chain.
  {
    const t = 'sealexpose'
    const reqs = [
      mkReq({
        id: rid(t, 1),
        patternType: 'event-driven',
        systemName: 'vault',
        trigger: 'a document is submitted',
        systemResponse: 'classify the document as restricted',
      }),
      mkReq({
        id: rid(t, 2),
        patternType: 'state-driven',
        systemName: 'vault',
        preCondition: 'the document is restricted',
        systemResponse: 'seal the record',
      }),
      mkReq({
        id: rid(t, 3),
        patternType: 'state-driven',
        systemName: 'vault',
        preCondition: 'the document is restricted',
        systemResponse: 'exposes the record',
      }),
      mkReq({
        id: rid(t, 4),
        patternType: 'state-driven',
        systemName: 'vault',
        preCondition: 'the document is restricted',
        systemResponse: 'encrypt the payload',
      }),
    ]
    cases.push({
      id: 'eval-r3-seal-expose',
      kind: 'contradiction',
      tier: 5,
      expectedCodes: ['FND_CONTRADICTION'],
      culpritIds: [rid(t, 2), rid(t, 3)],
      doc: docOf(reqs),
      note:
        'Run 3 document-vault rounds: seal vs expose the same record under one guard ("classify … ' +
        'as restricted" also exercises the new establish verb). Closed by: seal/expose seed pair (B).',
    })
  }

  // ---- 4. Run 3 R7/23/25/30: quarantine vs release.
  {
    const t = 'quarrel'
    const reqs = [
      mkReq({
        id: rid(t, 1),
        patternType: 'event-driven',
        systemName: 'gateway',
        trigger: 'an artifact is uploaded',
        systemResponse: 'mark the artifact scanned',
      }),
      mkReq({
        id: rid(t, 2),
        patternType: 'state-driven',
        systemName: 'gateway',
        preCondition: 'the artifact is scanned',
        systemResponse: 'quarantine the artifact',
      }),
      mkReq({
        id: rid(t, 3),
        patternType: 'state-driven',
        systemName: 'gateway',
        preCondition: 'the artifact is scanned',
        systemResponse: 'release the artifact',
      }),
      mkReq({
        id: rid(t, 4),
        patternType: 'state-driven',
        systemName: 'gateway',
        preCondition: 'the artifact is scanned',
        systemResponse: 'record the scan timestamp',
      }),
    ]
    cases.push({
      id: 'eval-r3-quarantine-release',
      kind: 'contradiction',
      tier: 5,
      expectedCodes: ['FND_CONTRADICTION'],
      culpritIds: [rid(t, 2), rid(t, 3)],
      doc: docOf(reqs),
      note:
        'Run 3 R23: an uploaded artifact is simultaneously quarantined and released. Closed by: ' +
        'quarantine/release seed pair (B).',
    })
  }

  // ---- 5. Run 3 R4/15/28: publish vs retract via a bridged approval chain.
  {
    const t = 'pubret'
    const reqs = [
      mkReq({
        id: rid(t, 1),
        patternType: 'event-driven',
        systemName: 'controller',
        trigger: 'an audit request is received',
        systemResponse: 'mark the article escalated',
      }),
      mkReq({
        id: rid(t, 2),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the article is escalated',
        systemResponse: 'mark the article approved',
      }),
      mkReq({
        id: rid(t, 3),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the article is approved',
        systemResponse: 'publish the article',
      }),
      mkReq({
        id: rid(t, 4),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the article is escalated',
        systemResponse: 'mark the article flagged',
      }),
      mkReq({
        id: rid(t, 5),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the article is flagged',
        systemResponse: 'retract the article',
      }),
    ]
    cases.push({
      id: 'eval-r3-publish-retract',
      kind: 'contradiction',
      tier: 5,
      expectedCodes: ['FND_CONTRADICTION'],
      culpritIds: [rid(t, 3), rid(t, 5)],
      doc: docOf(reqs),
      note:
        'Run 3 R15: escalated forces approved (→publish) AND flagged (→retract) — the same article ' +
        'published and retracted. Closed by: publish/retract seed pair + mark-bridges + copula strip (B/E/A3).',
    })
  }

  // ---- 6. Run 3 R24 shape: suspend vs resume, third-person phrasing.
  {
    const t = 'susres'
    const reqs = [
      mkReq({
        id: rid(t, 1),
        patternType: 'event-driven',
        systemName: 'gateway',
        trigger: 'a maintenance request is received',
        systemResponse: 'mark the gateway safe mode engaged',
      }),
      mkReq({
        id: rid(t, 2),
        patternType: 'state-driven',
        systemName: 'gateway',
        preCondition: 'the gateway safe mode is engaged',
        systemResponse: 'suspends the data feed',
      }),
      mkReq({
        id: rid(t, 3),
        patternType: 'state-driven',
        systemName: 'gateway',
        preCondition: 'the gateway safe mode is engaged',
        systemResponse: 'resumes the data feed',
      }),
    ]
    cases.push({
      id: 'eval-r3-suspend-resume',
      kind: 'contradiction',
      tier: 5,
      expectedCodes: ['FND_CONTRADICTION'],
      culpritIds: [rid(t, 2), rid(t, 3)],
      doc: docOf(reqs),
      note:
        'Run 2 R24 shape: safe mode simultaneously suspends and resumes the data feed, phrased in ' +
        '3sg. Closed by: suspend/resume seed pair + head de-inflection (A1/B).',
    })
  }

  // ---- 7. The original FEEDBACK residual: exclude-from vs include-in.
  {
    const t = 'gallery'
    const reqs = [
      mkReq({
        id: rid(t, 1),
        patternType: 'event-driven',
        systemName: 'gallery service',
        trigger: 'the curator hides a tile',
        systemResponse: 'exclude that tile from the default gallery view',
      }),
      mkReq({
        id: rid(t, 2),
        patternType: 'event-driven',
        systemName: 'gallery service',
        trigger: 'the curator hides a tile',
        systemResponse: 'include that tile in the default gallery view',
      }),
    ]
    cases.push({
      id: 'eval-feedback-exclude-include',
      kind: 'contradiction',
      tier: 4,
      expectedCodes: ['FND_CONTRADICTION'],
      culpritIds: [rid(t, 1), rid(t, 2)],
      doc: docOf(reqs),
      note:
        'The FEEDBACK residual: include/exclude was seeded but "from"/"in" kept the remainders ' +
        'distinct. Closed by: the antonym-hit preposition rule (A4).',
    })
  }

  // ---- 8. Run 2 reactor shape: "keeps the reactor online" copula bridge.
  {
    const t = 'reactor'
    const reqs = [
      mkReq({
        id: rid(t, 1),
        patternType: 'event-driven',
        systemName: 'controller',
        trigger: 'the temperature sensor reports overheating',
        systemResponse: 'mark the coolant pump engaged',
      }),
      mkReq({
        id: rid(t, 2),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the coolant pump is engaged',
        systemResponse: 'keeps the reactor online',
      }),
      mkReq({
        id: rid(t, 3),
        patternType: 'state-driven',
        systemName: 'controller',
        preCondition: 'the reactor is online',
        systemResponse: 'grant power to the distribution grid',
      }),
      mkReq({
        id: rid(t, 4),
        patternType: 'event-driven',
        systemName: 'controller',
        trigger: 'the temperature sensor reports overheating',
        systemResponse: 'deny power to the distribution grid',
      }),
    ]
    cases.push({
      id: 'eval-r2-reactor-keeps-online',
      kind: 'contradiction',
      tier: 5,
      expectedCodes: ['FND_CONTRADICTION'],
      culpritIds: [rid(t, 3), rid(t, 4)],
      doc: docOf(reqs),
      note:
        'Run 2 R3/R8 shape: overheating engages the pump, "keeps the reactor online" bridges into ' +
        'the copula guard "the reactor is online", forcing grant AND deny power. Closed by: ' +
        'keep/hold establish form + copula strip + grant/deny merge (E/A3/B).',
    })
  }

  // ---- 9. Abstention backstop: a real conflict genuinely beyond the lexicon.
  // "floods the ballast tank" vs "vents the ballast tank" — vent is not an
  // antonym of flood in any committed table, no bridge reaches across, and the
  // guards differ. The HARDENED verified must refuse to certify (demote), not
  // exit 0/verified=true as Run 3 did.
  {
    const t = 'abstain'
    const reqs = [
      mkReq({
        id: rid(t, 1),
        patternType: 'state-driven',
        systemName: 'ballast controller',
        preCondition: 'the dive sequence is initiated',
        systemResponse: 'floods the ballast tank',
      }),
      mkReq({
        id: rid(t, 2),
        patternType: 'state-driven',
        systemName: 'ballast controller',
        preCondition: 'the surfacing sequence is initiated',
        systemResponse: 'vents the ballast tank',
      }),
      mkReq({
        id: rid(t, 3),
        patternType: 'event-driven',
        systemName: 'ballast controller',
        trigger: 'the emergency blow is commanded',
        systemResponse: 'ignite the gas generator',
      }),
    ]
    cases.push({
      id: 'eval-verified-demotion-backstop',
      kind: 'contradiction',
      tier: 5,
      expectedCodes: [],
      culpritIds: [rid(t, 1), rid(t, 2)],
      doc: docOf(reqs),
      note:
        'Abstention backstop: no committed antonym/bridge reaches this conflict, so no ' +
        'FND_CONTRADICTION is provable — but the hardened verified must DEMOTE (uncovered ' +
        'requirements / opposition candidate), never certify. Asserted in eval-rounds.test.ts.',
    })
  }

  // ---- 10. GitHub issue #2 reproducer (a): same physical quantity, two verbs.
  // "complete the infusion within at most 30 minutes" (≤30) vs "run the infusion
  // for at least 60 minutes" (≥60) — one duration, jointly UNSAT, but the two
  // verb phrasings key to different quantities so the pairwise LIA tier never
  // compares them. symspec verdict then: exit 0, verified=true. Now the
  // quantity-alias candidate demotes verified (abstention) and hands the author
  // the glossary command; case 11 proves the fix works once committed.
  {
    const t = 'issue2-infusion'
    const trigger = 'an infusion is started'
    const reqs = [
      mkReq({
        id: rid(t, 1),
        patternType: 'event-driven',
        systemName: 'infusion pump',
        trigger,
        systemResponse: 'complete the infusion within at most 30 minutes',
      }),
      mkReq({
        id: rid(t, 2),
        patternType: 'event-driven',
        systemName: 'infusion pump',
        trigger,
        systemResponse: 'run the infusion for at least 60 minutes',
      }),
    ]
    cases.push({
      id: 'eval-issue2-infusion-quantity-alias',
      kind: 'contradiction',
      tier: 5,
      expectedCodes: [],
      culpritIds: [rid(t, 1), rid(t, 2)],
      doc: docOf(reqs),
      note:
        'Issue #2 (a): same-quantity-two-verbs. No glossary alias committed, so the numeric ' +
        'tier keys the bounds separately and cannot prove the ≤30 ∧ ≥60 conflict — but the ' +
        'quantity-alias candidate (+ relational-unchecked) must DEMOTE verified, never certify.',
    })
  }

  // ---- 11. Issue #2 (a), the fix committed: with the author-confirmed glossary
  // alias unifying both verb phrasings onto one quantity, the numeric tier now
  // sees ≤30min ∧ ≥60min on ONE duration and PROVES FND_NUMERIC_CONTRADICTION.
  // This is the propose→decide loop closing: the candidate told the author what
  // to commit, and committing it turned abstention into a hard proof.
  {
    const t = 'issue2-infusion-fixed'
    const trigger = 'an infusion is started'
    const reqs = [
      mkReq({
        id: rid(t, 1),
        patternType: 'event-driven',
        systemName: 'infusion pump',
        trigger,
        systemResponse: 'complete the infusion within at most 30 minutes',
      }),
      mkReq({
        id: rid(t, 2),
        patternType: 'event-driven',
        systemName: 'infusion pump',
        trigger,
        systemResponse: 'run the infusion for at least 60 minutes',
      }),
    ]
    cases.push({
      id: 'eval-issue2-infusion-proven-via-glossary',
      kind: 'contradiction',
      tier: 5,
      expectedCodes: ['FND_NUMERIC_CONTRADICTION'],
      culpritIds: [rid(t, 1), rid(t, 2)],
      doc: (() => {
        const d = docOf(reqs)
        // The exact alias the quantity-alias candidate suggests for this pair
        // (`glossary add "infusion within" "run the infusion"`), unifying the two
        // verb-phrasings onto one quantity key so the LIA tier proves the conflict.
        d.glossary = [{ canonical: 'run the infusion', aliases: ['infusion within'] }]
        return d
      })(),
      note:
        'Issue #2 (a) fixed: the committed glossary alias unifies both verb phrasings onto one ' +
        'quantity, so the numeric tier proves FND_NUMERIC_CONTRADICTION (≤30min ∧ ≥60min UNSAT) ' +
        'naming both requirements — the propose→decide loop closing on a real z3 proof.',
    })
  }

  // ---- 12. GitHub issue #2 reproducer (b): odd-cycle 2-coloring. Five sensors
  // in a ring, each required to differ from its neighbor's channel, only two
  // channels — graph-theoretically impossible, but every pair is individually
  // satisfiable so the pairwise tier reports verified=true. Not soundly
  // recoverable from NL; the relational-unchecked disclosure must DEMOTE.
  {
    const t = 'issue2-ring'
    const trigger = 'the ring bus initializes'
    const responses = [
      'route sensor traffic across two channels',
      'assign sensor one to a channel that differs from the channel of sensor two',
      'assign sensor two to a channel that differs from the channel of sensor three',
      'assign sensor three to a channel that differs from the channel of sensor four',
      'assign sensor four to a channel that differs from the channel of sensor five',
      'assign sensor five to a channel that differs from the channel of sensor one',
    ]
    const reqs = responses.map((systemResponse, i) =>
      mkReq({
        id: rid(t, i + 1),
        patternType: 'event-driven',
        systemName: 'controller',
        trigger,
        systemResponse,
      }),
    )
    cases.push({
      id: 'eval-issue2-ring-odd-cycle',
      kind: 'contradiction',
      tier: 5,
      expectedCodes: [],
      culpritIds: [rid(t, 2), rid(t, 3), rid(t, 4), rid(t, 5), rid(t, 6)],
      doc: docOf(reqs),
      note:
        'Issue #2 (b): odd-cycle 2-coloring, an emergent structural impossibility beyond any ' +
        'deterministic NL extractor. No FND_CONTRADICTION is provable, but the relational-unchecked ' +
        'disclosure must DEMOTE verified — the tool declines to certify rather than certify a lie.',
    })
  }

  return cases
}
