/**
 * `add` command-core tests (AC-2-10).
 *
 * Verification clauses from the spec/tasks row:
 *   1. `add` with slots and no `--id` → a fresh UUID in `data.id`.
 *   2. `add --id <dup>` → `ERR_DUPLICATE_ID` (envelope, not a throw).
 *   3. `add --from-parse "the API shall reject expired tokens"` → parses then
 *      creates.
 *
 * Plus the boundary rules AC-2-10 pins: auto-mint cannot collide; `--from-parse`
 * with a Tier-3 failure surfaces the `ERR_PARSE_*` envelope with `partial`; a
 * no-modal line surfaces `ERR_PARSE_NO_MODAL`; slots+prose (or neither) is
 * `ERR_USAGE`; every path validates against the envelope Zod schemas and never
 * mutates the input document.
 */

import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../core/doc.js'
import { CreateRequirementAttrsSchema, type RequirementsDoc } from '../../core/schema.js'
import type { WinkAnalyzer, WinkToken } from '../../parse/tier2.js'
import { ADD_USAGE, type AddArgs, type AddSlots, runAdd } from '../add.js'
import { runApply } from '../apply.js'
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from '../envelope.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_A = '11111111-1111-4111-8111-111111111111'

/** A minimal event-driven slot set that satisfies CreateRequirementAttrsSchema. */
const eventSlots = (): AddSlots => ({
  patternType: 'event-driven',
  systemName: 'auth service',
  systemResponse: 'issue a session token',
  trigger: 'the user submits valid credentials',
})

/** Fake analyzer with no modal, so Tier 2 always misses (never loads wink-nlp). */
const makeNoModalAnalyzer = (): WinkAnalyzer => (text: string) =>
  text.split(/\s+/).map(
    (value): WinkToken => ({
      value,
      pos: 'NN',
      lemma: value.toLowerCase(),
      negationFlag: false,
    }),
  )

/** Options that inject the fake analyzer so no wink-nlp model is required. */
const noModalOpts = () => ({ load: async () => makeNoModalAnalyzer() })

/**
 * A UPOS analyzer that tags a small verb set as VERB and coordinators as CCONJ,
 * so the compound splitter's soundness guard fires — no wink-nlp model needed.
 */
const SPLIT_VERBS = new Set(['validate', 'issue', 'provide', 'read', 'write', 'log'])
const makeSplitAnalyzer = (): WinkAnalyzer => (text: string) =>
  text.split(/\s+/).map((value): WinkToken => {
    const w = value.toLowerCase().replace(/,$/, '')
    const pos =
      w === 'and' || w === 'or'
        ? 'CCONJ'
        : w === 'shall'
          ? 'AUX'
          : w === 'the' || w === 'a'
            ? 'DET'
            : SPLIT_VERBS.has(w)
              ? 'VERB'
              : 'NOUN'
    return { value, pos, lemma: w, negationFlag: false }
  })

const splitOpts = () => ({ load: async () => makeSplitAnalyzer() })

