import { describe, expect, it } from 'vitest'
import type { Tier1Ok } from '../tier1.js'
import { classifyTier1, MAIN, preprocess, systemEscalationNotes } from '../tier1.js'

/** Narrow to an ok parse or fail the assertion with the escalation notes for context. */
function expectOk(input: string): Tier1Ok {
  const r = classifyTier1(input)
  if (!r.ok)
    throw new Error(
      `expected ok parse for ${JSON.stringify(input)}, got miss: ${r.notes.join(',')}`,
    )
  return r
}

describe('T-AC-2-1: Tier-1 regex cascade — 16-case validation table (research-nlparse.md §1.7)', () => {
  it('1. event-driven with comma: all slots correct', () => {
    const r = expectOk(
      'When the user submits valid credentials, the auth service shall issue a session token',
    )
    expect(r.pattern).toBe('event-driven')
    expect(r.slots.trigger).toBe('the user submits valid credentials')
    expect(r.slots.systemName).toBe('auth service')
    expect(r.slots.systemResponse).toBe('issue a session token')
    expect(r.slots.preCondition).toBeUndefined()
    expect(r.confidence).toBe('high')
    expect(r.negated).toBe(false)
    expect(r.tier).toBe(1)
  })

  it('2. state-driven (While … , …)', () => {
    const r = expectOk(
      'While maintenance mode is on, the auth service shall reject all login attempts',
    )
    expect(r.pattern).toBe('state-driven')
    expect(r.slots.preCondition).toBe('maintenance mode is on')
    expect(r.slots.systemName).toBe('auth service')
    expect(r.slots.systemResponse).toBe('reject all login attempts')
    expect(r.slots.trigger).toBeUndefined()
  })

  it('3. optional-feature (Where … , …)', () => {
    const r = expectOk(
      'Where SSO is configured for the tenant, the auth service shall redirect login to the configured IdP',
    )
    expect(r.pattern).toBe('optional-feature')
    expect(r.slots.preCondition).toBe('SSO is configured for the tenant')
    expect(r.slots.systemResponse).toBe('redirect login to the configured IdP')
  })

  it('4. unwanted-behavior (If … , then …)', () => {
    const r = expectOk(
      'If five consecutive failed logins occur within 10 minutes, then the auth service shall lock the account for 15 minutes',
    )
    expect(r.pattern).toBe('unwanted-behavior')
    expect(r.slots.trigger).toBe('five consecutive failed logins occur within 10 minutes')
    expect(r.slots.systemResponse).toBe('lock the account for 15 minutes')
    expect(r.confidence).toBe('high')
  })

  it('5. ubiquitous (bare main clause)', () => {
    const r = expectOk('The auth service shall log every authentication attempt in JSON')
    expect(r.pattern).toBe('ubiquitous')
    expect(r.slots.systemName).toBe('auth service')
    expect(r.slots.systemResponse).toBe('log every authentication attempt in JSON')
    expect(r.slots.preCondition).toBeUndefined()
    expect(r.slots.trigger).toBeUndefined()
  })

  it('6. complex (While … , when … , …) → event-driven with BOTH pre and trigger', () => {
    const r = expectOk(
      'While the aircraft is on ground, when reverse thrust is commanded, the thrust reverser shall deploy',
    )
    expect(r.pattern).toBe('event-driven')
    expect(r.slots.preCondition).toBe('the aircraft is on ground')
    expect(r.slots.trigger).toBe('reverse thrust is commanded')
    expect(r.slots.systemName).toBe('thrust reverser')
    expect(r.slots.systemResponse).toBe('deploy')
    expect(r.confidence).toBe('high')
  })

  it('7. REQ-ID stripped + "Upon" event synonym → event-driven', () => {
    const r = expectOk(
      'REQ-042: Upon receipt of a shutdown command, the system shall initiate safe shutdown',
    )
    expect(r.pattern).toBe('event-driven')
    expect(r.slots.trigger).toBe('receipt of a shutdown command')
    expect(r.slots.systemName).toBe('system')
    expect(r.slots.systemResponse).toBe('initiate safe shutdown')
  })

  it('8. negation → ubiquitous, negated:true, positive response atom', () => {
    const r = expectOk('The system shall not store plaintext passwords.')
    expect(r.pattern).toBe('ubiquitous')
    expect(r.negated).toBe(true)
    // positive atom — the response must NOT carry the leading "not"
    expect(r.slots.systemResponse).toBe('store plaintext passwords')
    expect(r.slots.systemResponse).not.toMatch(/\bnot\b/)
  })

  it('9. If … (no "then") → unwanted-behavior via fallback, medium confidence', () => {
    const r = expectOk('If the sensor fails, the system shall switch to backup mode')
    expect(r.pattern).toBe('unwanted-behavior')
    expect(r.slots.trigger).toBe('the sensor fails')
    expect(r.slots.systemResponse).toBe('switch to backup mode')
    expect(r.confidence).toBe('medium')
    expect(r.notes).toContain('if-without-then')
  })

  it('10. When … (missing comma) → event-driven via fallback, medium confidence', () => {
    const r = expectOk(
      'When the battery level drops below 10% the device shall enter power saving mode',
    )
    expect(r.pattern).toBe('event-driven')
    expect(r.slots.trigger).toBe('the battery level drops below 10%')
    expect(r.slots.systemName).toBe('device')
    expect(r.slots.systemResponse).toBe('enter power saving mode')
    expect(r.confidence).toBe('medium')
  })

  it('11a. "As soon as …" event synonym → event-driven', () => {
    const r = expectOk('As soon as the door opens, the alarm system shall arm')
    expect(r.pattern).toBe('event-driven')
    expect(r.slots.trigger).toBe('the door opens')
    expect(r.slots.systemName).toBe('alarm system')
  })

  it('11b. "Whenever …" event synonym → event-driven', () => {
    const r = expectOk('Whenever an error occurs, the logger shall record it')
    expect(r.pattern).toBe('event-driven')
    expect(r.slots.trigger).toBe('an error occurs')
    expect(r.slots.systemResponse).toBe('record it')
  })

  it('12. non-shall modal "must" → ubiquitous, flagged nonstandard-modal, medium confidence', () => {
    const r = expectOk('The database must be backed up daily.')
    expect(r.pattern).toBe('ubiquitous')
    expect(r.notes).toContain('nonstandard-modal')
    expect(r.confidence).toBe('medium')
  })

  it('13. person-word subject ("Users should …") → parses but weak-subject, low confidence', () => {
    const r = expectOk('Users should be able to reset their password.')
    expect(r.notes).toContain('weak-subject')
    expect(r.confidence).toBe('low')
  })

  it('14. no modal / not a requirement → escalate (miss)', () => {
    const r = classifyTier1('Fast response times are important.')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.escalate).toBe(true)
  })

  it('15. clause pollution ("While in flight, and when …") → escalate (known Tier-1 failure class)', () => {
    const r = classifyTier1(
      'While in flight, and when the landing gear is deployed, the system shall alert the pilot',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.notes).toContain('system-clause-pollution')
  })
})

