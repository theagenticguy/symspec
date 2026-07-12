import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../core/doc.js'
import type { AddSlots } from '../add.js'
import { runAdd } from '../add.js'
import { SuccessEnvelopeSchema } from '../envelope.js'

/**
 * Wishlist #10 (add --dry-run preview) + #2 (stable --key minting + uniqueness).
 * Uses the structured-slots path so no wink-nlp Tier-2 loader is ever needed.
 */

const ubiquitousSlots = (overrides: Partial<AddSlots> = {}): AddSlots =>
  ({
    patternType: 'ubiquitous',
    systemName: 'auth service',
    systemResponse: 'issue a session token',
    ...overrides,
  }) as AddSlots

describe('add --dry-run (#10)', () => {
  it('previews the rendered sentence + lint findings and writes NOTHING', async () => {
    const doc = emptyDoc()
    // A bare number trips GTWR_R6 — the exact class of thing the report wanted
    // to catch at authoring time.
    const res = await runAdd(doc, {
      dryRun: true,
      slots: ubiquitousSlots({ systemResponse: 'store 42 records' }),
    })
    // No `next` — nothing persisted.
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('add')
    if (res.envelope.type !== 'error' && 'dryRun' in res.envelope.data) {
      expect(res.envelope.data.dryRun).toBe(true)
      expect(res.envelope.data.requirement.sentence).toBe(
        'The auth service shall store 42 records.',
      )
      const codes = res.envelope.data.findings.map((f) => f.code)
      expect(codes).toContain('GTWR_R6_MISSING_UNITS')
    }
    expect(() => SuccessEnvelopeSchema.parse(res.envelope)).not.toThrow()
    // Input doc untouched.
    expect(Object.keys(doc.requirements)).toHaveLength(0)
  })

  it('a well-formed requirement previews with no error-severity findings', async () => {
    // "issue a session token" is a clean obligation; it may draw a warn-level
    // GtWR nudge (e.g. R5 indefinite-article on "a"), but nothing error-severity
    // — the dry-run preview surfaces exactly what `check` would, no more.
    const res = await runAdd(emptyDoc(), { dryRun: true, slots: ubiquitousSlots() })
    expect('next' in res).toBe(false)
    if (res.envelope.type !== 'error' && 'dryRun' in res.envelope.data) {
      const errors = res.envelope.data.findings.filter((f) => f.severity === 'error')
      expect(errors).toEqual([])
    }
  })
})

describe('add --key stable-key minting + uniqueness (#2)', () => {
  it('persists the key on the created requirement', async () => {
    const res = await runAdd(emptyDoc(), { slots: ubiquitousSlots({ key: 'G1' }) })
    expect('next' in res).toBe(true)
    if ('next' in res && res.envelope.type !== 'error' && 'requirement' in res.envelope.data) {
      expect(res.envelope.data.requirement.key).toBe('G1')
    }
  })

  it('refuses a duplicate key with ERR_DUPLICATE_KEY', async () => {
    const first = await runAdd(emptyDoc(), { slots: ubiquitousSlots({ key: 'G1' }) })
    expect('next' in first).toBe(true)
    if (!('next' in first)) return
    const second = await runAdd(first.next, {
      slots: ubiquitousSlots({ key: 'G1', systemResponse: 'do something else' }),
    })
    expect('next' in second).toBe(false)
    expect(second.envelope.type).toBe('error')
    if (second.envelope.type === 'error') expect(second.envelope.code).toBe('ERR_DUPLICATE_KEY')
  })

  it('a dry-run duplicate key is also refused (checked before the preview)', async () => {
    const first = await runAdd(emptyDoc(), { slots: ubiquitousSlots({ key: 'G1' }) })
    if (!('next' in first)) throw new Error('expected next')
    const dry = await runAdd(first.next, { dryRun: true, slots: ubiquitousSlots({ key: 'G1' }) })
    expect(dry.envelope.type).toBe('error')
    if (dry.envelope.type === 'error') expect(dry.envelope.code).toBe('ERR_DUPLICATE_KEY')
  })
})