function docWithA(): RequirementsDoc {
  const doc = emptyDoc()
  doc.requirements[ID_A] = {
    id: ID_A,
    patternType: 'event-driven',
    trigger: 'a request arrives',
    systemName: 'api',
    systemResponse: 'respond within 100ms',
    sentence: 'When a request arrives, the api shall respond within 100ms.',
    priority: 'medium',
    status: 'draft',
    derives: [],
    satisfies: [],
    verifies: [],
    refines: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  return doc
}

// ---------------------------------------------------------------------------
// 1. add with slots and no --id → fresh UUID in data.id
// ---------------------------------------------------------------------------

describe('AC-2-10: add with slots and no --id mints a fresh UUID', () => {
  it('returns a fresh UUID in data.id and the materialized requirement', async () => {
    const res = await runAdd(emptyDoc(), { slots: eventSlots() })
    expect('next' in res).toBe(true)
    if (!('next' in res)) return
    expect(res.envelope.type).toBe('add')
    if (res.envelope.type === 'error') return
    const { id, requirement } = res.envelope.data
    expect(id).toMatch(UUID_RE)
    expect(requirement.id).toBe(id)
    // Sentence rendered from slots; defaults filled by the runtime.
    expect(requirement.sentence).toBe(
      'When the user submits valid credentials, the auth service shall issue a session token.',
    )
    expect(requirement.priority).toBe('medium')
    expect(requirement.status).toBe('draft')
    // Persisted under the minted id.
    expect(res.next.requirements[id]).toEqual(requirement)
    expect(() => SuccessEnvelopeSchema.parse(res.envelope)).not.toThrow()
  })

  it('mints a distinct UUID on each call (auto-mint cannot collide)', async () => {
    const a = await runAdd(emptyDoc(), { slots: eventSlots() })
    const b = await runAdd(emptyDoc(), { slots: eventSlots() })
    if (a.envelope.type === 'error' || b.envelope.type === 'error') throw new Error('unexpected')
    expect(a.envelope.data.id).not.toBe(b.envelope.data.id)
  })

  it('does not mutate the input document', async () => {
    const doc = emptyDoc()
    await runAdd(doc, { slots: eventSlots() })
    expect(Object.keys(doc.requirements)).toHaveLength(0)
  })

  it('honors an explicit --id when it is free', async () => {
    const res = await runAdd(emptyDoc(), { id: ID_A, slots: eventSlots() })
    if (res.envelope.type === 'error') throw new Error('unexpected error')
    expect(res.envelope.data.id).toBe(ID_A)
    expect('parse' in res.envelope.data).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. add --id <dup> → ERR_DUPLICATE_ID
// ---------------------------------------------------------------------------

describe('AC-2-10 / AC-1-8: add --id <dup> → ERR_DUPLICATE_ID', () => {
  it('surfaces ERR_DUPLICATE_ID as an envelope, not a throw, and persists nothing', async () => {
    const doc = docWithA()
    const res = await runAdd(doc, { id: ID_A, slots: eventSlots() })
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type !== 'error') return
    expect(res.envelope.code).toBe('ERR_DUPLICATE_ID')
    expect(res.envelope.suggestions.length).toBeGreaterThan(0)
    expect(() => ErrorEnvelopeSchema.parse(res.envelope)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 3. add --from-parse → parses then creates
// ---------------------------------------------------------------------------

describe('AC-2-10: add --from-parse parses prose then creates', () => {
  it('parses "the API shall reject expired tokens" and creates a ubiquitous requirement', async () => {
    const res = await runAdd(
      emptyDoc(),
      { fromParse: 'the API shall reject expired tokens' },
      noModalOpts(),
    )
    expect('next' in res).toBe(true)
    if (!('next' in res)) return
    if (res.envelope.type === 'error') throw new Error(`unexpected error: ${res.envelope.code}`)
    const { id, requirement, parse } = res.envelope.data
    expect(id).toMatch(UUID_RE)
    expect(requirement.patternType).toBe('ubiquitous')
    expect(requirement.systemName).toBe('API')
    expect(requirement.systemResponse).toBe('reject expired tokens')
    // Parse provenance echoed back on the --from-parse path.
    expect(parse).toBeDefined()
    expect(parse?.tier).toBe(1)
    expect(parse?.negated).toBe(false)
    expect(() => SuccessEnvelopeSchema.parse(res.envelope)).not.toThrow()
  })

  it('honors --id together with --from-parse', async () => {
    const res = await runAdd(
      emptyDoc(),
      { id: ID_A, fromParse: 'the API shall reject expired tokens' },
      noModalOpts(),
    )
    if (res.envelope.type === 'error') throw new Error('unexpected error')
    expect(res.envelope.data.id).toBe(ID_A)
  })

  it('persists an explicit negation: positive text + negated flag + "shall not" sentence (C1)', async () => {
    const res = await runAdd(
      emptyDoc(),
      { fromParse: 'the auth service shall not store plaintext passwords' },
      noModalOpts(),
    )
    if (res.envelope.type === 'error') throw new Error('unexpected error')
    const { requirement, parse } = res.envelope.data
    // Parse provenance still reports the polarity flag.
    expect(parse?.negated).toBe(true)
    // The stored response is the POSITIVE atom (no leading "not").
    expect(requirement.systemResponse).not.toMatch(/^not\b/i)
    expect(requirement.systemResponse).toBe('store plaintext passwords')
    // C1: the polarity is PERSISTED on the requirement, not dropped.
    expect(requirement.negated).toBe(true)
    // And the stored sentence renders the prohibition — NOT its semantic inverse.
    expect(requirement.sentence).toContain('shall not')
    expect(requirement.sentence).toBe('The auth service shall not store plaintext passwords.')
  })

  it('a positive parse persists negated: false and a plain "shall" sentence', async () => {
    const res = await runAdd(
      emptyDoc(),
      { fromParse: 'the API shall reject expired tokens' },
      noModalOpts(),
    )
    if (res.envelope.type === 'error') throw new Error('unexpected error')
    const { requirement } = res.envelope.data
    expect(requirement.negated).toBe(false)
    expect(requirement.sentence).toBe('The API shall reject expired tokens.')
  })

  it('structured slots may set negation via --negated (persisted + rendered)', async () => {
    const res = await runAdd(emptyDoc(), {
      slots: { ...eventSlots(), negated: true },
    })
    if (res.envelope.type === 'error') throw new Error('unexpected error')
    const { requirement } = res.envelope.data
    expect(requirement.negated).toBe(true)
    expect(requirement.sentence).toBe(
      'When the user submits valid credentials, the auth service shall not issue a session token.',
    )
  })

  it('a Tier-3 compound failure surfaces ERR_PARSE_COMPOUND with partial + suggestions', async () => {
    const res = await runAdd(
      emptyDoc(),
      { fromParse: 'the auth service shall validate the token and issue a session' },
      noModalOpts(),
    )
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type !== 'error') return
    expect(res.envelope.code).toBe('ERR_PARSE_COMPOUND')
    expect(res.envelope.suggestions.length).toBeGreaterThan(0)
    // Recovered partial skeleton forwarded from the Tier-3 result.
    expect(res.envelope.partial).toBeDefined()
    // With the no-modal fake there is no VERB/CCONJ signal, so the splitter's
    // soundness guard proposes nothing — the envelope must still validate.
    expect(res.envelope.proposedOps).toBeUndefined()
    expect(() => ErrorEnvelopeSchema.parse(res.envelope)).not.toThrow()
  })

  it('a no-modal line surfaces ERR_PARSE_NO_MODAL rather than creating nothing', async () => {
    const res = await runAdd(
      emptyDoc(),
      { fromParse: 'Fast response times are important' },
      noModalOpts(),
    )
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type !== 'error') return
    expect(res.envelope.code).toBe('ERR_PARSE_NO_MODAL')
    expect(() => ErrorEnvelopeSchema.parse(res.envelope)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Mutual exclusion of slots and --from-parse (ERR_USAGE)
// ---------------------------------------------------------------------------

describe('AC-2-10: slots and --from-parse are mutually exclusive', () => {
  it('both slots and --from-parse → ERR_USAGE citing the usage line', async () => {
    const args: AddArgs = { slots: eventSlots(), fromParse: 'the API shall reject expired tokens' }
    const res = await runAdd(emptyDoc(), args)
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type !== 'error') return
    expect(res.envelope.code).toBe('ERR_USAGE')
    expect(res.envelope.suggestions[0]).toBe(`Usage: ${ADD_USAGE}`)
  })

  it('neither slots nor --from-parse → ERR_USAGE', async () => {
    const res = await runAdd(emptyDoc(), {})
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') expect(res.envelope.code).toBe('ERR_USAGE')
  })

  it('a malformed --id surfaces as an envelope, not a Zod stack trace', async () => {
    const res = await runAdd(emptyDoc(), { id: 'not-a-uuid', slots: eventSlots() })
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') {
      expect(() => ErrorEnvelopeSchema.parse(res.envelope)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// wishlist #6: compound-splitter auto-fix — proposedOps on ERR_PARSE_COMPOUND
// ---------------------------------------------------------------------------

describe('wishlist #6: ERR_PARSE_COMPOUND carries ready-to-apply proposedOps', () => {
  it('a genuine two-clause compound proposes two split `add` ops sharing the subject', async () => {
    const res = await runAdd(
      emptyDoc(),
      { fromParse: 'the auth service shall validate the token and issue a session' },
      splitOpts(),
    )
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type !== 'error') return
    expect(res.envelope.code).toBe('ERR_PARSE_COMPOUND')
    expect(res.envelope.proposedOps).toBeDefined()
    expect(res.envelope.proposedOps).toHaveLength(2)
    expect(res.envelope.proposedOps?.[0]).toEqual({
      op: 'add',
      patternType: 'ubiquitous',
      systemName: 'auth service',
      systemResponse: 'validate the token',
    })
    expect(res.envelope.proposedOps?.[1]).toEqual({
      op: 'add',
      patternType: 'ubiquitous',
      systemName: 'auth service',
      systemResponse: 'issue a session',
    })
    // The op omits `id` so apply mints a fresh UUID per op (determinism).
    expect(res.envelope.proposedOps?.every((o) => !('id' in o))).toBe(true)
    expect(() => ErrorEnvelopeSchema.parse(res.envelope)).not.toThrow()
  })

  it('a shared-object coordination ("read and write access") proposes NO ops', async () => {
    const res = await runAdd(
      emptyDoc(),
      { fromParse: 'the database shall provide read and write access' },
      splitOpts(),
    )
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type !== 'error') return
    expect(res.envelope.code).toBe('ERR_PARSE_COMPOUND')
    expect(res.envelope.proposedOps).toBeUndefined()
    expect(() => ErrorEnvelopeSchema.parse(res.envelope)).not.toThrow()
  })

  it('proposedOps are deterministic — identical input yields byte-identical ops', async () => {
    const text = 'the auth service shall validate the token and issue a session'
    const a = await runAdd(emptyDoc(), { fromParse: text }, splitOpts())
    const b = await runAdd(emptyDoc(), { fromParse: text }, splitOpts())
    if (a.envelope.type !== 'error' || b.envelope.type !== 'error') throw new Error('unexpected')
    expect(JSON.stringify(a.envelope.proposedOps)).toBe(JSON.stringify(b.envelope.proposedOps))
  })

  it('each proposed op is a valid create payload and applies cleanly via `apply`', async () => {
    const res = await runAdd(
      emptyDoc(),
      { fromParse: 'the auth service shall validate the token and issue a session' },
      splitOpts(),
    )
    if (res.envelope.type !== 'error') throw new Error('expected error')
    const ops = res.envelope.proposedOps ?? []
    // Each op's create attrs (everything but the `op` discriminant) satisfy the
    // create-attrs schema.
    for (const { op: _op, ...attrs } of ops) {
      expect(CreateRequirementAttrsSchema.safeParse(attrs).success).toBe(true)
    }
    // Fed as a JSONL stream through the real apply op parser, they both apply.
    const jsonl = ops.map((o) => JSON.stringify(o)).join('\n')
    const applied = runApply(emptyDoc(), jsonl)
    expect(applied.envelope.type).toBe('apply')
    if (applied.envelope.type === 'error') return
    expect(applied.envelope.data.summary).toEqual({ total: 2, ok: 2, failed: 0 })
    expect('next' in applied).toBe(true)
  })
})
