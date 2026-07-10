import { describe, expect, it } from 'vitest'
import {
  CANONICAL_EVENT_KEYWORD,
  CANONICAL_MODAL,
  EVENT_SYNONYMS,
  NONSTANDARD_MODAL_CONFIDENCE,
  NONSTANDARD_MODAL_NOTE,
  NONSTANDARD_MODALS,
  normalizeEventKeyword,
  normalizeModal,
} from '../normalize.js'
import { classifyTier1 } from '../tier1.js'

describe('T-AC-2-3: event synonym normalization', () => {
  describe('the spec anchor: "Upon receipt of…" → event-driven', () => {
    it('normalizeEventKeyword recognizes "upon" as a synonym for canonical "when"', () => {
      const r = normalizeEventKeyword('Upon receipt of a shutdown command')
      expect(r).toBeDefined()
      expect(r?.canonical).toBe(CANONICAL_EVENT_KEYWORD)
      expect(r?.matched).toBe('upon')
      expect(r?.rest).toBe('receipt of a shutdown command')
      expect(r?.note).toBe('event-synonym:upon')
    })

    it('end-to-end: the full sentence still classifies as event-driven through Tier 1', () => {
      const r = classifyTier1(
        'Upon receipt of a shutdown command, the system shall initiate safe shutdown',
      )
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.pattern).toBe('event-driven')
    })
  })

  describe('every canonical event synonym normalizes to "when"', () => {
    it.each(EVENT_SYNONYMS)('%s → canonical "when" with an event-synonym note', (synonym) => {
      const r = normalizeEventKeyword(`${synonym} something happens, do X`)
      expect(r).toBeDefined()
      expect(r?.canonical).toBe('when')
      expect(r?.matched).toBe(synonym)
      expect(r?.note).toBe(`event-synonym:${synonym.replace(/\s+/g, '-')}`)
    })
  })

  it('"whenever" is recognized as its own synonym, distinct from bare "when"', () => {
    const r = normalizeEventKeyword('Whenever an error occurs, the logger shall record it')
    expect(r?.matched).toBe('whenever')
    expect(r?.note).toBe('event-synonym:whenever')
  })

  it('multi-word synonyms are matched in full, not truncated to a shorter prefix', () => {
    const asSoonAs = normalizeEventKeyword('As soon as the door opens, arm the alarm')
    expect(asSoonAs?.matched).toBe('as soon as')

    const onReceiptOf = normalizeEventKeyword('On receipt of the payload, ack it')
    expect(onReceiptOf?.matched).toBe('on receipt of')

    const inTheEventThat = normalizeEventKeyword('In the event that power fails, switch to backup')
    expect(inTheEventThat?.matched).toBe('in the event that')
  })

  it('a bare canonical "when" match carries no synonym note', () => {
    const r = normalizeEventKeyword('When the door opens, the alarm shall arm')
    expect(r?.matched).toBe('when')
    expect(r?.canonical).toBe('when')
    expect(r?.note).toBeUndefined()
  })

  it('is case-insensitive on the leading keyword', () => {
    const r = normalizeEventKeyword('UPON approval, notify the requester')
    expect(r?.matched).toBe('upon')
    expect(r?.note).toBe('event-synonym:upon')
  })

  it('returns undefined when no event keyword leads the input', () => {
    expect(normalizeEventKeyword('While maintenance mode is on, reject logins')).toBeUndefined()
    expect(normalizeEventKeyword('The system shall log every attempt')).toBeUndefined()
  })

  it('does not match a keyword embedded mid-sentence, only leading', () => {
    expect(normalizeEventKeyword('The system shall notify upon completion')).toBeUndefined()
  })

  it('rest is the trimmed remainder after the leading keyword', () => {
    const r = normalizeEventKeyword('once   the   payload arrives, ack it')
    expect(r?.matched).toBe('once')
    expect(r?.rest).toBe('the   payload arrives, ack it')
  })
})

describe('T-AC-2-3: non-shall modal normalization + provenance', () => {
  describe('the spec anchor: "must" flagged, medium confidence', () => {
    it('normalizeModal flags "must" with nonstandard-modal note and medium confidence', () => {
      const r = normalizeModal('must')
      expect(r.canonical).toBe(CANONICAL_MODAL)
      expect(r.matched).toBe('must')
      expect(r.note).toBe(NONSTANDARD_MODAL_NOTE)
      expect(r.confidence).toBe('medium')
      expect(r.confidence).toBe(NONSTANDARD_MODAL_CONFIDENCE)
    })

    it('end-to-end: the full sentence carries the same provenance through Tier 1', () => {
      const r = classifyTier1('The database must be backed up daily.')
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.notes).toContain('nonstandard-modal')
        expect(r.confidence).toBe('medium')
      }
    })
  })

  describe('every canonical non-standard modal normalizes to "shall"', () => {
    it.each(NONSTANDARD_MODALS)('%s → canonical "shall", flagged, medium confidence', (modal) => {
      const r = normalizeModal(modal)
      expect(r.canonical).toBe('shall')
      expect(r.matched).toBe(modal)
      expect(r.note).toBe('nonstandard-modal')
      expect(r.confidence).toBe('medium')
    })
  })

  it('a canonical "shall" modal carries no note and no confidence downgrade', () => {
    const r = normalizeModal('shall')
    expect(r.canonical).toBe('shall')
    expect(r.matched).toBe('shall')
    expect(r.note).toBeUndefined()
    expect(r.confidence).toBeUndefined()
  })

  it('is case-insensitive and trims surrounding whitespace on the modal', () => {
    const r = normalizeModal('  MUST  ')
    expect(r.matched).toBe('must')
    expect(r.note).toBe('nonstandard-modal')
  })
})

describe('T-AC-2-3: canonical text is never spliced back into slot values', () => {
  it("the matched synonym/modal do not leak into the classified sentence's slots", () => {
    const r = classifyTier1('Once the payload arrives, the gateway shall ack it')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.pattern).toBe('event-driven')
      // trigger/response retain the original prose verbatim — no "when"/"shall" splicing.
      expect(r.slots.trigger).toBe('the payload arrives')
      expect(r.slots.systemResponse).toBe('ack it')
    }
  })
})

describe('T-AC-2-3: purity + determinism', () => {
  it('normalizeEventKeyword is a pure function of its input', () => {
    const input = 'Upon receipt of a signal, react'
    expect(normalizeEventKeyword(input)).toEqual(normalizeEventKeyword(input))
  })

  it('normalizeModal is a pure function of its input', () => {
    expect(normalizeModal('will')).toEqual(normalizeModal('will'))
  })
})
