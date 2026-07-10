/**
 * AC-9-6: the glossary command core — add / remove / list over the doc's
 * committed synonym groups. Pure `{next?, envelope}` shape like add/update.
 */

import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../core/doc.js'
import { glossaryAdd, glossaryList, glossaryRemove } from '../glossary.js'

describe('glossary command core (AC-9-6)', () => {
  it('add creates a canonical group and returns the mutated doc', () => {
    const res = glossaryAdd(emptyDoc(), 'issue a session token', 'issue a login credential')
    expect('next' in res).toBe(true)
    if (!('next' in res)) return
    expect(res.next.glossary).toEqual([
      { canonical: 'issue a session token', aliases: ['issue a login credential'] },
    ])
    if (res.envelope.type !== 'error') expect(res.envelope.data.action).toBe('added')
  })

  it('add is idempotent (existing alias → noop, no next)', () => {
    const first = glossaryAdd(emptyDoc(), 'c', 'a')
    if (!('next' in first)) throw new Error('expected next')
    const again = glossaryAdd(first.next, 'c', 'a')
    expect('next' in again).toBe(false)
    if (again.envelope.type !== 'error') expect(again.envelope.data.action).toBe('noop')
  })

  it('add appends a second alias to an existing canonical', () => {
    const first = glossaryAdd(emptyDoc(), 'c', 'a1')
    if (!('next' in first)) throw new Error('expected next')
    const second = glossaryAdd(first.next, 'c', 'a2')
    if (!('next' in second)) throw new Error('expected next')
    expect(second.next.glossary[0]?.aliases).toEqual(['a1', 'a2'])
  })

  it('remove drops an alias and prunes an emptied group', () => {
    const added = glossaryAdd(emptyDoc(), 'c', 'a')
    if (!('next' in added)) throw new Error('expected next')
    const removed = glossaryRemove(added.next, 'c', 'a')
    expect('next' in removed).toBe(true)
    if ('next' in removed) expect(removed.next.glossary).toEqual([])
  })

  it('remove of an absent alias is a no-op', () => {
    const res = glossaryRemove(emptyDoc(), 'c', 'a')
    expect('next' in res).toBe(false)
    if (res.envelope.type !== 'error') expect(res.envelope.data.action).toBe('noop')
  })

  it('list is read-only and reflects the current glossary', () => {
    const added = glossaryAdd(emptyDoc(), 'c', 'a')
    if (!('next' in added)) throw new Error('expected next')
    const listed = glossaryList(added.next)
    expect('next' in listed).toBe(false)
    if (listed.envelope.type !== 'error') {
      expect(listed.envelope.data.action).toBe('listed')
      expect(listed.envelope.data.glossary).toEqual([{ canonical: 'c', aliases: ['a'] }])
    }
  })

  it('does not mutate the input document', () => {
    const doc = emptyDoc()
    glossaryAdd(doc, 'c', 'a')
    expect(doc.glossary).toEqual([])
  })

  it('rejects empty canonical/alias with ERR_USAGE', () => {
    const res = glossaryAdd(emptyDoc(), '  ', 'a')
    expect('next' in res).toBe(false)
    expect(res.envelope.type).toBe('error')
    if (res.envelope.type === 'error') expect(res.envelope.code).toBe('ERR_USAGE')
  })
})
