/**
 * Solver-layer smoke test.
 *
 * Strategy:
 *   - Build a small graph with deliberately planted issues:
 *       * an exact duplicate pair (free tier catches)
 *       * a contradiction pair (same trigger, opposite response — free tier
 *         flags as candidate, LLM tier judges as contradiction)
 *       * a subsumption pair (preconditions overlap — flagged, LLM judges)
 *       * a weasel-word case (free tier catches "as needed")
 *       * a clean baseline pair (no flags)
 *   - Run with a *mocked* CallModel that returns deterministic judgments
 *     keyed by (modelId, requirement pair). This lets us assert the ensemble
 *     logic without hitting Bedrock.
 *   - If BEDROCK_LIVE=1 is set in env, swap in the real bedrock client.
 */

import { applyChange, emptyDoc, newId } from '../src/core/doc.js'
import { runSolvers, summarize } from '../src/solvers/index.js'
import type { CallArbiter } from '../src/solvers/llm/arbiter.js'
import { ARBITER, bedrockArbiter } from '../src/solvers/llm/arbiter.js'
import type { CallModel } from '../src/solvers/llm/bedrock-client.js'
import { bedrockCallModel, MODELS } from '../src/solvers/llm/bedrock-client.js'

function header(s: string) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(s)
  console.log('='.repeat(60))
}

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

// --- Build the test graph -------------------------------------------------
header('Build seed graph with planted issues')

let doc = emptyDoc()

const idLoginOk = newId()
const idLoginOkDup = newId() // EXACT DUPLICATE of idLoginOk
const idLoginRejectA = newId()
const idLoginRejectB = newId() // CONTRADICTS LoginRejectA (same trigger, opposite response)
const idMfaWide = newId()
const idMfaNarrow = newId() // SUBSUMED by MfaWide (overlapping precondition)
const idWeasel = newId() // contains "as needed"
const idClean = newId()

const seed = [
  {
    id: idLoginOk,
    attrs: {
      patternType: 'event-driven' as const,
      systemName: 'auth service',
      systemResponse: 'issue a session token',
      trigger: 'the user submits valid credentials',
      priority: 'high' as const,
    },
  },
  {
    id: idLoginOkDup,
    attrs: {
      // Same tuple as idLoginOk — should be caught by free.exact-duplicate.
      patternType: 'event-driven' as const,
      systemName: 'auth service',
      systemResponse: 'issue a session token',
      trigger: 'the user submits valid credentials',
      priority: 'high' as const,
    },
  },
  {
    id: idLoginRejectA,
    attrs: {
      patternType: 'unwanted-behavior' as const,
      systemName: 'auth service',
      systemResponse: 'lock the account for 15 minutes',
      trigger: 'five consecutive failed logins occur within 10 minutes',
      priority: 'high' as const,
    },
  },
  {
    id: idLoginRejectB,
    attrs: {
      // Same trigger as idLoginRejectA, opposite response → contradiction candidate.
      patternType: 'unwanted-behavior' as const,
      systemName: 'auth service',
      systemResponse: 'allow the next login attempt without delay',
      trigger: 'five consecutive failed logins occur within 10 minutes',
      priority: 'high' as const,
    },
  },
  {
    id: idMfaWide,
    attrs: {
      patternType: 'state-driven' as const,
      systemName: 'auth service',
      systemResponse: 'require a second factor',
      preCondition: 'the user has MFA enabled',
      priority: 'high' as const,
    },
  },
  {
    id: idMfaNarrow,
    attrs: {
      // Overlapping preCondition; more specific (admin users only).
      patternType: 'state-driven' as const,
      systemName: 'auth service',
      systemResponse: 'require a hardware second factor',
      preCondition: 'the user has MFA enabled and the user is an admin',
      priority: 'high' as const,
    },
  },
  {
    id: idWeasel,
    attrs: {
      patternType: 'event-driven' as const,
      systemName: 'audit log',
      systemResponse: 'redact PII as needed',
      trigger: 'a record is written',
      priority: 'medium' as const,
    },
  },
  {
    id: idClean,
    attrs: {
      patternType: 'ubiquitous' as const,
      systemName: 'metrics service',
      systemResponse: 'emit a heartbeat once per minute',
      priority: 'low' as const,
    },
  },
]

for (const s of seed) {
  doc = applyChange(doc, { kind: 'CreateRequirement', id: s.id, attrs: s.attrs })
}
console.log(`Seeded ${seed.length} requirements.`)

// --- Free-tier-only run ---------------------------------------------------
header('Free-tier-only solver run (no LLM)')

const free = await runSolvers(doc)
console.log(summarize(free))

