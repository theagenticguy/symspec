/**
 * Incremental-update smoke test.
 *
 * The concurrent-merge case is dramatic but rare. The common path is a
 * single agent (or user) streaming small Change records over time:
 *   - patch one attribute, see the sentence re-render
 *   - flip a status, leave the sentence alone
 *   - clear an optional field, save, reload from disk
 *   - try to re-create with the same id (should error)
 *   - add the same edge twice (should be idempotent)
 *   - remove an edge that isn't there (should be a no-op)
 *   - null out a required attr (should error)
 *
 * Each step asserts. Any failure exits non-zero.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyze } from '../src/core/analyze.js'
import {
  applyChange,
  emptyDoc,
  getRequirement,
  loadDoc,
  merge,
  newId,
  saveDoc,
} from '../src/core/doc.js'

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

function throws(fn: () => unknown, msgFragment: string, label: string) {
  try {
    fn()
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (m.includes(msgFragment)) {
      console.log(`  OK: ${label} (threw: ${m})`)
      return
    }
    console.error(`FAIL: ${label} threw wrong error: ${m}`)
    process.exit(1)
  }
  console.error(`FAIL: ${label} did not throw`)
  process.exit(1)
}

function header(s: string) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(s)
  console.log('='.repeat(60))
}

const workDir = mkdtempSync(join(tmpdir(), 'ears-inc-'))
const docPath = join(workDir, 'reqs.automerge')

try {
  // --- Step 1: create one requirement, save, reload -------------------
  header('Step 1: create + save + reload roundtrip')

  let doc = emptyDoc()
  const id = newId()
  doc = applyChange(doc, {
    kind: 'CreateRequirement',
    id,
    attrs: {
      patternType: 'event-driven',
      systemName: 'payments service',
      systemResponse: "charge the customer's card",
      trigger: 'the order is confirmed',
      priority: 'high',
    },
  })
  await saveDoc(doc, docPath)

  doc = await loadDoc(docPath)
  let r = getRequirement(doc, id)
  expect(r, 'requirement should round-trip through save/load')
  expect(
    r?.sentence ===
      "When the order is confirmed, the payments service shall charge the customer's card.",
    'sentence rendered after create',
  )
  console.log(`  OK: roundtrip preserves "${r?.sentence}"`)

  // --- Step 2: incremental EARS-slot updates re-render the sentence ----
  header('Step 2: EARS-slot updates re-render the sentence')

  doc = applyChange(doc, {
    kind: 'UpdateAttribute',
    id,
    attr: 'trigger',
    value: 'the order is confirmed and the cart total is over $0',
  })
  r = getRequirement(doc, id)!
  expect(r.sentence.includes('cart total is over $0'), 'sentence updated after trigger change')
  console.log(`  OK: trigger update -> "${r.sentence}"`)

  doc = applyChange(doc, {
    kind: 'UpdateAttribute',
    id,
    attr: 'systemResponse',
    value: 'place a $1 authorization hold',
  })
  r = getRequirement(doc, id)!
  expect(
    r.sentence.includes('$1 authorization hold'),
    'sentence updated after systemResponse change',
  )
  console.log(`  OK: response update -> "${r.sentence}"`)

  // --- Step 3: metadata updates do NOT touch the sentence -------------
  header('Step 3: metadata updates leave the sentence alone')

  const sentenceBefore = r.sentence
  doc = applyChange(doc, {
    kind: 'UpdateAttribute',
    id,
    attr: 'priority',
    value: 'critical',
  })
  doc = applyChange(doc, {
    kind: 'UpdateAttribute',
    id,
    attr: 'status',
    value: 'approved',
  })
  r = getRequirement(doc, id)!
  expect(r.priority === 'critical', 'priority updated')
  expect(r.status === 'approved', 'status updated')
  expect(r.sentence === sentenceBefore, 'sentence unchanged by metadata edits')
  console.log('  OK: priority + status updated, sentence untouched')

  // --- Step 4: null clears an optional attribute -----------------------
  header('Step 4: null on an optional attr clears it')

  // First set verificationMethod, then null it.
  doc = applyChange(doc, {
    kind: 'UpdateAttribute',
    id,
    attr: 'verificationMethod',
    value: 'test',
  })
  r = getRequirement(doc, id)!
  expect(r.verificationMethod === 'test', 'verificationMethod set')

  doc = applyChange(doc, {
    kind: 'UpdateAttribute',
    id,
    attr: 'verificationMethod',
    value: null,
  })
  r = getRequirement(doc, id)!
  expect(r.verificationMethod === undefined, 'verificationMethod cleared')
  console.log('  OK: verificationMethod set then cleared via null')

  // --- Step 5: null on a required attr throws --------------------------
  header('Step 5: null on a required attr throws')

  throws(
    () =>
      applyChange(doc, {
        kind: 'UpdateAttribute',
        id,
        attr: 'systemName',
        value: null,
      }),
    'Cannot null required attribute "systemName"',
    'null on systemName',
  )
  throws(
    () =>
      applyChange(doc, {
        kind: 'UpdateAttribute',
        id,
        attr: 'priority',
        value: null,
      }),
    'Cannot null required attribute "priority"',
    'null on priority',
  )

  // --- Step 6: AddRelationship is idempotent ---------------------------
  header('Step 6: AddRelationship is idempotent')

  const idChild = newId()
  doc = applyChange(doc, {
    kind: 'CreateRequirement',
    id: idChild,
    attrs: {
      patternType: 'ubiquitous',
      systemName: 'payments service',
      systemResponse: 'log every authorization attempt',
    },
  })
  doc = applyChange(doc, {
    kind: 'AddRelationship',
    from: id,
    relation: 'derives',
    to: idChild,
  })
  doc = applyChange(doc, {
    kind: 'AddRelationship',
    from: id,
    relation: 'derives',
    to: idChild,
  })
  doc = applyChange(doc, {
    kind: 'AddRelationship',
    from: id,
    relation: 'derives',
    to: idChild,
  })
  r = getRequirement(doc, id)!
  const derivesCount = r.derives.filter((t) => t === idChild).length
  expect(derivesCount === 1, `expected 1 derives edge, got ${derivesCount}`)
  console.log(`  OK: 3x AddRelationship -> 1 edge`)

  // --- Step 7: RemoveRelationship on missing edge is a no-op ----------
  header('Step 7: RemoveRelationship on missing edge is a no-op')

  const ghostId = newId()
  doc = applyChange(doc, {
    kind: 'RemoveRelationship',
    from: id,
    relation: 'derives',
    to: ghostId,
  })
  r = getRequirement(doc, id)!
  expect(r.derives.includes(idChild), 'existing edge survives a phantom remove')
  console.log('  OK: removing a non-existent edge did nothing')

  // --- Step 8: CreateRequirement on existing id throws ----------------
  header('Step 8: CreateRequirement on existing id throws')

  throws(
    () =>
      applyChange(doc, {
        kind: 'CreateRequirement',
        id,
        attrs: {
          patternType: 'ubiquitous',
          systemName: 'x',
          systemResponse: 'y',
        },
      }),
    'already exists',
    'duplicate create',
  )

  // --- Step 9: save + reload after a chain of changes ------------------
  header('Step 9: chain of changes survives save/reload')

  await saveDoc(doc, docPath)
  const reloaded = await loadDoc(docPath)
  const rReloaded = getRequirement(reloaded, id)!
  expect(rReloaded.priority === 'critical', 'priority persisted')
  expect(rReloaded.status === 'approved', 'status persisted')
  expect(rReloaded.verificationMethod === undefined, 'null clear persisted')
  expect(
    rReloaded.derives.includes(idChild) && rReloaded.derives.length === 1,
    'edges persisted (and still idempotent)',
  )
  expect(rReloaded.sentence.includes('$1 authorization hold'), 'latest sentence persisted')
  console.log('  OK: full reload matches in-memory state')

  // --- Step 10: concurrent edits on different attrs of same node ------
  header('Step 10: concurrent edits to different attrs of same node merge cleanly')

  // Two replicas of the reloaded state, each updates a distinct attr.
  const docA = await loadDoc(docPath)
  const docB = await loadDoc(docPath)
  const docAEdited = applyChange(docA, {
    kind: 'UpdateAttribute',
    id,
    attr: 'priority',
    value: 'high',
  })
  const docBEdited = applyChange(docB, {
    kind: 'UpdateAttribute',
    id,
    attr: 'status',
    value: 'implemented',
  })
  const merged = merge(docAEdited, docBEdited)
  const mergedR = getRequirement(merged, id)!
  expect(
    mergedR.priority === 'high' && mergedR.status === 'implemented',
    'both concurrent edits to different attrs survive merge',
  )
  console.log("  OK: priority='high' + status='implemented' both survive")

  // --- Step 11: concurrent edits to the SAME attr converge deterministically ---
  header('Step 11: concurrent edits to the SAME attr converge deterministically')

  const docC = await loadDoc(docPath)
  const docD = await loadDoc(docPath)
  const docCEdited = applyChange(docC, {
    kind: 'UpdateAttribute',
    id,
    attr: 'priority',
    value: 'low',
  })
  const docDEdited = applyChange(docD, {
    kind: 'UpdateAttribute',
    id,
    attr: 'priority',
    value: 'medium',
  })
  const m1 = merge(docCEdited, docDEdited)
  const m2 = merge(docDEdited, docCEdited)
  const p1 = getRequirement(m1, id)?.priority
  const p2 = getRequirement(m2, id)?.priority
  expect(p1 === p2, `merge order should not affect outcome: got ${p1} vs ${p2}`)
  expect(p1 === 'low' || p1 === 'medium', `merged value should be one of the inputs, got ${p1}`)
  console.log(
    `  OK: both merge orders converge to priority="${p1}" (one writer wins, deterministically)`,
  )

  // --- Step 12: final analysis pass should be clean -------------------
  header('Step 12: analysis is clean on the final state')

  const findings = analyze(merged)
  expect(
    findings.length === 0,
    `expected 0 findings, got ${findings.length}: ${JSON.stringify(findings)}`,
  )
  console.log('  OK: no findings')

  console.log('\nIncremental smoke test passed.\n')
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
