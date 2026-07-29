/**
 * AC-2-7 end-to-end: the temporal and propositional tiers share ONE atomizer,
 * proven through the SHIPPED `runCheck` pipeline rather than at the unit seam.
 *
 * The unit tests in `formal/__tests__/temporal-patterns.test.ts` prove the
 * atomizer is shared. These prove the two things that make the AC worth doing —
 * and the one thing that could have made it dangerous.
 *
 * ## 1. The PAYOFF: `--temporal` now sees glossary/antonym commitments
 *
 * Before AC-2-7, `earsToTemporal(req)` took no glossary or antonym parameter at
 * all, so two responses in different words stayed two temporal atoms no matter
 * what the document committed — the blindness was structural, at the signature.
 * The tests below drive the full pipeline and show a conflict flipping from
 * invisible to PROVEN when, and only when, the `antonym` (or `glossary`) entry is
 * committed. The last of them is DECISIVE: the temporal tier fires where the
 * propositional tier does not, verified on the built CLI at both revisions (HEAD
 * 22e0a04 exits 0 with zero findings; AC-2-7 exits 1). If that does not work, the
 * AC is not done.
 *
 * ## 2. The HAZARD this AC's sequencing exists to avoid (V6 / AC-2-6)
 *
 * The stated reason AC-2-6 shipped first: unification was expected to make the V6
 * horizon bug exploitable, because V6/V17/V18 are latent only while `trig` and
 * `resp` atoms live in namespaces that never coincide. The bridge-shape tests
 * below are the regression guard for that decision, at five bounds.
 *
 * **Measured caveat, recorded rather than assumed.** Those tests are guards, not
 * demonstrations: driven against the pre-AC-2-6 encoding, the bridge shape is
 * `sat` BOTH ways, so it does not by itself prove the exploit was reachable.
 * `renderAtom` writes the kind between `__` separators and the propositional
 * punctuation class collapses every punctuation run, so a slot body can never
 * contain `__` and therefore never forge a kind marker — a `resp` atom cannot
 * equal a `pre`/`trig`/`feat` atom under ANY committed glossary or antonym.
 * Verified exhaustively in
 * `.erpaval/sessions/session-511b2b/probes/ac27-unification-payoff.mts` §3. The
 * eventuality-cycle shape V6 needs is thus unreachable through `earsToTemporal`
 * whether or not the atomizer is shared. AC-2-6-first was still the right call —
 * it was the safe ordering under the information available, and the V18 false
 * positive it fixed was real and reachable via `lowerAt`, a public export — but
 * the coupling was weaker than believed, so these tests earn their place as
 * cheap guards rather than as proof of a closed exploit.
 *
 * Note what makes a temporal false positive catchable here and not in the
 * adversarial suite: that suite asserts abstention rounds have zero
 * `FND_CONTRADICTION`, which a *temporal* false positive satisfies while being
 * wrong.
 *
 * ## 3. Divergence 8: both tiers score ONE requirement population
 *
 * The temporal tier used to read raw `reqs` while the propositional tier read the
 * post-gate `included` set, so the two error-severity tiers disagreed about which
 * document they were checking and `FND_EXCLUDED_FROM_FORMAL` was false about one
 * of them. Asserted directly below.
 */

import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../core/doc.js'
import { renderSentence } from '../../core/render.js'
import type { Requirement, RequirementsDoc } from '../../core/schema.js'
import type { Embedder } from '../../formal/embed.js'
import { runCheck } from '../check.js'

function req(partial: Partial<Requirement> & Pick<Requirement, 'id'>): Requirement {
  const base: Requirement = {
    id: partial.id,
    patternType: partial.patternType ?? 'event-driven',
    systemName: partial.systemName ?? 'gateway',
    systemResponse: partial.systemResponse ?? 'issue a session token',
    negated: partial.negated ?? false,
    sentence: '',
    priority: 'medium',
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
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

/** Deterministic stub embedder — the semantic tier is propose-only here. */
const stubEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const v = new Float32Array(8)
    let h = 2166136261
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    for (let d = 0; d < 8; d++) {
      h ^= h << 13
      h ^= h >>> 17
      h ^= h << 5
      v[d] = ((h >>> 0) % 2000) / 1000 - 1
    }
    let norm = 0
    for (let d = 0; d < 8; d++) norm += (v[d] as number) ** 2
    norm = Math.sqrt(norm) || 1
    for (let d = 0; d < 8; d++) v[d] = (v[d] as number) / norm
    return v
  })

