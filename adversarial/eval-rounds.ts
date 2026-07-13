/**
 * Regression fixtures reconstructed from the Run 1–3 adversarial eval — the
 * 25/30 rounds where a red-team proposer (Opus 4.8) authored specs whose
 * z3-confirmed contradictions symspec certified clean (`exit 0`,
 * `data.verified=true` under `--strict --semantic --temporal`).
 *
 * Each case reproduces one WINNING PATTERN and asserts the fix that closes it:
 *   - lexicon rounds (commit/rollback, seal/expose, quarantine/release,
 *     publish/retract, suspend/resume in 3sg, exclude-from/include-in) now
 *     prove `FND_CONTRADICTION` via the expanded antonym seeds + de-inflection
 *     + the preposition rule;
 *   - bridge-chain rounds (grant-vs-deny behind authenticated→verified→
 *     trusted→privileged; "keeps the reactor online" behind a copula guard)
 *     now prove via the widened establish-verb lexicon + copula normalization
 *     + the grant/allow/permit–deny class merge;
 *   - the abstention round (a contradiction genuinely beyond the lexicon)
 *     asserts the HARDENED `verified` demotes instead of certifying —
 *     the backstop when proof is out of reach.
 *
 * These are `AdversarialCase`-shaped so the harness can score them alongside
 * the generated banks; `adversarial/__tests__/eval-rounds.test.ts` runs each
 * through `runCheck` directly.
 */

import { emptyDoc } from '../src/core/doc.js'
import { renderSentence } from '../src/core/render.js'
import type { Requirement, RequirementsDoc } from '../src/core/schema.js'
import type { AdversarialCase } from './generate.js'

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

  return cases
}
