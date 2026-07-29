import { describe, expect, it } from 'vitest'
// The reproduce ops are only worth anything if `apply` actually accepts them, so
// this test drives the real command core rather than re-implementing its fold.
import { APPLY_OPS, type ApplyData, runApply } from '../../cli/apply.js'
import { applyChange } from '../changes.js'
import { emptyDoc } from '../doc.js'
import {
  RELATION_REPRODUCE_OP,
  type ReproduceAddOp,
  reproduceAddOps,
  reproduceCommands,
  reproduceEdgeOps,
  reproduceOps,
  reproduceOpsJsonl,
  reproducePlan,
  reproduceSuggestions,
} from '../reproduce.js'
import { RELATIONS, type RequirementsDoc } from '../schema.js'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'
const MISSING = '99999999-9999-4999-8999-999999999999'

/** A three-requirement doc with edges, glossary, antonyms and waivers. */
function richDoc(): RequirementsDoc {
  let doc = emptyDoc()
  doc = applyChange(doc, {
    kind: 'CreateRequirement',
    id: ID_A,
    attrs: {
      key: 'G1',
      patternType: 'ubiquitous',
      systemName: 'auth service',
      systemResponse: 'log every attempt',
      priority: 'high',
      status: 'approved',
      verificationMethod: 'test',
      verificationNote: "Hypothesis suite in tests/property/ — quote's included",
    },
  })
  doc = applyChange(doc, {
    kind: 'CreateRequirement',
    id: ID_B,
    attrs: {
      key: 'S3',
      patternType: 'event-driven',
      systemName: 'auth service',
      systemResponse: 'issue a session token',
      trigger: 'the user submits valid credentials',
      negated: true,
    },
  })
  doc = applyChange(doc, {
    kind: 'CreateRequirement',
    id: ID_C,
    attrs: {
      patternType: 'state-driven',
      systemName: 'auth service',
      systemResponse: 'reject all login attempts',
      preCondition: 'maintenance mode is enabled',
    },
  })
  doc = applyChange(doc, { kind: 'AddRelationship', from: ID_A, relation: 'derives', to: ID_B })
  doc = applyChange(doc, { kind: 'AddRelationship', from: ID_A, relation: 'derives', to: ID_C })
  doc = applyChange(doc, { kind: 'AddRelationship', from: ID_B, relation: 'satisfies', to: ID_A })
  doc = applyChange(doc, { kind: 'AddRelationship', from: ID_C, relation: 'refines', to: ID_A })
  return {
    ...doc,
    glossary: [{ canonical: 'issue a session token', aliases: ['issue a login credential'] }],
    antonyms: [{ a: 'grant', b: 'deny' }],
    waivers: [
      { code: 'GTWR_R6_MISSING_UNITS', requirementId: ID_A, reason: 'RFC 9457 is an identifier.' },
      { code: 'GTWR_R2_VAGUE_TERM', reason: 'Accepted document-wide.' },
    ],
  }
}

