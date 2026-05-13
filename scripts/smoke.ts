/**
 * End-to-end smoke test.
 *
 * Scenario: two replicas of the same requirements document start from a
 * shared base, diverge with concurrent edits, then merge. We then run the
 * analysis pass to show that:
 *   - Automerge produces a deterministic merge with no manual conflict logic
 *   - the dangling-reference case (Alice adds an edge to a node Bob deletes)
 *     converges to a graph that contains the edge pointing at a missing node
 *   - the analysis pass surfaces the dangling edge as a finding
 *   - the SysML v2 export reflects the converged state
 *
 * This script doesn't use the CLI — it exercises the core directly to keep
 * the test self-contained and fast.
 */

import * as Automerge from '@automerge/automerge'
import { analyze, summarizeFindings } from '../src/core/analyze.js'
import { applyChange, emptyDoc, listRequirements, merge, newId, snapshot } from '../src/core/doc.js'
import { exportSysml } from '../src/core/sysml-export.js'

function header(s: string) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(s)
  console.log('='.repeat(60))
}

// --- Step 1: build a shared base doc with three requirements --------------
header('Step 1: build shared base doc')

let base = emptyDoc()
const idLogin = newId()
const idLockout = newId()
const idRateLimit = newId()

base = applyChange(base, {
  kind: 'CreateRequirement',
  id: idLogin,
  attrs: {
    patternType: 'event-driven',
    systemName: 'auth service',
    systemResponse: 'issue a session token',
    trigger: 'the user submits valid credentials',
    priority: 'high',
  },
})
base = applyChange(base, {
  kind: 'CreateRequirement',
  id: idLockout,
  attrs: {
    patternType: 'unwanted-behavior',
    systemName: 'auth service',
    systemResponse: 'lock the account for 15 minutes',
    trigger: 'five consecutive failed login attempts occur within 10 minutes',
    priority: 'high',
  },
})
base = applyChange(base, {
  kind: 'CreateRequirement',
  id: idRateLimit,
  attrs: {
    patternType: 'ubiquitous',
    systemName: 'auth service',
    systemResponse: 'rate-limit login attempts to 10 per minute per IP',
    priority: 'medium',
  },
})
base = applyChange(base, {
  kind: 'AddRelationship',
  from: idLockout,
  relation: 'refines',
  to: idRateLimit,
})

for (const r of listRequirements(base)) {
  console.log(`  ${r.id.slice(0, 8)}  ${r.sentence}`)
}

// --- Step 2: fork into two replicas ---------------------------------------
header('Step 2: fork into Alice and Bob')

// Alice's replica
let alice = Automerge.clone(base)
// Bob's replica
let bob = Automerge.clone(base)

console.log('Both replicas start from the same base.')

// --- Step 3: concurrent edits --------------------------------------------
header('Step 3: concurrent edits')

// Alice: adds a new requirement (MFA) and a derives edge from login to MFA.
const idMfa = newId()
alice = applyChange(alice, {
  kind: 'CreateRequirement',
  id: idMfa,
  attrs: {
    patternType: 'state-driven',
    systemName: 'auth service',
    systemResponse: 'require a second factor',
    preCondition: 'the user has MFA enabled on their account',
    priority: 'high',
  },
})
alice = applyChange(alice, {
  kind: 'AddRelationship',
  from: idLogin,
  relation: 'derives',
  to: idMfa,
})
// Alice also adds an edge from login to the rate-limit requirement.
alice = applyChange(alice, {
  kind: 'AddRelationship',
  from: idLogin,
  relation: 'derives',
  to: idRateLimit,
})

console.log('Alice:')
console.log(`  + created MFA requirement (${idMfa.slice(0, 8)})`)
console.log(`  + ${idLogin.slice(0, 8)} -derives-> ${idMfa.slice(0, 8)}`)
console.log(`  + ${idLogin.slice(0, 8)} -derives-> ${idRateLimit.slice(0, 8)}`)

// Bob: concurrently deletes the rate-limit requirement (deciding it's
// covered by an infra-level policy instead). Bob doesn't know Alice just
// added an edge pointing at it.
bob = applyChange(bob, { kind: 'DeleteRequirement', id: idRateLimit })
// Bob also updates the lockout duration.
bob = applyChange(bob, {
  kind: 'UpdateAttribute',
  id: idLockout,
  attr: 'systemResponse',
  value: 'lock the account for 30 minutes',
})

console.log('\nBob:')
console.log(`  - deleted rate-limit requirement (${idRateLimit.slice(0, 8)})`)
console.log(`  ~ updated lockout duration to 30 minutes`)

// --- Step 4: merge -------------------------------------------------------
header('Step 4: automatic CRDT merge')

const merged = merge(alice, bob)
console.log('Merged. No manual conflict resolution needed.\n')
for (const r of listRequirements(merged)) {
  console.log(`  ${r.id.slice(0, 8)}  ${r.sentence}`)
  const outbound = [
    ...r.derives.map((t) => `derives->${t.slice(0, 8)}`),
    ...r.satisfies.map((t) => `satisfies->${t.slice(0, 8)}`),
    ...r.verifies.map((t) => `verifies->${t.slice(0, 8)}`),
    ...r.refines.map((t) => `refines->${t.slice(0, 8)}`),
  ]
  if (outbound.length) console.log(`           edges: ${outbound.join(', ')}`)
}

// --- Step 5: analysis pass ----------------------------------------------
header('Step 5: analysis pass')

const findings = analyze(merged)
console.log(summarizeFindings(findings))

// Strong assertion: we *expect* a dangling-reference finding for the edge
// Alice added to the node Bob deleted.
const dangling = findings.find(
  (f) => f.kind === 'DanglingReference' && f.from === idLogin && f.to === idRateLimit,
)
if (!dangling) {
  console.error('\nFAIL: expected a DanglingReference finding for the deleted rate-limit edge')
  process.exit(1)
}
console.log('\nOK: dangling-reference correctly surfaced.')

// --- Step 6: SysML export ----------------------------------------------
header('Step 6: SysML v2-flavored export (truncated)')

const sysml = exportSysml(merged)
console.log(`elements:      ${sysml.elements.length}`)
console.log(`relationships: ${sysml.relationships.length}`)
console.log('\nFirst element:')
console.log(JSON.stringify(sysml.elements[0], null, 2))
console.log('\nFirst relationship:')
console.log(JSON.stringify(sysml.relationships[0], null, 2))

// --- Step 7: convergence check -----------------------------------------
header('Step 7: convergence check')

// Re-merge in the opposite order; should produce equivalent state.
const mergedReverse = merge(bob, alice)
const snapA = snapshot(merged)
const snapB = snapshot(mergedReverse)

const aKeys = Object.keys(snapA.requirements).sort()
const bKeys = Object.keys(snapB.requirements).sort()
if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) {
  console.error('FAIL: merge order changed the set of requirements')
  process.exit(1)
}
console.log('OK: merge(alice, bob) and merge(bob, alice) produce the same set of requirements.')

console.log('\nSmoke test passed.\n')
