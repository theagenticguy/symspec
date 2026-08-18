/**
 * The terminology tier's gates.
 *
 * Every cosine here comes from a hand-authored 2-D vector table, never from
 * `SYMSPEC_EMBED_STUB=1`. The stub's cosines are deliberately meaningless, so a
 * "found drift" assertion under it proves nothing — the honest use of the stub is
 * liveness. A 2-D table makes each cosine exactly computable, which is the only way a
 * FLOOR gets tested at all: one fixture must sit just below it and one just above.
 */

import { describe, expect, it } from 'vitest'
import type { Embedder } from '../engine/formal/embed.ts'
import { COMMON_ACRONYMS } from '../engine/lint/gtwr.ts'
import { DOC_VERSION, type RequirementsDocument } from '../requirements/document.ts'
import { DEFAULT_TERM_COHERENCE_FLOOR, runTerminology } from './terminology.ts'
import { TERMINOLOGY_FND_CODES, TerminologyFndCodeMeta } from './terminology-codes.ts'

const TS = '2026-01-01T00:00:00.000Z'

/**
 * A unit vector at `deg` degrees, so `cosine(a, b) === cos(a - b)` exactly.
 *
 * Angles rather than raw components because the assertions are about a THRESHOLD: an
 * angular separation names the cosine it produces directly, so a fixture can be placed a
 * chosen distance below the floor and the reader can check the arithmetic.
 */
const at = (deg: number): Float32Array => {
  const r = (deg * Math.PI) / 180
  return Float32Array.from([Math.cos(r), Math.sin(r)])
}

/** An unlisted text throws rather than defaulting — a silent default hides a typo. */
const angleEmbedder = (
  table: Readonly<Record<string, number>>,
): Embedder & { calls: string[][] } => {
  const calls: string[][] = []
  const fn = async (texts: readonly string[]) => {
    calls.push([...texts])
    return texts.map((t) => {
      const deg = table[t]
      if (deg === undefined) throw new Error(`no vector for slot text: ${JSON.stringify(t)}`)
      return at(deg)
    })
  }
  return Object.assign(fn, { calls })
}

let seq = 0
const req = (
  systemName: string,
  fields: {
    readonly trigger?: string
    readonly preCondition?: string
    readonly systemResponse: string
    readonly sentence?: string
  },
) => {
  seq += 1
  const id = `aaaaaaaa-0000-4000-8000-${String(seq).padStart(12, '0')}`
  const lead =
    fields.trigger !== undefined
      ? `When ${fields.trigger}, `
      : fields.preCondition !== undefined
        ? `While ${fields.preCondition}, `
        : ''
  return [
    id,
    {
      id,
      patternType: fields.trigger !== undefined ? 'event-driven' : 'state-driven',
      systemName,
      systemResponse: fields.systemResponse,
      ...(fields.trigger !== undefined ? { trigger: fields.trigger } : {}),
      ...(fields.preCondition !== undefined ? { preCondition: fields.preCondition } : {}),
      negated: false,
      sentence: fields.sentence ?? `${lead}the ${systemName} shall ${fields.systemResponse}.`,
      priority: 'medium' as const,
      status: 'draft' as const,
      createdAt: TS,
      updatedAt: TS,
      derives: [],
      satisfies: [],
      verifies: [],
      refines: [],
    },
  ] as const
}

const docOf = (
  rows: readonly (readonly [string, unknown])[],
  extra: {
    terms?: readonly { canonical: string; aliases: readonly string[] }[]
    glossary?: readonly { canonical: string; aliases: readonly string[] }[]
  } = {},
): RequirementsDocument =>
  ({
    docVersion: DOC_VERSION,
    requirements: Object.fromEntries(rows),
    glossary: extra.glossary ?? [],
    antonyms: [],
    waivers: [],
    terms: extra.terms ?? [],
    stateModel: { variables: [] },
  }) as unknown as RequirementsDocument

/**
 * The headline fixture: one committed term, two requirements, one system.
 *
 * `token` is the classic drift case — an auth credential in one requirement and a
 * board-game piece in the other. The slot texts are what the tier embeds, so the table is
 * keyed on the JOINED slots rather than on the rendered sentence, which is itself the
 * assertion that the slot framing is the one in use.
 */
const AUTH_SLOTS = 'the token expires revoke the active session'
const GAME_SLOTS = 'the player places the token on the board advance the turn'
const REFRESH_SLOTS = 'the token is refreshed extend the session lifetime'

const driftDoc = (extra?: Parameters<typeof docOf>[1]) =>
  docOf(
    [
      req('auth service', {
        trigger: 'the token expires',
        systemResponse: 'revoke the active session',
      }),
      req('auth service', {
        trigger: 'the player places the token on the board',
        systemResponse: 'advance the turn',
      }),
    ],
    extra ?? { terms: [{ canonical: 'token', aliases: [] }] },
  )