expect(
  free.findings.some((f) => f.kind === 'ExactDuplicate' && f.ids.includes(idLoginOk)),
  'free tier should catch the exact-duplicate pair',
)
expect(
  free.findings.some(
    (f) => f.kind === 'Ambiguity' && f.source === 'free.weasel-words' && f.id === idWeasel,
  ),
  "free tier should catch the 'as needed' weasel word",
)

const contradictionFlagged = free.candidatePairs.some(
  (p) =>
    p.reason === 'same-system-same-trigger-different-response' &&
    ((p.a === idLoginRejectA && p.b === idLoginRejectB) ||
      (p.a === idLoginRejectB && p.b === idLoginRejectA)),
)
expect(
  contradictionFlagged,
  'free tier should flag the contradicting pair as a candidate for LLM follow-up',
)
const subsumptionFlagged = free.candidatePairs.some(
  (p) =>
    p.reason === 'same-system-overlapping-precondition' &&
    ((p.a === idMfaWide && p.b === idMfaNarrow) || (p.a === idMfaNarrow && p.b === idMfaWide)),
)
expect(subsumptionFlagged, 'free tier should flag the overlapping-precondition pair as a candidate')
console.log('\nOK: free tier flagged the expected cases.')

// --- LLM-tier mocked ensemble run -----------------------------------------
header('LLM-tier ensemble (mocked) — verifies the orchestration')

const LIVE = process.env.BEDROCK_LIVE === '1'
console.log(
  LIVE
    ? `Live mode: hitting Bedrock with ${MODELS.primary} + ${MODELS.secondary}`
    : 'Mocked mode: returning deterministic judgments without calling Bedrock',
)

const mockCall: CallModel = async (args) => {
  // The mock returns shaped output based on the user prompt's content.
  // It deliberately makes the two models *agree* on the contradiction and
  // *disagree* on the subsumption — so we can verify both code paths.
  const prompt = args.userPrompt
  const isPair = args.toolName === 'report_pair_judgment'
  const isAmbiguity = args.toolName === 'report_ambiguity'

  if (isPair) {
    const aMatch = prompt.match(/Requirement A \(id=([^)]+)\)/)
    const bMatch = prompt.match(/Requirement B \(id=([^)]+)\)/)
    const aId = aMatch?.[1] ?? ''
    const bId = bMatch?.[1] ?? ''
    const involves = (id1: string, id2: string) =>
      (aId === id1 && bId === id2) || (aId === id2 && bId === id1)

    if (involves(idLoginRejectA, idLoginRejectB)) {
      // Both models say contradiction → high-confidence Contradiction finding.
      return {
        output: {
          judgment: 'contradiction',
          whichOf: null,
          confidence: 'high',
          rationale: 'Same trigger leads to opposite system responses (lock vs allow).',
        },
      }
    }
    if (involves(idMfaWide, idMfaNarrow)) {
      // Make the two models disagree to exercise NeedsReview.
      const isPrimary = args.modelId === MODELS.primary
      return {
        output: {
          judgment: isPrimary ? 'subsumption' : 'compatible',
          whichOf: isPrimary ? 'a' : null,
          confidence: 'medium',
          rationale: isPrimary
            ? 'Narrower precondition; admin is a special case of MFA-enabled.'
            : 'Different responses (hardware vs any second factor); separate requirements.',
        },
      }
    }
    // Default: compatible.
    return {
      output: {
        judgment: 'compatible',
        whichOf: null,
        confidence: 'high',
        rationale: 'No conflict between these requirements.',
      },
    }
  }

  if (isAmbiguity) {
    const idMatch = prompt.match(/Requirement \(id=([^)]+)\)/)
    const id = idMatch?.[1] ?? ''
    // Pretend both models flag the clean req as ambiguous to test the agreement path,
    // and idLoginRejectA as not ambiguous on either side.
    if (id === idClean) {
      return {
        output: {
          ambiguous: true,
          phrases: ['once per minute'],
          suggestedRewrites: ['at intervals of exactly 60 seconds ±1 second'],
          rationale: "'once per minute' is ambiguous about jitter tolerance.",
        },
      }
    }
    return {
      output: {
        ambiguous: false,
        phrases: [],
        suggestedRewrites: [],
        rationale: 'Slots are concrete enough.',
      },
    }
  }
  throw new Error(`Unhandled tool ${args.toolName} in mock`)
}

// First pass: ensemble with NO arbiter — should emit NeedsReview on the disagreement.
const reportNoArbiter = await runSolvers(doc, {
  llm: {
    call: LIVE ? bedrockCallModel : mockCall,
    primaryModelId: MODELS.primary,
    secondaryModelId: MODELS.secondary,
  },
  maxLlmPairs: 50,
})

console.log(summarize(reportNoArbiter))

