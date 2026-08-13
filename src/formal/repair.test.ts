/**
 * REPAIR COMMANDS ARE INVOCATIONS — the audit gate.
 *
 * `repair.commands` is the one field the agent contract says to run VERBATIM (see the
 * `repair.ts` header, and `AGENTS.md`'s core loop). That makes an unrunnable command a
 * worse failure than a missing one: the shell prints usage and exits 0, so the agent
 * concludes the repair applied, re-checks, finds nothing moved, and cannot distinguish
 * that from a repair that was a legitimate no-op. The movement signal — the thing the
 * whole loop branches on — reads as "your approach is wrong" when the truth is "the
 * command you were handed does not exist".
 *
 * Three of the discharges reach an agent through the FROZEN vendored tier's finding
 * messages, which spell them `glossary add` / `antonym add` / `waive add`. That is
 * `import`'s v2 op-stream side-table grammar, not a CLI invocation: every one of those
 * operations takes its arguments as positionals, so `add` binds to the first positional
 * and the command fails. The messages cannot be edited, so `repair.ts` normalizes on
 * read, and this file is what keeps that true as messages are added.
 *
 * The sweep is deliberately STATIC and whole-tree rather than driven off a live `check`.
 * A run-driven test only covers the messages that run's document happens to raise, and
 * the failure mode here is a NEW message nobody thought to exercise.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CheckFinding, CoverageDemotion } from '../donor/pipeline/check.ts'
import { allCodes, lookupCode } from '../kernel/catalog.ts'
import { runnable } from '../kernel/command-form.ts'
import { allOperations } from '../operations/index.ts'
import { type RepairContext, repairForDemotion } from './repair.ts'

const REPO_ROOT = new URL('../..', import.meta.url).pathname

/** Every operation name the CLI actually registers. */
const OPERATIONS = new Set(allOperations().map((op) => op.name))

/**
 * The bare verbs a nested-subcommand spelling would use.
 *
 * The surface is FLAT — every operation is `symspec <op>` with flags and positionals,
 * and none has a nested verb — so a second word from this set is the signature of the
 * `import`-grammar confusion rather than a positional an operation wants.
 */
const NESTED_VERBS = new Set(['add', 'remove', 'list', 'set'])

/**
 * Assert one command string is something a shell could run against this CLI.
 *
 * Returns the reason it is not, or `undefined` when it is fine, so a failing sweep can
 * report every offender at once instead of dying on the first.
 */