describe('reproduce: op derivation (AC-1-5)', () => {
  it('emits one add op per requirement, carrying every persisted create attr', () => {
    const ops = reproduceAddOps(richDoc())
    expect(ops).toHaveLength(3)
    const byId = new Map(ops.map((o) => [o.id, o]))
    expect(byId.get(ID_A)).toEqual({
      op: 'add',
      id: ID_A,
      key: 'G1',
      patternType: 'ubiquitous',
      systemName: 'auth service',
      systemResponse: 'log every attempt',
      negated: false,
      priority: 'high',
      status: 'approved',
      verificationMethod: 'test',
      verificationNote: "Hypothesis suite in tests/property/ — quote's included",
    })
    expect(byId.get(ID_B)?.negated).toBe(true)
    expect(byId.get(ID_B)?.trigger).toBe('the user submits valid credentials')
    expect(byId.get(ID_C)?.preCondition).toBe('maintenance mode is enabled')
  })

  it('omits absent optional slots rather than writing null/undefined', () => {
    const op = reproduceAddOps(richDoc()).find((o) => o.id === ID_C) as ReproduceAddOp
    for (const key of ['key', 'trigger', 'verificationMethod', 'verificationNote'] as const) {
      expect(Object.hasOwn(op, key), `${key} should be absent, not present-as-undefined`).toBe(
        false,
      )
    }
  })

  it('never emits `sentence` (the renderer re-derives it) or the timestamps', () => {
    for (const op of reproduceAddOps(richDoc())) {
      expect(Object.hasOwn(op, 'sentence')).toBe(false)
      expect(Object.hasOwn(op, 'createdAt')).toBe(false)
      expect(Object.hasOwn(op, 'updatedAt')).toBe(false)
    }
  })

  it('maps each schema relation to the matching apply verb, in array order', () => {
    const { ops, dangling } = reproduceEdgeOps(richDoc())
    expect(dangling).toEqual([])
    expect(ops).toEqual([
      { op: 'derive', from: ID_A, to: ID_B },
      { op: 'derive', from: ID_A, to: ID_C },
      { op: 'satisfy', from: ID_B, to: ID_A },
      { op: 'refine', from: ID_C, to: ID_A },
    ])
  })

  it('RELATION_REPRODUCE_OP is total over RELATIONS and injective', () => {
    const verbs = RELATIONS.map((r) => RELATION_REPRODUCE_OP[r])
    expect(verbs).toHaveLength(RELATIONS.length)
    expect(new Set(verbs).size).toBe(RELATIONS.length)
    // Exact inverse of cli/apply.ts's EDGE_OP_RELATION (asserted there too).
    expect(RELATION_REPRODUCE_OP).toEqual({
      derives: 'derive',
      satisfies: 'satisfy',
      verifies: 'verify',
      refines: 'refine',
    })
  })

  it('orders every add before every edge op (dependency order for one atomic apply)', () => {
    const ops = reproduceOps(richDoc())
    const lastAdd = ops.findLastIndex((o) => o.op === 'add')
    const firstEdge = ops.findIndex((o) => o.op !== 'add')
    expect(lastAdd).toBeLessThan(firstEdge)
  })

  it('is deterministic — the same document yields byte-identical JSONL', () => {
    expect(reproduceOpsJsonl(richDoc())).toBe(reproduceOpsJsonl(richDoc()))
  })

  it('emits JSONL with exactly one JSON object per line', () => {
    const lines = reproduceOpsJsonl(richDoc()).trimEnd().split('\n')
    expect(lines).toHaveLength(reproduceOps(richDoc()).length)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('produces no ops and empty JSONL for an empty document', () => {
    expect(reproduceOps(emptyDoc())).toEqual([])
    expect(reproduceOpsJsonl(emptyDoc())).toBe('')
  })
})

describe('reproduce: commands for the tables `apply` has no op for', () => {
  it('emits one glossary/antonym/waive command per committed row', () => {
    expect(reproduceCommands(richDoc())).toEqual([
      "symspec glossary add 'issue a session token' 'issue a login credential'",
      'symspec antonym add grant deny',
      `symspec waive add GTWR_R6_MISSING_UNITS --reason 'RFC 9457 is an identifier.' --ref ${ID_A}`,
      "symspec waive add GTWR_R2_VAGUE_TERM --reason 'Accepted document-wide.'",
    ])
  })

  it('never fabricates an apply op for a table apply cannot accept', () => {
    for (const op of reproduceOps(richDoc())) {
      expect(['add', 'derive', 'satisfy', 'verify', 'refine']).toContain(op.op)
    }
  })

  it('single-quotes an argument containing a quote so the command stays runnable', () => {
    const doc: RequirementsDoc = {
      ...emptyDoc(),
      waivers: [{ code: 'X_Y', reason: "it's fine" }],
    }
    // POSIX single-quote escaping: close, escaped literal quote, reopen.
    expect(reproduceCommands(doc)).toEqual([`symspec waive add X_Y --reason 'it'\\''s fine'`])
  })
})

describe('reproduce: gaps are disclosed, never papered over', () => {
  it('always discloses the timestamp gap for a non-empty document', () => {
    const kinds = reproducePlan(richDoc()).gaps.map((g) => g.kind)
    expect(kinds).toContain('timestamps')
  })

  it('drops a dangling edge from the op stream AND reports it', () => {
    const base = richDoc()
    const withDangling: RequirementsDoc = {
      ...base,
      requirements: {
        ...base.requirements,
        [ID_B]: { ...(base.requirements[ID_B] as never), verifies: [MISSING] },
      },
    }
    const plan = reproducePlan(withDangling)
    expect(plan.ops.some((o) => 'to' in o && o.to === MISSING)).toBe(false)
    const gap = plan.gaps.find((g) => g.kind === 'dangling-edge')
    expect(gap).toBeDefined()
    expect(gap?.detail).toContain(MISSING)
    expect(gap?.requirementIds).toEqual([ID_B])
  })

  it('reports a hand-edited sentence the renderer does not reproduce', () => {
    const base = richDoc()
    const tampered: RequirementsDoc = {
      ...base,
      requirements: {
        ...base.requirements,
        [ID_A]: { ...(base.requirements[ID_A] as never), sentence: 'Hand-written prose.' },
      },
    }
    const gap = reproducePlan(tampered).gaps.find((g) => g.kind === 'rendered-sentence')
    expect(gap).toBeDefined()
    expect(gap?.requirementIds).toEqual([ID_A])
  })

  it('reports no sentence gap for an untampered document', () => {
    expect(reproducePlan(richDoc()).gaps.some((g) => g.kind === 'rendered-sentence')).toBe(false)
  })

  it('reports no gaps at all for an empty document (nothing to disclose)', () => {
    expect(reproducePlan(emptyDoc()).gaps).toEqual([])
  })
})

describe('reproduce: the op stream actually rebuilds the document', () => {
  /** Fold the plan's ops through applyChange the way `apply` does. */
  function replay(plan: ReturnType<typeof reproducePlan>): RequirementsDoc {
    let current = emptyDoc()
    for (const op of plan.ops) {
      if (op.op === 'add') {
        const { op: _op, id, ...attrs } = op
        current = applyChange(current, { kind: 'CreateRequirement', id, attrs })
      } else {
        const relation = RELATIONS.find((r) => RELATION_REPRODUCE_OP[r] === op.op)
        current = applyChange(current, {
          kind: 'AddRelationship',
          from: op.from,
          relation,
          to: op.to,
        })
      }
    }
    return current
  }

  it('round-trips every requirement and edge modulo timestamps', () => {
    const original = richDoc()
    const rebuilt = replay(reproducePlan(original))
    const strip = (doc: RequirementsDoc) =>
      Object.fromEntries(
        Object.entries(doc.requirements).map(([id, r]) => {
          const { createdAt: _c, updatedAt: _u, ...rest } = r
          return [id, rest]
        }),
      )
    expect(strip(rebuilt)).toEqual(strip(original))
  })

  it('re-renders the identical canonical sentence for every requirement', () => {
    const original = richDoc()
    const rebuilt = replay(reproducePlan(original))
    for (const [id, r] of Object.entries(original.requirements)) {
      expect(rebuilt.requirements[id]?.sentence).toBe(r.sentence)
    }
  })

  it('preserves requirement UUIDs, so a UUID-scoped waiver still resolves', () => {
    const original = richDoc()
    const rebuilt = replay(reproducePlan(original))
    for (const waiver of original.waivers) {
      if (waiver.requirementId === undefined) continue
      expect(rebuilt.requirements[waiver.requirementId]).toBeDefined()
    }
  })
})

describe('reproduce: suggestion rendering (the channel the CLI envelope forwards)', () => {
  const suggestions = () => reproduceSuggestions(reproducePlan(richDoc()), 3, 2)

  it('carries every op record verbatim as its own suggestion', () => {
    const emitted = suggestions().filter((s) => s.startsWith('{'))
    expect(emitted).toEqual(reproduceOps(richDoc()).map((o) => JSON.stringify(o)))
  })

  it('carries every command verbatim as its own suggestion', () => {
    const emitted = suggestions().filter((s) => s.startsWith('symspec ') && !s.startsWith('{'))
    expect(emitted).toEqual(reproduceCommands(richDoc()))
  })

  it('states the parse contract so an agent can split ops from prose', () => {
    expect(suggestions().some((s) => s.includes('How to read this list'))).toBe(true)
  })

  it('names both versions and the init + apply path', () => {
    const all = suggestions().join('\n')
    expect(all).toContain('schemaVersion 3')
    expect(all).toContain('expects 2')
    expect(all).toContain('symspec init')
    expect(all).toContain('symspec apply')
  })

  it('appends every gap as prose', () => {
    const all = suggestions().join('\n')
    for (const gap of reproducePlan(richDoc()).gaps) expect(all).toContain(gap.detail)
  })

  it('says plainly that there is nothing to apply for an empty document', () => {
    const all = reproduceSuggestions(reproducePlan(emptyDoc()), 3, 2).join('\n')
    expect(all).toContain('no reproducible requirements')
    expect(all).not.toContain('{"op"')
  })

  it('carries no prior-schema vocabulary anywhere in the payload', () => {
    // Same clean-slate discipline as changes.test.ts / codes.test.ts: the
    // reproduce payload documents the CURRENT schema on its own terms.
    for (const s of suggestions()) {
      expect(s).not.toMatch(/migrat|legacy|automerge|CRDT/i)
    }
  })
})

// ---------------------------------------------------------------------------
// The load-bearing test: the ops are GENUINELY executable by the real `apply`.
//
// Every other assertion in this file replays the ops through `applyChange`
// directly, which proves the CHANGES are valid but NOT that `apply` accepts the
// op records — the exact gap that would let this land claiming a capability it
// does not have. So this block drives the actual `runApply` fold over the actual
// JSONL text, with no hand-translation anywhere in the path.
// ---------------------------------------------------------------------------

describe('reproduce: the emitted JSONL round-trips through the real `apply` fold', () => {
  /** Parse the ops back out of the rendered suggestions, exactly as an agent would. */
  function opsTextFromSuggestions(doc: RequirementsDoc): string {
    const suggestions = reproduceSuggestions(reproducePlan(doc), 3, 2)
    return `${suggestions.filter((s) => s.startsWith('{')).join('\n')}\n`
  }

  it('applies every op with zero failures, in atomic mode, from the suggestion payload', () => {
    const result = runApply(emptyDoc(), opsTextFromSuggestions(richDoc()))
    // Atomic mode omits `next` on any failure, so its presence is itself proof
    // that no op was rejected.
    expect('next' in result).toBe(true)
    expect(result.envelope.type).toBe('apply')
    const data = (result.envelope as { data: ApplyData }).data
    expect(data.summary.failed).toBe(0)
    expect(data.summary.ok).toBe(data.summary.total)
    expect(data.results.every((r) => r.ok)).toBe(true)
  })

  it('reproduces the document exactly, modulo the disclosed timestamps', () => {
    const original = richDoc()
    const result = runApply(emptyDoc(), opsTextFromSuggestions(original))
    expect('next' in result).toBe(true)
    const rebuilt = (result as { next: RequirementsDoc }).next

    const strip = (doc: RequirementsDoc) =>
      Object.fromEntries(
        Object.entries(doc.requirements).map(([id, r]) => {
          const { createdAt: _c, updatedAt: _u, ...rest } = r
          return [id, rest]
        }),
      )
    expect(strip(rebuilt)).toEqual(strip(original))
    // Timestamps are the ONLY divergence, and the plan says so out loud.
    expect(reproducePlan(original).gaps.some((g) => g.kind === 'timestamps')).toBe(true)
  })

  it('every emitted op verb is a member of `apply`’s own APPLY_OPS set', () => {
    // Guards against the AC-1-4 defect class: an op `apply` would reject.
    for (const op of reproduceOps(richDoc())) {
      expect(APPLY_OPS as readonly string[]).toContain(op.op)
    }
  })

  it('the edge-verb table is the exact inverse of `apply`’s relation mapping', () => {
    // Both directions asserted, so neither table can drift from the other.
    for (const relation of RELATIONS) {
      const verb = RELATION_REPRODUCE_OP[relation]
      const roundTripped = runApply(
        richDoc(),
        `${JSON.stringify({ op: verb, from: ID_A, to: ID_B })}\n`,
      )
      expect('next' in roundTripped, `${verb} should be accepted by apply`).toBe(true)
      const rebuilt = (roundTripped as { next: RequirementsDoc }).next
      expect(rebuilt.requirements[ID_A]?.[relation]).toContain(ID_B)
    }
  })

  it('a document whose only content is non-op tables yields no ops but keeps its commands', () => {
    const tablesOnly: RequirementsDoc = {
      ...emptyDoc(),
      glossary: [{ canonical: 'open the valve', aliases: ['unseal the valve'] }],
    }
    const plan = reproducePlan(tablesOnly)
    expect(plan.ops).toEqual([])
    expect(plan.commands).toEqual(["symspec glossary add 'open the valve' 'unseal the valve'"])
    // And `apply` on an empty stream is a clean usage error, not a crash — which
    // is why the suggestion text says plainly there is nothing to apply.
    expect(runApply(emptyDoc(), '').envelope.type).toBe('error')
  })
})