describe('T-AC-2-2: mandatory main-clause gate — a rung matches only if its main clause parses', () => {
  it('AC-2-2 verification case: "While in Rome…" prose does not misclassify as state-driven', () => {
    // "While in Rome, do as the Romans do" — leading While but no `shall`/modal main clause.
    // The `while` keyword and comma are present (the state rung's surface shape matches), but
    // because "do as the Romans do" has no mandatory `<system> shall <response>` main clause,
    // the rung must be rejected — not accepted as a low-confidence state-driven parse.
    const r = classifyTier1('While in Rome, do as the Romans do')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.notes).toContain('no-main-clause')
  })

  it('the rejected rung falls through rather than returning a partial/degraded state-driven result', () => {
    // Guards against a regression where the state rung is "accepted" with garbage slots
    // (e.g. systemName: "in Rome", systemResponse: "do as the Romans do") instead of rejected.
    const r = classifyTier1('While in Rome, do as the Romans do')
    if (r.ok) {
      // If this ever becomes `ok`, it must not be the misclassification AC-2-2 forbids.
      expect(r.pattern).not.toBe('state-driven')
    }
  })

  it('same gate applies to the `when` (event) rung: no main-clause modal → falls through, not event-driven', () => {
    const r = classifyTier1('When in doubt, ask a lot of questions')
    expect(r.ok).toBe(false)
  })

  it('same gate applies to the `if` (unwanted-behavior) rung: no modal in main → falls through', () => {
    const r = classifyTier1('If it rains, bring an umbrella')
    expect(r.ok).toBe(false)
  })

  it('same gate applies to the `where` (optional-feature) rung: no modal in main → falls through', () => {
    const r = classifyTier1('Where the light is red, stop immediately')
    expect(r.ok).toBe(false)
  })

  it('complex is tried before state (While…,when… does not degrade to state-driven)', () => {
    const r = expectOk('While the door is open, when motion is detected, the light shall turn on')
    expect(r.pattern).toBe('event-driven')
    expect(r.slots.preCondition).toBe('the door is open')
    expect(r.slots.trigger).toBe('motion is detected')
  })

  it('if…then is tried before the bare-when event rung', () => {
    const r = expectOk('If the request is invalid, then the API shall return a 400')
    expect(r.pattern).toBe('unwanted-behavior')
    expect(r.slots.trigger).toBe('the request is invalid')
  })
})

describe('T-AC-2-1: preprocessing + escalation predicate units', () => {
  it('preprocess strips REQ-ID, normalizes smart quotes, collapses whitespace, drops trailing punct', () => {
    expect(preprocess('REQ-042:  the  service shall log “events”.')).toBe(
      'the service shall log "events"',
    )
    expect(preprocess('3.1.4) the system shall respond;')).toBe('the system shall respond')
    expect(preprocess('SYS-12. the system shall boot')).toBe('the system shall boot')
  })

  it('smart-quoted input parses to correct slots after preprocessing', () => {
    const r = expectOk('The parser shall accept “curly” quotes')
    expect(r.pattern).toBe('ubiquitous')
    expect(r.slots.systemResponse).toBe('accept "curly" quotes')
  })

  it('systemEscalationNotes flags comma / embedded keyword / >6 tokens as hard pollution', () => {
    expect(systemEscalationNotes('auth service')).toEqual([])
    expect(systemEscalationNotes('foo, bar')).toContain('system-clause-pollution')
    expect(systemEscalationNotes('when something happens the widget')).toContain(
      'system-clause-pollution',
    )
    expect(systemEscalationNotes('one two three four five six seven')).toContain(
      'system-clause-pollution',
    )
    expect(systemEscalationNotes('users')).toContain('weak-subject')
  })

  it('MAIN regex isolates system/modal/response with the modal as pivot', () => {
    const m = MAIN.exec('the auth service shall issue a token')
    expect(m?.groups?.system).toBe('auth service')
    expect(m?.groups?.modal).toBe('shall')
    expect(m?.groups?.response).toBe('issue a token')
  })
})