if (!LIVE) {
  expect(
    reportNoArbiter.findings.some(
      (f) =>
        f.kind === 'Contradiction' &&
        f.source === 'llm.pair-judge' &&
        f.confidence === 'high' &&
        f.ids.includes(idLoginRejectA) &&
        f.ids.includes(idLoginRejectB),
    ),
    'ensemble should emit a high-confidence Contradiction for the agreed pair',
  )
  expect(
    reportNoArbiter.findings.some(
      (f) =>
        f.kind === 'NeedsReview' &&
        f.source === 'llm.pair-judge' &&
        f.ids.includes(idMfaWide) &&
        f.ids.includes(idMfaNarrow),
    ),
    'ensemble should emit NeedsReview when the two models disagree (no arbiter)',
  )
}

// --- Third tier: arbiter run --------------------------------------------
header('Arbiter pass (Claude Opus 4.7 via InvokeModel + extended thinking) — resolves disagreement')

console.log(
  LIVE
    ? `Live arbiter: ${ARBITER.modelId} with effort=${ARBITER.effort}, max_tokens=${ARBITER.maxTokens}`
    : `Mocked arbiter: deterministic verdict resolving the MfaWide/MfaNarrow disagreement`,
)

const mockArbiter: CallArbiter = async (input) => {
  // The mock returns a fixed verdict for the MfaWide/MfaNarrow pair so we can
  // assert the ensemble correctly replaces NeedsReview with a Subsumption finding.
  const ids = [input.a.id, input.b.id]
  if (ids.includes(idMfaWide) && ids.includes(idMfaNarrow)) {
    // The "wide" requirement is the more general one. whichOf is relative to
    // input.a/input.b, so we figure out which letter the wide one is.
    const whichOf = input.a.id === idMfaWide ? 'a' : 'b'
    return {
      finalJudgment: 'subsumption',
      whichOf,
      confidence: 'high',
      agreedWith: 'primary',
      rationale:
        "The preCondition of B ('MFA enabled AND admin') is strictly stronger than A's ('MFA enabled'), and B's response is a refinement of A's (hardware second factor is a specific second factor). Therefore A is the more general requirement and B is a special case.",
      caveat:
        "Holds only if 'second factor' in A is interpreted permissively to include hardware factors.",
    }
  }
  throw new Error(
    `mockArbiter: unexpected pair ${ids.join(',')} — should only be invoked on the disagreed pair`,
  )
}

const reportWithArbiter = await runSolvers(doc, {
  llm: {
    call: LIVE ? bedrockCallModel : mockCall,
    primaryModelId: MODELS.primary,
    secondaryModelId: MODELS.secondary,
    arbiter: LIVE ? bedrockArbiter : mockArbiter,
  },
  maxLlmPairs: 50,
})

console.log(summarize(reportWithArbiter))

if (!LIVE) {
  // The contradiction finding should still be present (no disagreement → arbiter not invoked).
  expect(
    reportWithArbiter.findings.some(
      (f) =>
        f.kind === 'Contradiction' &&
        f.source === 'llm.pair-judge' &&
        f.confidence === 'high' &&
        f.ids.includes(idLoginRejectA) &&
        f.ids.includes(idLoginRejectB),
    ),
    'Contradiction finding should survive when arbiter is configured',
  )
  // The previously-NeedsReview pair should now be a high-confidence Subsumption.
  const arbitrated = reportWithArbiter.findings.find(
    (f) =>
      f.kind === 'Subsumption' &&
      f.source === 'llm.pair-judge' &&
      f.moreGeneral === idMfaWide &&
      f.moreSpecific === idMfaNarrow,
  )
  expect(arbitrated, 'arbiter should resolve the MfaWide/MfaNarrow pair as Subsumption')
  expect(
    arbitrated && arbitrated.kind === 'Subsumption' && arbitrated.confidence === 'high',
    'arbiter verdict should be high-confidence (matches the mock verdict)',
  )
  // No NeedsReview should remain for that pair.
  const stillNeedsReview = reportWithArbiter.findings.some(
    (f) => f.kind === 'NeedsReview' && f.ids.includes(idMfaWide) && f.ids.includes(idMfaNarrow),
  )
  expect(!stillNeedsReview, 'arbiter should replace the NeedsReview entry, not augment it')
  // The ambiguity-driven Ambiguity finding on idClean should still be present.
  expect(
    reportWithArbiter.findings.some(
      (f) =>
        f.kind === 'Ambiguity' &&
        f.source === 'llm.ambiguity-judge' &&
        f.confidence === 'high' &&
        f.id === idClean,
    ),
    'Ambiguity finding survives the arbiter pass',
  )
}

console.log('\nSolver smoke test passed.\n')