const TEMPORAL = { temporal: {}, semantic: { embedder: stubEmbedder } }

const temporalFindings = (findings: readonly { code: string }[]) =>
  findings.filter((f) => f.code === 'FND_TEMPORAL_CONTRADICTION')

// ---------------------------------------------------------------------------
// 1. THE PAYOFF — `--temporal` sees a committed antonym / glossary link
// ---------------------------------------------------------------------------

describe('AC-2-7 payoff — --temporal becomes provable via a committed antonym', () => {
  /**
   * The shape that is actually refutable, and why it is this one rather than the
   * more obvious `G(t → F R)` vs `G(t → F ¬R)`.
   *
   * Two same-trigger response obligations at opposite polarity are jointly
   * SATISFIABLE — respond at one step, don't at another — which
   * `formal/__tests__/budget.test.ts` documents at length after AC-2-6 corrected
   * a fixture comment that claimed otherwise. Verified live here too: that pair
   * yields no finding, correctly.
   *
   * What IS refutable is response-versus-GLOBAL-absence: `G(t → F R)` against a
   * ubiquitous `G(¬R)`. With `t` asserted reachable, `R` must eventually hold from
   * that step, while `G(¬R)` forbids it at every step INCLUDING each pending's
   * tail — so the pending is forced false, the encoding collapses to the bounded
   * one, and it is `unsat`. This is the same shape `temporal.test.ts`'s recall
   * guard uses, which is what makes it a trustworthy target.
   *
   * `grant`/`revoke` is a SEED antonym pair, so this case proves the temporal tier
   * now consults the seed table AT ALL — which it structurally could not before,
   * because it never called the atomizer.
   */
  const grantVsRevoke = [
    req({
      id: 'REQ-GRANT',
      patternType: 'event-driven',
      trigger: 'the operator presents a valid badge',
      systemResponse: 'grant access',
    }),
    req({ id: 'REQ-REVOKE', patternType: 'ubiquitous', systemResponse: 'revoke access' }),
  ]

  it('proves the seed-antonym temporal conflict the tier previously could not reach', async () => {
    const report = await runCheck(docOf(grantVsRevoke), TEMPORAL)
    const temporal = temporalFindings(report.findings)
    expect(temporal.length).toBeGreaterThan(0)
    expect(temporal[0]?.severity).toBe('error')
    expect(new Set(temporal[0]?.requirementIds)).toEqual(new Set(['REQ-GRANT', 'REQ-REVOKE']))
  })

  it('leaves the jointly-SATISFIABLE same-trigger polarity pair alone', async () => {
    // The control that keeps the case above honest: `G(t → F R)` vs `G(t → F ¬R)`
    // must NOT fire, because it has a model. If unification had made the temporal
    // tier over-eager rather than better-informed, this is where it would show.
    const satisfiable = [
      req({
        id: 'REQ-A',
        patternType: 'event-driven',
        trigger: 'the operator presents a valid badge',
        systemResponse: 'grant access',
      }),
      req({
        id: 'REQ-B',
        patternType: 'event-driven',
        trigger: 'the operator presents a valid badge',
        systemResponse: 'revoke access',
      }),
    ]
    expect(temporalFindings((await runCheck(docOf(satisfiable), TEMPORAL)).findings)).toEqual([])
  })

  /**
   * The flagship: a pair the SEED table does NOT relate, so the conflict is
   * genuinely invisible until the document commits the link. This is the
   * propose/decide loop closing on the temporal tier for the first time — a
   * committed artifact, not a fuzzy score, is what makes the proof possible.
   */
  const grantVsWithhold = () => [
    req({
      id: 'REQ-A',
      patternType: 'event-driven',
      trigger: 'the operator presents a valid badge',
      systemResponse: 'grant access',
    }),
    req({ id: 'REQ-B', patternType: 'ubiquitous', systemResponse: 'withhold access' }),
  ]

  it('is SILENT on an un-committed opposite pair (the honest false negative)', async () => {
    // `withhold` is in no seed antonym class, so the two responses are two atoms
    // and no conflict is provable. Sound-modulo-atomization: a MISS, never a
    // fabricated verdict. This is the control that proves the next test's finding
    // comes from the committed pair and not from something else.
    const report = await runCheck(docOf(grantVsWithhold()), TEMPORAL)
    expect(temporalFindings(report.findings)).toEqual([])
  })

  it('PROVES the same conflict once `antonym add grant withhold` is committed', async () => {
    const doc = docOf(grantVsWithhold())
    doc.antonyms = [{ a: 'grant', b: 'withhold' }]
    const report = await runCheck(doc, TEMPORAL)
    const temporal = temporalFindings(report.findings)
    // THE AC-2-7 PAYOFF. Before unification this was unreachable at the signature
    // level: `earsToTemporal(req)` had no parameter through which a doc-committed
    // antonym pair could arrive.
    expect(temporal.length).toBeGreaterThan(0)
    expect(temporal[0]?.severity).toBe('error')
    expect(new Set(temporal[0]?.requirementIds)).toEqual(new Set(['REQ-A', 'REQ-B']))
  })

  it('PROVES a paraphrased temporal conflict once a `glossary` alias is committed', async () => {
    // The synonym half of the same payoff: two DIFFERENTLY-WORDED responses, one
    // of them negated, become one atom at opposite polarity via the committed
    // glossary — so the temporal tier can refute them. Also un-reachable before
    // AC-2-7 (no glossary parameter).
    const paraphrased = () => [
      req({
        id: 'REQ-ISSUE',
        patternType: 'event-driven',
        trigger: 'the user submits valid credentials',
        systemResponse: 'issue a session token',
      }),
      req({
        id: 'REQ-DENY',
        patternType: 'ubiquitous',
        systemResponse: 'issue a login credential',
        negated: true,
      }),
    ]
    const before = await runCheck(docOf(paraphrased()), TEMPORAL)
    expect(temporalFindings(before.findings)).toEqual([])

    const doc = docOf(paraphrased())
    doc.glossary = [{ canonical: 'issue a session token', aliases: ['issue a login credential'] }]
    const after = await runCheck(doc, TEMPORAL)
    const temporal = temporalFindings(after.findings)
    expect(temporal.length).toBeGreaterThan(0)
    expect(new Set(temporal[0]?.requirementIds)).toEqual(new Set(['REQ-ISSUE', 'REQ-DENY']))
  })

  it('is DECISIVE — a conflict only the temporal tier can reach, changing the exit code', async () => {
    // The strongest form of the payoff, and the one worth pinning: on most shapes
    // the propositional tier catches the same conflict, so unification improves
    // the temporal tier without changing the verdict. This shape is different —
    // the temporal tier fires ALONE.
    //
    // `G(badge_fails → ¬grant)` (unwanted-behavior) against a ubiquitous
    // `G(grant)` reached through a committed glossary alias. Propositionally these
    // do NOT conflict: `badge_fails ⇒ ¬R` and `R` are jointly satisfiable in one
    // snapshot by keeping `badge_fails` false, and the trigger's context group
    // does not force it. Temporally the `F(antecedent)` reachability premise
    // asserts `badge_fails` at SOME step in [0, k], and at that step `G(grant)`
    // demands `R` while the prohibition demands `¬R` — `unsat`.
    //
    // Verified on the BUILT CLI at both revisions: HEAD 22e0a04 reports 0 temporal
    // and 0 propositional findings and exits 0; with AC-2-7 the same document
    // exits 1 with the temporal contradiction. So unification does not merely
    // duplicate propositional coverage — it closes a real hole.
    const decisive = () => [
      req({
        id: 'REQ-FAIL',
        patternType: 'unwanted-behavior',
        trigger: 'the badge check fails',
        systemResponse: 'grant access',
      }),
      req({ id: 'REQ-ALWAYS', patternType: 'ubiquitous', systemResponse: 'authorize the entry' }),
    ]
    const before = await runCheck(docOf(decisive()), TEMPORAL)
    expect(temporalFindings(before.findings)).toEqual([])

    const doc = docOf(decisive())
    doc.glossary = [{ canonical: 'grant access', aliases: ['authorize the entry'] }]
    const after = await runCheck(doc, TEMPORAL)
    const temporal = temporalFindings(after.findings)
    expect(temporal.length).toBeGreaterThan(0)
    expect(new Set(temporal[0]?.requirementIds)).toEqual(new Set(['REQ-FAIL', 'REQ-ALWAYS']))
    // The decisive part: NO propositional contradiction fires, so this finding is
    // the only thing standing between the document and a clean exit 0.
    expect(after.findings.filter((f) => f.code === 'FND_CONTRADICTION')).toEqual([])
    expect(after.counts.error).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 2. THE HAZARD — a shared namespace must NOT manufacture a temporal conflict
// ---------------------------------------------------------------------------

describe('AC-2-7 × AC-2-6 — sharing the namespace must not fabricate a contradiction', () => {
  /**
   * The exact shape the sequencing decision was made for.
   *
   * `REQ-BRIDGE` is `event-driven`: `G(badge_presented → F session_active)`. Its
   * RESPONSE normalizes to `session_active`, and `REQ-GUARDED` is `state-driven`
   * on the PRECONDITION `the session is active` — which, after the shared copula
   * strip, normalizes to the same body `session_active`. The two atoms differ only
   * by their kind marker (`resp` vs `pre`), which is the closest the unified
   * namespace comes to the bridge shape, and it is the shape that makes `F` reach
   * a `G` antecedent.
   *
   * Under the PRE-AC-2-6 lowering, `F φ` instantiated at `t = k` collapsed to
   * `φ@k` — which `G` does at every step — so a `G(a → F b)` whose `b` is forced
   * false at the horizon by any co-reachable requirement came back `unsat`: an
   * error-severity FALSE POSITIVE, exit 1, on a spec whose real LTL semantics are
   * satisfiable (`b` simply happens after the horizon). AC-2-6's pending/tail
   * repair is what makes this set `sat`.
   *
   * This spec IS satisfiable: present the badge, activate the session a step
   * later, and nothing forbids either. So a finding here is a fabricated verdict.
   */
  const bridgeShape = [
    req({
      id: 'REQ-BRIDGE',
      patternType: 'event-driven',
      trigger: 'the operator presents a valid badge',
      systemResponse: 'session is active',
    }),
    req({
      id: 'REQ-GUARDED',
      patternType: 'state-driven',
      preCondition: 'the session is active',
      systemResponse: 'log the access',
    }),
    req({
      id: 'REQ-CYCLE',
      patternType: 'event-driven',
      trigger: 'the session is active',
      systemResponse: 'refresh the audit timer',
    }),
  ]

  it.each([
    2, 4, 8, 10,
  ])('does NOT report FND_TEMPORAL_CONTRADICTION on the G(a→F b) + bridge shape (k=%i)', async (bound) => {
    const report = await runCheck(docOf(bridgeShape), {
      temporal: { bound },
      semantic: { embedder: stubEmbedder },
    })
    expect(temporalFindings(report.findings)).toEqual([])
  })

  it('does not report one at the DEFAULT bound either (the shipped code path)', async () => {
    const report = await runCheck(docOf(bridgeShape), TEMPORAL)
    expect(temporalFindings(report.findings)).toEqual([])
  })

  it('still proves a REAL conflict on the same shared namespace (recall guard)', async () => {
    // The mirror of the above: unification must not be paid for by silence. Here
    // the bridge's established state is FORBIDDEN by a co-triggered
    // unwanted-behavior rule on the same normalized body, so `F session_active`
    // and `G(badge → ¬session_active)` genuinely cannot both hold with the badge
    // reachable — and the tier must say so. Without this assertion, the
    // no-false-positive tests above could be satisfied by a tier that proves
    // nothing at all.
    const real = [
      req({
        id: 'REQ-OPEN',
        patternType: 'event-driven',
        trigger: 'the operator presents a valid badge',
        systemResponse: 'session is active',
      }),
      req({
        id: 'REQ-FORBID',
        patternType: 'ubiquitous',
        systemResponse: 'session is active',
        negated: true,
      }),
    ]
    const report = await runCheck(docOf(real), TEMPORAL)
    const temporal = temporalFindings(report.findings)
    expect(temporal.length).toBeGreaterThan(0)
    expect(new Set(temporal[0]?.requirementIds)).toEqual(new Set(['REQ-OPEN', 'REQ-FORBID']))
  })
})

// ---------------------------------------------------------------------------
// 3. DIVERGENCE 8 — one requirement population across both tiers
// ---------------------------------------------------------------------------

describe('AC-2-7 divergence 8 — the temporal tier scores the GATE-INCLUDED set', () => {
  /**
   * `REQ-GRANT`'s trigger contains "as appropriate", which trips `GTWR_R7_VAGUE`
   * at ERROR severity, so the AC-3-7 gate excludes it from symbolization. Its
   * RESPONSE ("grant access") is untouched by that finding, and would otherwise
   * unify with `REQ-DENY`'s ubiquitous absence into exactly the provable conflict
   * the payoff block above demonstrates.
   *
   * That separation is what makes this a clean test of the POPULATION choice
   * rather than of atomization: the conflict is fully atomizable, and the only
   * reason it goes unreported is that the gate excluded one participant. It also
   * mirrors the real motivation — a requirement whose guard the lint tier just
   * called vague has no trustworthy TRIGGER, and the temporal tier's whole shape
   * is `G(trigger → …)`.
   */
  const withExcluded = () => [
    req({
      id: 'REQ-GRANT',
      patternType: 'event-driven',
      trigger: 'the operator presents a valid badge as appropriate',
      systemResponse: 'grant access',
    }),
    req({ id: 'REQ-DENY', patternType: 'ubiquitous', systemResponse: 'revoke access' }),
  ]

  it('excludes a gate-excluded requirement from the temporal tier too', async () => {
    const report = await runCheck(docOf(withExcluded()), TEMPORAL)
    expect(report.excluded.map((e) => e.id)).toContain('REQ-GRANT')
    // The disclosure and the demotion both fire, so the coverage hole stays loud…
    expect(report.findings.some((f) => f.code === 'FND_EXCLUDED_FROM_FORMAL')).toBe(true)
    expect(report.coverage.demotions.some((d) => d.reason === 'excluded-from-formal')).toBe(true)
    expect(report.verified).toBe(false)
    // …and no temporal finding fires over it. Pre-AC-2-7 this exact document
    // reported an error-severity FND_TEMPORAL_CONTRADICTION naming REQ-GRANT while
    // simultaneously reporting FND_EXCLUDED_FROM_FORMAL ("the solver never saw
    // this requirement") about it. Both cannot be true.
    expect(temporalFindings(report.findings)).toEqual([])
  })

  it('re-admits it to the temporal tier when the blocking finding is WAIVED', async () => {
    // The discharge path, and the proof that exclusion is not a silent dead end:
    // waiving the blocking lint finding re-admits the requirement to BOTH tiers at
    // once (the gate is waiver-aware), and the conflict then becomes provable.
    // This is what makes the population choice reviewable rather than lossy — an
    // author can always buy the coverage back with a reasoned waiver.
    const doc = docOf(withExcluded())
    doc.waivers = [
      {
        code: 'GTWR_R7_VAGUE',
        requirementId: 'REQ-GRANT',
        reason: 'reviewed: the badge check is exact',
      },
    ]
    const report = await runCheck(doc, TEMPORAL)
    expect(report.excluded.map((e) => e.id)).not.toContain('REQ-GRANT')
    const temporal = temporalFindings(report.findings)
    expect(temporal.length).toBeGreaterThan(0)
    expect(new Set(temporal[0]?.requirementIds)).toEqual(new Set(['REQ-GRANT', 'REQ-DENY']))
  })
})

// ---------------------------------------------------------------------------
// 4. DETERMINISM through the pipeline
// ---------------------------------------------------------------------------

describe('AC-2-7 determinism — same document, same verdict and same evidence text', () => {
  it('two runs of the unified path agree on findings, ids, and message bytes', async () => {
    // The repo's determinism contract, asserted at the level that matters: not
    // just the atom names but the rendered EVIDENCE a reviewer reads. The
    // pending/tail symbols the temporal lowering mints are content-addressed, and
    // the atomizer is pure, so a second run must be byte-identical.
    const doc = docOf([
      req({
        id: 'REQ-1',
        patternType: 'event-driven',
        trigger: 'the operator presents a valid badge',
        systemResponse: 'grant access',
      }),
      req({ id: 'REQ-2', patternType: 'ubiquitous', systemResponse: 'revoke access' }),
    ])
    // A document that DOES produce a temporal finding, so the assertion below
    // compares real evidence bytes rather than two empty arrays.
    const a = await runCheck(doc, TEMPORAL)
    const b = await runCheck(doc, TEMPORAL)
    expect(temporalFindings(a.findings).length).toBeGreaterThan(0)
    expect(JSON.stringify(b.findings)).toBe(JSON.stringify(a.findings))
    expect(b.verified).toBe(a.verified)
    expect(JSON.stringify(b.coverage.demotions)).toBe(JSON.stringify(a.coverage.demotions))
  })
})