describe('the code corpus', () => {
  it('is append-only and parses into the catalog', () => {
    expect(TERMINOLOGY_FND_CODES).toEqual(['FND_TERM_INCONSISTENT', 'FND_ACRONYM_UNDEFINED'])
    for (const code of TERMINOLOGY_FND_CODES) {
      const description = TerminologyFndCodeMeta[code].description
      // The em dash is load-bearing: `FND_SEVERITY_PREFIX` in `catalog.ts` matches U+2014
      // and a hyphen matches nothing, which would publish `severity: null` for a code that
      // genuinely has one.
      expect(description.startsWith('info — '), `${code} lost its severity prefix`).toBe(true)
      expect(description, `${code} has no remedy clause`).toContain('Suggestion:')
    }
  })

  it('never claims to move a verdict', () => {
    // Both descriptions promise the finding gates nothing. That promise is kept by the
    // absence of a demotion, asserted below — this pins the PROSE so the two cannot drift.
    expect(TerminologyFndCodeMeta.FND_TERM_INCONSISTENT.description).toContain(
      'pushes no coverage demotion',
    )
  })
})

describe('FND_TERM_INCONSISTENT', () => {
  it('reports one committed term applied in two unrelated contexts', async () => {
    // 55° apart -> cosine 0.5736, clear of the 0.62 floor.
    const embedder = angleEmbedder({ [AUTH_SLOTS]: 0, [GAME_SLOTS]: 55 })
    const report = await runTerminology(driftDoc(), embedder)

    const drift = report.findings.filter((f) => f.code === 'FND_TERM_INCONSISTENT')
    expect(drift).toHaveLength(1)
    expect(drift[0]?.severity).toBe('info')
    expect(drift[0]?.requirementIds).toHaveLength(2)
    // The AUTHOR's phrase, never a normalized body.
    expect(drift[0]?.message).toContain('"token"')
    expect(drift[0]?.message).not.toContain('sys__')
    // The consequence, stated in the masking direction.
    expect(drift[0]?.message).toContain('can no longer be proven')
    // Leaving it must be offered as correct, or the finding reads as a defect report.
    expect(drift[0]?.suggestion).toContain('leave it')
    expect(drift[0]?.suggestion).toContain('symspec term "<canonical>" "token" --remove')
  })

  it('stays silent when the same term is used coherently', async () => {
    const doc = docOf(
      [
        req('auth service', {
          trigger: 'the token expires',
          systemResponse: 'revoke the active session',
        }),
        req('auth service', {
          trigger: 'the token is refreshed',
          systemResponse: 'extend the session lifetime',
        }),
      ],
      { terms: [{ canonical: 'token', aliases: [] }] },
    )
    // 30° apart -> cosine 0.8660, comfortably above the floor.
    const embedder = angleEmbedder({ [AUTH_SLOTS]: 0, [REFRESH_SLOTS]: 30 })
    const report = await runTerminology(doc, embedder)

    expect(report.findings.filter((f) => f.code === 'FND_TERM_INCONSISTENT')).toEqual([])
    // But the tier DID look — which is the distinction the counters exist to make.
    expect(report.keysExamined).toBe(1)
    expect(report.pairsCompared).toBe(1)
  })

  it('is decided by the floor, on both sides of it', async () => {
    // The floor is 0.62. cos(51°) = 0.6293 (above, silent); cos(52°) = 0.6157 (below, fires).
    // One degree of separation, so the assertion is about the CUT and not about a wide gap.
    const above = await runTerminology(
      driftDoc(),
      angleEmbedder({ [AUTH_SLOTS]: 0, [GAME_SLOTS]: 51 }),
    )
    const below = await runTerminology(
      driftDoc(),
      angleEmbedder({ [AUTH_SLOTS]: 0, [GAME_SLOTS]: 52 }),
    )
    expect(Math.cos((51 * Math.PI) / 180)).toBeGreaterThan(DEFAULT_TERM_COHERENCE_FLOOR)
    expect(Math.cos((52 * Math.PI) / 180)).toBeLessThan(DEFAULT_TERM_COHERENCE_FLOOR)
    expect(above.findings.filter((f) => f.code === 'FND_TERM_INCONSISTENT')).toEqual([])
    expect(below.findings.filter((f) => f.code === 'FND_TERM_INCONSISTENT')).toHaveLength(1)
  })

  it('honors an explicit floor without touching the default', async () => {
    const embedder = angleEmbedder({ [AUTH_SLOTS]: 0, [GAME_SLOTS]: 30 })
    // cos(30°) = 0.8660: silent at the default, reported at a floor of 0.9.
    expect((await runTerminology(driftDoc(), embedder)).findings).toEqual([])
    const strict = await runTerminology(driftDoc(), embedder, { floor: 0.9 })
    expect(strict.findings.filter((f) => f.code === 'FND_TERM_INCONSISTENT')).toHaveLength(1)
    expect(DEFAULT_TERM_COHERENCE_FLOOR).toBe(0.62)
  })

  it('finds a glossary entry as readily as a terms entry, with the matching remedy', async () => {
    const doc = driftDoc({ glossary: [{ canonical: 'token', aliases: [] }] })
    const embedder = angleEmbedder({ [AUTH_SLOTS]: 0, [GAME_SLOTS]: 55 })
    const drift = (await runTerminology(doc, embedder)).findings.filter(
      (f) => f.code === 'FND_TERM_INCONSISTENT',
    )
    expect(drift).toHaveLength(1)
    expect(drift[0]?.message).toContain('glossary entry')
    // The remedy must name the table that actually owns the entry.
    expect(drift[0]?.suggestion).toContain('symspec glossary "<canonical>" "token" --remove')
    // `unterm` / `unglossary` are op-stream verbs, not CLI commands — asserted absent because
    // `repair.test.ts` caught this prose naming an invocation the program does not accept.
    expect(drift[0]?.suggestion).not.toContain('symspec unterm')
    expect(drift[0]?.suggestion).not.toContain('symspec unglossary')
  })

  it('matches a multi-token term only as a contiguous run', async () => {
    // "session token" is committed. R1 has both words ADJACENT; R2 has both words present
    // but separated, so it is NOT a site — otherwise a bag-of-words match would make every
    // multi-word term fire across the whole document.
    const doc = docOf(
      [
        req('auth service', {
          trigger: 'the session token expires',
          systemResponse: 'revoke the active session',
        }),
        req('auth service', {
          trigger: 'the session ends without a token',
          systemResponse: 'advance the turn',
        }),
      ],
      { terms: [{ canonical: 'session token', aliases: [] }] },
    )
    const report = await runTerminology(doc, angleEmbedder({}))
    // Only one site, so no pair, so no embedder call at all.
    expect(report.keysExamined).toBe(0)
    expect(report.pairsCompared).toBe(0)
    expect(report.findings.filter((f) => f.code === 'FND_TERM_INCONSISTENT')).toEqual([])
  })

  it('never compares across systems', async () => {
    const doc = docOf(
      [
        req('auth service', {
          trigger: 'the token expires',
          systemResponse: 'revoke the active session',
        }),
        req('game engine', {
          trigger: 'the player places the token on the board',
          systemResponse: 'advance the turn',
        }),
      ],
      { terms: [{ canonical: 'token', aliases: [] }] },
    )
    const report = await runTerminology(doc, angleEmbedder({ [AUTH_SLOTS]: 0, [GAME_SLOTS]: 55 }))
    // Two systems may legitimately use one word two ways; their atoms never collide,
    // because the scope is in the atom name.
    expect(report.keysExamined).toBe(0)
    expect(report.findings.filter((f) => f.code === 'FND_TERM_INCONSISTENT')).toEqual([])
  })

  it('reports nothing and examines nothing when the tables are empty', async () => {
    const doc = driftDoc({})
    const report = await runTerminology(doc, angleEmbedder({}))
    expect(report.findings).toEqual([])
    // The load-bearing half: zero keys EXAMINED, not merely zero findings. A reader must be
    // able to tell "no drift" from "there was nothing to look at".
    expect(report.keysExamined).toBe(0)
    expect(report.pairsCompared).toBe(0)
  })

  it('embeds each slot text once, in one sorted batch', async () => {
    // Two committed keys both landing on the same two requirements. A per-key embedder call
    // would cost two round trips and make the batch a function of iteration order.
    const doc = driftDoc({
      terms: [
        { canonical: 'token', aliases: [] },
        { canonical: 'the', aliases: [] },
      ],
    })
    const embedder = angleEmbedder({ [AUTH_SLOTS]: 0, [GAME_SLOTS]: 55 })
    await runTerminology(doc, embedder)
    expect(embedder.calls).toHaveLength(1)
    expect(embedder.calls[0]).toEqual([...(embedder.calls[0] as string[])].sort())
    expect(new Set(embedder.calls[0]).size).toBe(embedder.calls[0]?.length)
  })

  it('is byte-identical across two runs', async () => {
    // ONE document, run twice. `req()` mints a fresh uuid per call, so calling the fixture
    // builder twice would compare two different documents and fail for a reason that has
    // nothing to do with determinism.
    const doc = driftDoc()
    const build = () => angleEmbedder({ [AUTH_SLOTS]: 0, [GAME_SLOTS]: 55 })
    const a = await runTerminology(doc, build())
    const b = await runTerminology(doc, build())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('FND_ACRONYM_UNDEFINED', () => {
  const acronymDoc = (extra?: Parameters<typeof docOf>[1]) =>
    docOf(
      [
        req('billing service', {
          trigger: 'the SLA window closes',
          systemResponse: 'publish the report',
          sentence: 'When the SLA window closes, the billing service shall publish the report.',
        }),
      ],
      extra ?? {},
    )

  it('names an acronym in neither table, with the command that defines it', async () => {
    const report = await runTerminology(acronymDoc(), angleEmbedder({}))
    const found = report.findings.filter((f) => f.code === 'FND_ACRONYM_UNDEFINED')
    expect(found).toHaveLength(1)
    expect(found[0]?.severity).toBe('info')
    expect(found[0]?.message).toContain('"SLA"')
    expect(found[0]?.suggestion).toContain('symspec glossary')
    expect(found[0]?.suggestion).toContain('"SLA"')
    expect(report.acronymsExamined).toBe(1)
  })

  it('is SILENCED by a glossary entry — which is what R37 can never be', async () => {
    const defined = acronymDoc({
      glossary: [{ canonical: 'service level agreement', aliases: ['SLA'] }],
    })
    const report = await runTerminology(defined, angleEmbedder({}))
    expect(report.findings.filter((f) => f.code === 'FND_ACRONYM_UNDEFINED')).toEqual([])
    // Still EXAMINED, so silence is attributable.
    expect(report.acronymsExamined).toBe(1)
  })

  it('is silenced by a terms entry too', async () => {
    const defined = acronymDoc({
      terms: [{ canonical: 'service level agreement', aliases: ['SLA'] }],
    })
    expect(
      (await runTerminology(defined, angleEmbedder({}))).findings.filter(
        (f) => f.code === 'FND_ACRONYM_UNDEFINED',
      ),
    ).toEqual([])
  })

  it('shares R37 own allowlist rather than keeping a second copy', async () => {
    const doc = docOf([
      req('billing service', {
        trigger: 'the JSON payload is rejected',
        systemResponse: 'return an error',
        sentence: 'When the JSON payload is rejected, the billing service shall return an error.',
      }),
    ])
    // `JSON` is in the shared set, so neither tier asks for a definition. Two independent
    // allowlists would let this tier demand one that R37 never mentioned.
    expect(COMMON_ACRONYMS.has('JSON')).toBe(true)
    const report = await runTerminology(doc, angleEmbedder({}))
    expect(report.findings).toEqual([])
    expect(report.acronymsExamined).toBe(0)
  })

  it('groups every use of one acronym into a single finding', async () => {
    const doc = docOf([
      req('billing service', {
        trigger: 'the SLA window closes',
        systemResponse: 'publish the report',
        sentence: 'When the SLA window closes, the billing service shall publish the report.',
      }),
      req('billing service', {
        trigger: 'the SLA is breached',
        systemResponse: 'credit the account',
        sentence: 'When the SLA is breached, the billing service shall credit the account.',
      }),
    ])
    const found = (await runTerminology(doc, angleEmbedder({}))).findings.filter(
      (f) => f.code === 'FND_ACRONYM_UNDEFINED',
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.requirementIds).toHaveLength(2)
  })
})

describe('the tier can never move a verdict', () => {
  it('produces only info-severity findings and no demotion field at all', async () => {
    const doc = docOf(
      [
        req('auth service', {
          trigger: 'the SLA token expires',
          systemResponse: 'revoke the active session',
          sentence: 'When the SLA token expires, the auth service shall revoke the active session.',
        }),
        req('auth service', {
          trigger: 'the player places the token on the board',
          systemResponse: 'advance the turn',
          sentence:
            'When the player places the token on the board, the auth service shall advance the turn.',
        }),
      ],
      { terms: [{ canonical: 'token', aliases: [] }] },
    )
    const report = await runTerminology(
      doc,
      angleEmbedder({ 'the SLA token expires revoke the active session': 0, [GAME_SLOTS]: 55 }),
    )
    // Both codes fire on this document, so the claim covers the whole tier.
    expect(new Set(report.findings.map((f) => f.code))).toEqual(
      new Set(['FND_TERM_INCONSISTENT', 'FND_ACRONYM_UNDEFINED']),
    )
    for (const f of report.findings) expect(f.severity).toBe('info')
    // The report SHAPE carries no demotion channel — a future one would need a type change,
    // not a quiet push, which is what keeps `data.verified` out of reach.
    expect(Object.keys(report).sort()).toEqual([
      'acronymsExamined',
      'findings',
      'keysExamined',
      'pairsCompared',
    ])
  })
})
