/**
 * Public entry for the NL parse ladder.
 *
 * v2 wave 1 ships Tier 1 (the zero-dependency regex cascade, AC-2-1) and
 * preprocessing (AC-2-5). Later waves add the Tier-2 wink-nlp escalation
 * (T-AC-2-6), the Tier-3 error envelope (T-AC-2-7), and the `ParseResult`
 * discriminated union (T-AC-2-8), re-exported through this barrel as they land.
 */

export type {
  Confidence,
  Tier1Miss,
  Tier1Ok,
  Tier1Result,
  Tier1Slots,
} from './tier1.js'
export {
  classifyTier1,
  KW,
  MAIN,
  preprocess,
  systemEscalationNotes,
} from './tier1.js'
export type {
  EscalationTrigger,
  Tier2Loader,
  Tier2Miss,
  Tier2Ok,
  Tier2Options,
  Tier2Outcome,
  Tier2Result,
  WinkAnalyzer,
  WinkToken,
} from './tier2.js'
export {
  defaultTier2Loader,
  ESCALATION_TRIGGERS,
  escalationTriggers,
  MAX_TIER1_TOKENS,
  repairWithWink,
  runTier2,
} from './tier2.js'
