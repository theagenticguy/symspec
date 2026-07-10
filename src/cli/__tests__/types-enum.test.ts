import { describe, expect, it } from 'vitest'
import { buildManifest } from '../manifest.js'
import {
  EnvelopeTypeSchema,
  EnvelopeTypes,
  ERROR_ENVELOPE_TYPE,
  isEnvelopeType,
} from '../types-enum.js'

/**
 * AC-6-13 — the envelope `type` discriminant is a closed, append-only Zod enum
 * at parity with the ERR_, GTWR_, and FND_ code catalogs (AC-6-3). It must:
 *   - contain one member per result-bearing command (the success `type` IS the
 *     command name) plus the reserved `'error'` failure discriminant;
 *   - stay consistent with the AC-6-1 command inventory so the enum and the
 *     manifest cannot drift — adding a command without a `type` (or vice versa)
 *     fails a test here;
 *   - expose itself through the manifest's `types` table (derivation, not a
 *     hand-list);
 *   - be append-only, guarded by the same snapshot pattern as
 *     `core/__tests__/codes.test.ts`.
 */

/**
 * Append-only snapshot (AC-6-13, mirrors the AC-6-3 code-catalog guard). This
 * frozen list is the shipped envelope-`type` order. The guard below fails if
 * any member is REMOVED, RENAMED, or REORDERED — a new type may only be
 * APPENDED to the end (a deliberate edit to this list). Keep additions at the
 * tail.
 */
const ENVELOPE_TYPES_SNAPSHOT = [
  'manifest',
  'init',
  'add',
  'update',
  'parse',
  'check',
  'certify',
  'list',
  'show',
  'derive',
  'satisfy',
  'remove-edge',
  'delete',
  'export',
  'error',
] as const

describe('EnvelopeTypeSchema (AC-6-13 — closed append-only envelope type enum)', () => {
  it('is append-only: no existing type was removed, renamed, or reordered', () => {
    for (const [i, t] of ENVELOPE_TYPES_SNAPSHOT.entries()) {
      expect(EnvelopeTypes[i]).toBe(t)
    }
    // Length may only grow (append). A shrink means a type was removed — the
    // violation this guard exists to catch.
    expect(EnvelopeTypes.length).toBeGreaterThanOrEqual(ENVELOPE_TYPES_SNAPSHOT.length)
    // The prefix must match exactly — appends allowed, reorders are not.
    expect(EnvelopeTypes.slice(0, ENVELOPE_TYPES_SNAPSHOT.length)).toEqual([
      ...ENVELOPE_TYPES_SNAPSHOT,
    ])
  })

  it('reserves the literal error discriminant for the failure envelope (AC-6-2)', () => {
    expect(ERROR_ENVELOPE_TYPE).toBe('error')
    expect(EnvelopeTypes).toContain('error')
    expect(isEnvelopeType('error')).toBe(true)
  })

  it('contains a type for every result-bearing command in the manifest inventory', () => {
    // AC-6-1 command inventory is the public source of command names. Every one
    // must be a member of the closed enum — the success `type` IS the command
    // name. Adding a command to COMMAND_SPECS without adding its `type` here
    // fails THIS assertion.
    const commandNames = buildManifest().commands.map((c) => c.name)
    for (const name of commandNames) {
      expect(isEnvelopeType(name), `envelope type enum is missing command '${name}'`).toBe(true)
    }
  })

  it('has no orphan types: every non-error member is a real command (no drift)', () => {
    // The inverse guard: every enum member except the reserved `'error'` must
    // correspond to a command in the manifest inventory. Removing a command
    // without removing its `type` (or typo-ing a member) fails HERE.
    const commandNames = new Set(buildManifest().commands.map((c) => c.name))
    for (const t of EnvelopeTypes) {
      if (t === ERROR_ENVELOPE_TYPE) continue
      expect(commandNames.has(t), `envelope type '${t}' has no matching command`).toBe(true)
    }
  })

  it('the enum and the command inventory + error are exactly the same set', () => {
    const commandNames = buildManifest().commands.map((c) => c.name)
    const expected = [...commandNames, ERROR_ENVELOPE_TYPE].sort()
    expect([...EnvelopeTypes].sort()).toEqual(expected)
  })

  it('the manifest derives its types table from the enum (AC-6-13, not a hand-list)', () => {
    const m = buildManifest()
    expect(m.types).toEqual([...EnvelopeTypes])
    // Representative members present, proving the derivation is live.
    expect(m.types).toContain('check')
    expect(m.types).toContain('error')
  })

  it('isEnvelopeType rejects a value outside the closed set', () => {
    expect(isEnvelopeType('not-a-command')).toBe(false)
    expect(isEnvelopeType('')).toBe(false)
  })

  it('every member parses through the Zod enum', () => {
    for (const t of EnvelopeTypes) {
      expect(() => EnvelopeTypeSchema.parse(t)).not.toThrow()
    }
    expect(() => EnvelopeTypeSchema.parse('bogus')).toThrow()
  })
})