const invalidReason = (command: string): string | undefined => {
  // An env-var prefix is legitimate (`SYMSPEC_EMBED_ALLOW_REMOTE=1 symspec check …`).
  const words = command.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*/, '').split(/\s+/)
  if (words[0] !== 'symspec') return `does not start with \`symspec\`: ${command}`
  const operation = words[1]
  if (operation === undefined) return `names no operation: ${command}`
  if (!OPERATIONS.has(operation)) return `names an operation the tool lacks: ${command}`
  const next = words[2]
  if (next !== undefined && NESTED_VERBS.has(next)) {
    return `spells a nested subcommand the flat surface has no parser for: ${command}`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The normalizer, on the exact strings the frozen tier emits
// ---------------------------------------------------------------------------

describe('the nested-verb spelling is rewritten to the positional form', () => {
  it.each([
    ['symspec glossary add "complete the infusion" "run the infusion"'],
    ['symspec antonym add start halt'],
    ['symspec waive add FND_OPPOSITION_CANDIDATE --reason "triaged"'],
  ])('rewrites %s', (command) => {
    expect(invalidReason(command)).toBeDefined()
    expect(invalidReason(runnable(command))).toBeUndefined()
  })

  it('preserves quoting and every following flag', () => {
    expect(runnable('symspec waive add GTWR_R7_VAGUE --ref abc --reason "reviewed: fine"')).toBe(
      'symspec waive GTWR_R7_VAGUE --ref abc --reason "reviewed: fine"',
    )
    expect(runnable('symspec glossary add "issue a token" "mint a token"')).toBe(
      'symspec glossary "issue a token" "mint a token"',
    )
  })

  it('leaves a POSITIONAL second word alone', () => {
    // `check` takes an optional file positional, so a blanket "drop the second word"
    // rule would silently retarget the run at the default document. This is the case
    // that makes the rewrite an allowlist rather than a general strip.
    for (const command of [
      'symspec check ./requirements.json',
      'symspec show 7d095571 ./requirements.json',
      'symspec list ./requirements.json',
      'symspec check ./requirements.json --solver-budget-ms 10000',
    ]) {
      expect(runnable(command)).toBe(command)
    }
  })

  it('does not invent a rewrite for an operation that has no nested spelling', () => {
    // `add` IS an operation. `symspec add …` must survive untouched — the regex keys on
    // the OPERATION being one of the three side tables, not on the word `add` appearing.
    expect(runnable('symspec add --pattern-type ubiquitous')).toBe(
      'symspec add --pattern-type ubiquitous',
    )
  })
})

// ---------------------------------------------------------------------------
// Every command a repair emits, across every demotion reason
// ---------------------------------------------------------------------------

/**
 * A finding whose message carries the frozen tier's own spelling, verbatim.
 *
 * Copied from `donor/formal/quantity-alias.ts` and `donor/formal/semantic.ts` rather
 * than paraphrased: the point is to prove the boundary handles what those files really
 * produce, and a paraphrase would prove only that it handles this test.
 */
const findingWith = (code: string, message: string): CheckFinding => ({
  code,
  severity: 'info',
  tier: 'formal',
  requirementIds: ['req-a', 'req-b'],
  message,
})

const QUANTITY_ALIAS_MESSAGE =
  'req-a and req-b place opposed numeric bounds (within 30 minutes vs at least 60 minutes) ' +
  'under the same system and trigger, on quantities that share the object "infusion" but ' +
  'differ in their leading verb ("complete the infusion" vs "run the infusion"), so they ' +
  'atomized to different quantity keys and were never compared. If both bounds constrain ' +
  'the SAME physical quantity, run `symspec glossary add "complete the infusion" ' +
  '"run the infusion"` so the numeric tier keys them together and can prove any conflict, ' +
  'then re-run `symspec check`. If they are genuinely different quantities, waive this ' +
  'finding. This is a suggestion, not a verdict.'

const OPPOSITION_MESSAGE =
  'req-a and req-b share the object phrase but differ on the leading verb ("start" vs ' +
  '"halt"). If they are polar OPPOSITES, run `symspec antonym add start halt` (the formal ' +
  'tier then collapses them to one atom at opposite polarity); if they are SYNONYMS, run ' +
  '`symspec glossary add "start the pump" "halt the pump"` instead. Committing the wrong ' +
  'one MANUFACTURES a false contradiction.'

/** Every reason in the donor union, so a new one cannot slip past this sweep. */
const EVERY_REASON: readonly CoverageDemotion['reason'][] = [
  'uncovered-requirement',
  'open-opposition-candidate',
  'no-decide-tier-comparison',
  'semantic-tier-skipped',
  'excluded-from-formal',
  'quantity-alias-candidate',
  'relational-reasoning-not-attempted',
  'solver-budget-exhausted',
]

const CONTEXT: RepairContext = {
  exclusionsById: new Map([
    [
      'req-a',
      {
        reason: 'blocking-finding',
        findings: [findingWith('GTWR_R7_VAGUE', 'vague')],
      } as never,
    ],
  ]),
  findings: [
    findingWith('FND_QUANTITY_ALIAS_CANDIDATE', QUANTITY_ALIAS_MESSAGE),
    findingWith('FND_OPPOSITION_CANDIDATE', OPPOSITION_MESSAGE),
  ],
  docPath: './requirements.json',
  solverBudgetMs: 2_000,
}

describe('every command a repair emits is a real invocation', () => {
  it.each(EVERY_REASON)('for reason %s', (reason) => {
    const repair = repairForDemotion(
      { reason, requirementIds: ['req-a', 'req-b'], action: 'irrelevant here' } as CoverageDemotion,
      CONTEXT,
    )
    const bad = repair.commands.map(invalidReason).filter((r) => r !== undefined)
    expect(bad).toEqual([])
  })

  it('emits the vocabulary discharge in the RUNNABLE form, not the import grammar', () => {
    const repair = repairForDemotion(
      {
        reason: 'quantity-alias-candidate',
        requirementIds: ['req-a', 'req-b'],
        action: 'irrelevant here',
      } as CoverageDemotion,
      CONTEXT,
    )
    // The whole point of the fix, asserted on the command an agent copies first.
    expect(repair.commands).toContain('symspec glossary "complete the infusion" "run the infusion"')
    expect(repair.commands.join('\n')).not.toContain('glossary add')
  })

  it('keeps BOTH alternatives for an opposition candidate, both runnable', () => {
    const repair = repairForDemotion(
      {
        reason: 'open-opposition-candidate',
        requirementIds: ['req-a', 'req-b'],
        action: 'irrelevant here',
      } as CoverageDemotion,
      CONTEXT,
    )
    // Normalizing must not collapse the two mutually-exclusive remedies into one —
    // the finding offers both precisely because embeddings cannot tell which applies.
    expect(repair.commands).toContain('symspec antonym start halt')
    expect(repair.commands).toContain('symspec glossary "start the pump" "halt the pump"')
  })
})

// ---------------------------------------------------------------------------
// THE AUDIT — every command literal anywhere in the tree
// ---------------------------------------------------------------------------

/**
 * Sweep every `symspec …` command literal in the source tree, normalize it, and assert
 * the result is an invocation.
 *
 * This is the test that generalizes the fix. The three known offenders were found by
 * running the tool; this finds the fourth before anyone runs it. Placeholder angle
 * brackets (`<verbA>`, `<canonical>`) are kept in scope — a placeholder is a separate
 * defect class the `repair.ts` header already covers, and one this sweep is happy to
 * see, because a placeholder that is ALSO a nested verb is the worst of both.
 */
describe('every catalog `commands` entry is a real invocation', () => {
  // `explain` and `manifest` publish this field to an agent that does not recognise a
  // code. Swept across ALL codes rather than the two that happen to carry a nested verb
  // today, because the next appended description is the one nobody checks.
  it.each(
    allCodes()
      .filter((c) => c.commands.length > 0)
      .map((c) => c.code),
  )('%s', (code) => {
    const entry = lookupCode(code)
    const bad = (entry?.commands ?? [])
      .map((c) => invalidReason(c.replace(/<[^>]*>/g, 'PLACEHOLDER')))
      .filter((r) => r !== undefined)
    expect(bad).toEqual([])
  })
})

describe('no source file spells a command the CLI cannot run', () => {
  const FILES = [
    'src/donor/formal/quantity-alias.ts',
    'src/donor/formal/semantic.ts',
    'src/donor/pipeline/check.ts',
    'src/kernel/craft.ts',
    'src/kernel/scope.ts',
    'src/formal/repair.ts',
    'src/formal/glossary-plan.ts',
    'src/operations/propose-glossary.ts',
    'src/operations/check.ts',
    'src/operations/mutation.ts',
  ]

  it.each(FILES)('%s', (relative) => {
    const source = readFileSync(join(REPO_ROOT, relative), 'utf8')
    const offenders: string[] = []
    for (const match of source.matchAll(/`(symspec [a-z][^`$]*?)`/g)) {
      // A trailing backslash is the source's ESCAPED closing backtick inside a template
      // literal, not part of the command.
      const command = match[1]?.replace(/\\$/, '').trim()
      if (command === undefined || command === '') continue
      // Strip a placeholder tail so `symspec waive <blocking-code>` is judged on its
      // operation rather than on the angle brackets.
      const reason = invalidReason(runnable(command).replace(/<[^>]*>/g, 'PLACEHOLDER'))
      if (reason !== undefined) offenders.push(reason)
    }
    expect([...new Set(offenders)]).toEqual([])
  })
})
