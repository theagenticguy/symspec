/**
 * AC-30-3: numeric contradiction detection over LIA/LRA via real Z3-WASM.
 * Groups per-system quantity predicates and proves joint unsatisfiability,
 * naming the culprit ids from the minimal unsat core.
 */

import { describe, expect, it } from 'vitest'
import { getContext } from '../backend.js'
import { extractNumericPredicates } from '../numeric.js'
import { findNumericContradictions, type RequirementPredicates } from '../numeric-contradiction.js'

/** Build a RequirementPredicates from a slot text under one system. */
function rp(id: string, text: string, system = 'api'): RequirementPredicates {
  return { id, predicates: extractNumericPredicates(text, system) }
}

describe('findNumericContradictions (AC-30-3)', () => {
  it('flags jointly-unsat bounds on the same quantity with both ids', async () => {
    const ctx = await getContext('num-test-1')
    const findings = await findNumericContradictions(ctx, [
      rp('A', 'keep temperature above 40'), // temp > 40
      rp('B', 'keep temperature below 30'), // temp < 30
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('FND_NUMERIC_CONTRADICTION')
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.requirementIds).toEqual(['A', 'B'])
    expect(findings[0]!.evidence.numeric?.label).toContain('temperature')
  })

  it('detects a conflict across mixed units (unit-normalized)', async () => {
    const ctx = await getContext('num-test-2')
    const findings = await findNumericContradictions(ctx, [
      rp('A', 'respond within 2 seconds'), // latency <= 2000 ms
      rp('B', 'respond over 3000 ms'), // latency > 3000 ms  → impossible together
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.requirementIds).toEqual(['A', 'B'])
  })

  it('does NOT flag satisfiable bounds on the same quantity', async () => {
    const ctx = await getContext('num-test-3')
    const findings = await findNumericContradictions(ctx, [
      rp('A', 'respond within 500 ms'), // latency <= 500
      rp('B', 'respond over 100 ms'), // latency > 100  → 100 < latency <= 500 is fine
    ])
    expect(findings).toEqual([])
  })

  it('does NOT flag bounds on DIFFERENT quantities', async () => {
    const ctx = await getContext('num-test-4')
    const findings = await findNumericContradictions(ctx, [
      rp('A', 'latency within 100 ms'),
      rp('B', 'retries at most 3'),
    ])
    expect(findings).toEqual([])
  })

  it('does NOT flag a cross-system same-label pair (per-system scoping)', async () => {
    const ctx = await getContext('num-test-5')
    const findings = await findNumericContradictions(ctx, [
      { id: 'A', predicates: extractNumericPredicates('temperature above 40', 'oven') },
      { id: 'B', predicates: extractNumericPredicates('temperature below 30', 'fridge') },
    ])
    expect(findings).toEqual([])
  })

  it('names only the minimal core when an innocent third shares the quantity', async () => {
    const ctx = await getContext('num-test-6')
    const findings = await findNumericContradictions(ctx, [
      rp('A', 'temperature above 40'), // > 40
      rp('B', 'temperature below 30'), // < 30  (A∧B already unsat)
      rp('C', 'temperature above 10'), // > 10  (innocent — consistent with either)
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.requirementIds).toEqual(['A', 'B'])
  })
})

/**
 * T-AC-1-1: the comparison group is `(quantity, baseUnit)`, not `quantity`.
 *
 * A unitless bound's magnitude is UNKNOWN, so it is not comparable to one that
 * normalized onto a base unit — "respond within 5" and "respond over 2000 ms"
 * share a quantity key but 5 *seconds* is 5000 ms, strictly greater than 2000 ms.
 * Comparing them fabricated an error-severity FND_NUMERIC_CONTRADICTION, the
 * cardinal sin under sound-modulo-atomization. Assuming a unit for the unitless
 * side would invent a magnitude, so the tier declines the comparison: a MISS is
 * the honest failure direction for a verdict-eligible tier. This mirrors the
 * guard the propose-only quantity-alias tier already carried.
 */
describe('T-AC-1-1 — unit-aware grouping (no unitless-vs-united comparison)', () => {
  it('does NOT flag a unitless bound against a unit-normalized one (the reproducer)', async () => {
    const ctx = await getContext('num-unit-1')
    const findings = await findNumericContradictions(ctx, [
      rp('R1', 'respond within 5'), // <= 5, unitless — magnitude unknown
      rp('R2', 'respond over 2000 ms'), // > 2000 ms
    ])
    // 5 s = 5000 ms > 2000 ms, so there is no conflict to prove. Before this fix
    // both landed on `sys__api__qty__respond` and z3 saw `q <= 5 ∧ q > 2000`.
    expect(findings).toEqual([])
  })

  it('still flags a same-unit conflict on that same quantity (criterion 2)', async () => {
    const ctx = await getContext('num-unit-2')
    const findings = await findNumericContradictions(ctx, [
      rp('R1', 'respond within 5 ms'), // <= 5 ms
      rp('R2', 'respond over 2000 ms'), // > 2000 ms
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('FND_NUMERIC_CONTRADICTION')
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.requirementIds).toEqual(['R1', 'R2'])
    // Evidence is byte-identical in shape to the pre-partition tier: the
    // `quantity` is the BARE key (the unit is reported per predicate).
    expect(findings[0]!.evidence.numeric?.quantity).toBe('sys__api__qty__respond')
    expect(findings[0]!.evidence.numeric?.predicates.map((p) => p.unit)).toEqual(['ms', 'ms'])
  })

  it('still flags a BOTH-unitless conflict (criterion 3)', async () => {
    const ctx = await getContext('num-unit-3')
    const findings = await findNumericContradictions(ctx, [
      rp('R1', 'retry at most 3'), // <= 3, unitless
      rp('R2', 'retry at least 10'), // >= 10, unitless
    ])
    // Two unitless bounds ARE mutually comparable — they share the `''` base.
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.requirementIds).toEqual(['R1', 'R2'])
    expect(findings[0]!.evidence.numeric?.predicates.map((p) => p.unit)).toEqual(['', ''])
  })

  it('stays silent on a cross-spelling NON-conflict (criterion 4)', async () => {
    const ctx = await getContext('num-unit-4')
    const findings = await findNumericContradictions(ctx, [
      rp('R1', 'respond within 5 s'), // <= 5000 ms
      rp('R2', 'respond over 2000 ms'), // > 2000 ms  → 2000 < q <= 5000 is fine
    ])
    expect(findings).toEqual([])
  })

  it('still flags a cross-spelling REAL conflict on one base (criterion 5)', async () => {
    const ctx = await getContext('num-unit-5')
    const findings = await findNumericContradictions(ctx, [
      rp('R1', 'respond within 1 s'), // <= 1000 ms
      rp('R2', 'respond over 2000 ms'), // > 2000 ms  → UNSAT
    ])
    // `s` and `ms` normalize to the SAME base (`ms`), so they share a group —
    // the partition is on the normalized base, never on the source spelling.
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('error')
    expect(findings[0]!.requirementIds).toEqual(['R1', 'R2'])
  })

  it('does NOT flag a time bound against a byte bound on one label', async () => {
    const ctx = await getContext('num-unit-6')
    const findings = await findNumericContradictions(ctx, [
      rp('R1', 'transfer within 100 ms'), // <= 100 ms
      rp('R2', 'transfer over 2000 kb'), // > 2,000,000 B — a different dimension
    ])
    // Dimensionally incomparable: "100 ms" and "2 MB" are not one quantity even
    // though the label "transfer" collides.
    expect(findings).toEqual([])
  })

  it('PARTITIONS rather than skips: an ms conflict still fires beside a unitless bound', async () => {
    const ctx = await getContext('num-unit-7')
    const findings = await findNumericContradictions(ctx, [
      rp('R1', 'respond within 5'), // <= 5, unitless — incomparable to the ms pair
      rp('R2', 'respond within 1 ms'), // <= 1 ms
      rp('R3', 'respond over 2000 ms'), // > 2000 ms  → R2 ∧ R3 UNSAT
    ])
    // Dropping the whole quantity on mixed units would trade the false positive
    // for a fresh false NEGATIVE. The `ms` subgroup must still be proved, and
    // the unitless R1 must not ride along in the core.
    expect(findings).toHaveLength(1)
    expect(findings[0]!.requirementIds).toEqual(['R2', 'R3'])
  })

  it('is deterministic and input-order-independent in its verdict', async () => {
    const ctx = await getContext('num-unit-8')
    const mixed = (): RequirementPredicates[] => [
      rp('R1', 'respond within 5'),
      rp('R2', 'respond within 1 ms'),
      rp('R3', 'respond over 2000 ms'),
    ]
    // Same input twice → byte-identical output (the determinism contract).
    expect(await findNumericContradictions(ctx, mixed())).toEqual(
      await findNumericContradictions(ctx, mixed()),
    )
    // Reversed input → the same VERDICT. Only `evidence.numeric.predicates` row
    // order tracks input order (pre-existing, and the pipeline sorts findings
    // themselves), so compare the verdict-bearing fields plus the predicate set.
    const verdict = (fs: Awaited<ReturnType<typeof findNumericContradictions>>) =>
      fs.map((f) => ({
        code: f.code,
        severity: f.severity,
        requirementIds: f.requirementIds,
        quantity: f.evidence.numeric?.quantity,
        preds: [...(f.evidence.numeric?.predicates ?? [])]
          .map((p) => `${p.requirementId}|${p.comparator}|${p.value}|${p.unit}`)
          .sort(),
      }))
    const reversed = await findNumericContradictions(ctx, [...mixed()].reverse())
    expect(verdict(reversed)).toEqual(verdict(await findNumericContradictions(ctx, mixed())))
  })
})
