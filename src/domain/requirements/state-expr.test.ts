/**
 * THE STATE-EXPRESSION LANGUAGE — parser, sort checker, and the V14/V21 front door.
 *
 * ## What this file is actually guarding
 *
 * Not "the parser parses". The load-bearing claim is narrower and much more
 * consequential: **no expression carrying an undeclared reference can survive
 * validation**, because the failure mode downstream is not a wrong answer, it is an
 * unkillable WASM hang (v4 findings V14/V21, reproduced on both z3 4.16.0 and
 * 5.0.0). `interruptibleSolve` is the escape from that hang; this module is the reason
 * the escape should never be needed.
 *
 * So the tests below are organised around what must be REFUSED, and the refusal cases
 * outnumber the acceptance cases roughly two to one. That ratio is deliberate.
 *
 * ## Sort checking is tested by CONSTRUCTION, not by example
 *
 * A hand-written checker's failure mode is a coercion nobody asked for: `lock_held + 1`
 * quietly meaning `1 + 1`, or `retry_count and pending` quietly meaning `true and
 * pending`. Each of those is tested as a REFUSAL naming the offending sort, because a
 * checker that accepts them would still pass every positive test.
 */

import { describe, expect, it } from 'vitest'
import type { StateModel, StateVariable } from './document.ts'
import {
  COMPARE_OPS,
  declaredVars,
  type ExprError,
  isExprError,
  parseEffect,
  parseExpression,
  RESERVED_WORDS,
  readsOf,
  referencedNames,
  sortOf,
  touchedByEffect,
  validateEffect,
  validateExpression,
  writesOf,
} from './state-expr.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const boolVar = (name: string): StateVariable => ({ name, type: 'bool', frame: 'volatile' })
const intVar = (name: string, min?: number, max?: number): StateVariable => ({
  name,
  type: 'int',
  frame: 'volatile',
  ...(min !== undefined || max !== undefined
    ? {
        domain: {
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
        },
      }
    : {}),
})
const enumVar = (name: string, domain: readonly string[]): StateVariable => ({
  name,
  type: 'enum',
  frame: 'volatile',
  domain: [...domain],
})

/** The model every case below resolves against: one of each sort. */
const MODEL: StateModel = {
  variables: [
    boolVar('lock_held'),
    boolVar('pending'),
    intVar('retry_count', 0, 5),
    enumVar('run_state', ['PENDING', 'RUNNING', 'DONE', 'FAILED']),
  ],
}

const EMPTY: StateModel = { variables: [] }

/**
 * The error of a validation that must have failed. Throws (rather than asserting) when
 * it unexpectedly succeeded, so a mistake here reads as a test bug and not as a
 * confusing assertion on `undefined`.
 *
 * Returns the full {@link ExprError} — including the optional `offset` — rather than a
 * narrowed `{error, suggestions}` shape. Spelling the return type by hand dropped
 * `offset` and made the two lexical-position assertions a type error, which is the
 * useful kind of small mistake: the helper's type is the contract those cases read
 * through, so it has to be the real one.
 */
const errorOf = (result: unknown): ExprError => {
  if (!isExprError(result)) {
    throw new Error(`expected a failure, got: ${JSON.stringify(result)}`)
  }
  return result
}

// ---------------------------------------------------------------------------
// 1. THE FRONT DOOR — undeclared references are refused
// ---------------------------------------------------------------------------

describe('undeclared references are refused at AUTHORING time (V14/V21)', () => {
  /**
   * THE headline guard of this module.
   *
   * v4 measured what happens when something undeclared reaches the Fixedpoint:
   * a query that runs past 45s with no JS-side recovery, on both 4.16.0 and 5.0.0. The
   * mitigation is that the encoder is never handed one — and that is only true if
   * validation refuses every route in.
   */
  it('refuses an undeclared variable in a constraint, naming the declared ones', () => {
    const result = errorOf(validateExpression('typo_var = true', MODEL, 'constraint'))
    expect(result.error).toContain('typo_var')
    expect(result.error).toContain('not a declared state variable')
    // The declared names are LISTED, which is what makes the failure mechanically
    // fixable: the commonest cause is a typo or a case difference.
    expect(result.suggestions.join(' ')).toContain('lock_held')
    expect(result.suggestions.join(' ')).toContain('retry_count')
    // And the reason is stated, so a future reader does not "simplify" the check away.
    expect(result.suggestions.join(' ')).toMatch(/V14\/V21|hang/)
  })

  it('refuses an undeclared ASSIGNMENT TARGET in an effect', () => {
    const result = errorOf(validateEffect('typo_var := true', MODEL))
    expect(result.error).toContain('typo_var')
    expect(result.error).toContain('not a declared state variable')
  })

  it('refuses an undeclared variable on the READ side of an effect', () => {
    // The target resolves, the value does not. A checker that only validated targets
    // would accept this and hand the encoder an unresolvable name.
    const result = errorOf(validateEffect('retry_count := ghost_count + 1', MODEL))
    expect(result.error).toContain('ghost_count')
  })

  it('refuses every undeclared reference in a document with NO declared variables', () => {
    const result = errorOf(validateExpression('lock_held = true', EMPTY, 'constraint'))
    expect(result.error).toContain('lock_held')
    // The suggestion is the DECLARING command, not a list of nothing.
    expect(result.suggestions.join(' ')).toContain('symspec state')
  })

  it('refuses an enum member that is not in the declared domain, listing the domain', () => {
    const result = errorOf(validateExpression('run_state = CANCELLED', MODEL, 'constraint'))
    expect(result.error).toContain('CANCELLED')
    expect(result.error).toContain('run_state')
    const joined = result.suggestions.join(' ')
    expect(joined).toContain('PENDING')
    expect(joined).toContain('FAILED')
  })

  it('refuses a member of ANOTHER enum`s domain — sorts are per-variable', () => {
    const twoEnums: StateModel = {
      variables: [
        enumVar('run_state', ['PENDING', 'DONE']),
        enumVar('lock_state', ['FREE', 'TAKEN']),
      ],
    }
    // `TAKEN` is a real member — of the wrong variable. Accepting it would let a typo
    // silently compare across two unrelated state spaces.
    const result = errorOf(validateExpression('run_state = TAKEN', twoEnums, 'constraint'))
    expect(result.error).toContain('TAKEN')
    expect(result.error).toContain('run_state')
  })
})

// ---------------------------------------------------------------------------
// 2. Sorts are CHECKED, never coerced
// ---------------------------------------------------------------------------

describe('sort checking refuses the coercions a lenient checker would invent', () => {
  it.each([
    // [source, the substring the message must name]
    ['lock_held + 1 = 2', 'Arithmetic'],
    ['retry_count and pending', 'boolean'],
    ['not retry_count', 'boolean'],
    ['lock_held = 3', 'Cannot compare'],
    ['retry_count = true', 'Cannot compare'],
    ['run_state = 2', 'Cannot compare'],
    ['run_state + 1 = PENDING', 'Arithmetic'],
  ])('refuses %j', (source, expected) => {
    const result = errorOf(validateExpression(source, MODEL, 'constraint'))
    expect(result.error).toContain(expected)
  })

  it('refuses `<` on an enum, because a domain is a SET and not an ORDER', () => {
    const result = errorOf(validateExpression('run_state < DONE', MODEL, 'constraint'))
    expect(result.error).toContain('integer-only')
    // The REASON is in the suggestion, because this is the rule most likely to look
    // like an arbitrary restriction: ordering an enum would make a reordering of the
    // domain array silently change what requirements mean.
    expect(result.suggestions.join(' ')).toMatch(/unordered|reorder/i)
  })

  it('refuses `<` on a bool for the same reason', () => {
    const result = errorOf(validateExpression('lock_held < pending', MODEL, 'constraint'))
    expect(result.error).toContain('integer-only')
  })

  it('ACCEPTS `=` and `!=` on every sort', () => {
    for (const source of [
      'lock_held = true',
      'lock_held != pending',
      'retry_count = 3',
      'retry_count != 0',
      'run_state = PENDING',
      'run_state != FAILED',
    ]) {
      expect(isExprError(validateExpression(source, MODEL, 'constraint')), source).toBe(false)
    }
  })

  it('ACCEPTS the four ordered comparisons on ints', () => {
    for (const op of ['<', '<=', '>', '>=']) {
      const source = `retry_count ${op} 3`
      expect(isExprError(validateExpression(source, MODEL, 'constraint')), source).toBe(false)
    }
  })

  it('resolves an enum member on EITHER side of the comparison', () => {
    // `PENDING = run_state` must work too. Requiring the variable on the left would be
    // a rule with no soundness content that rejects a perfectly clear document.
    expect(isExprError(validateExpression('run_state = PENDING', MODEL, 'constraint'))).toBe(false)
    expect(isExprError(validateExpression('PENDING = run_state', MODEL, 'constraint'))).toBe(false)
  })

  it('reports the sort of a well-formed subexpression through `sortOf`', () => {
    const vars = declaredVars(MODEL)
    const int = parseExpression('retry_count + 1')
    if (isExprError(int)) throw new Error(int.error)
    expect(sortOf(int, vars)).toBe('int')
    const bool = parseExpression('lock_held and pending')
    if (isExprError(bool)) throw new Error(bool.error)
    expect(sortOf(bool, vars)).toBe('bool')
    const enumSort = parseExpression('run_state')
    if (isExprError(enumSort)) throw new Error(enumSort.error)
    expect(sortOf(enumSort, vars)).toEqual({ enumOf: 'run_state' })
  })
})

// ---------------------------------------------------------------------------
// 3. A constraint must be a PREDICATE
// ---------------------------------------------------------------------------

describe('a constraint must be boolean, so the encoder never has to invent a coercion', () => {
  it.each([
    ['retry_count'],
    ['retry_count + 1'],
    ['run_state'],
  ])('refuses the non-predicate %j', (source) => {
    const result = errorOf(validateExpression(source, MODEL, 'constraint'))
    expect(result.error).toContain('PREDICATE')
  })

  it('names the ROLE in the message, so `initial` and `constraint` read differently', () => {
    const asInitial = errorOf(validateExpression('retry_count', MODEL, 'initial'))
    const asConstraint = errorOf(validateExpression('retry_count', MODEL, 'constraint'))
    expect(asInitial.error).toContain('initial')
    expect(asConstraint.error).toContain('constraint')
    expect(asInitial.error).not.toBe(asConstraint.error)
  })
})

// ---------------------------------------------------------------------------
// 4. The grammar's deliberate ABSENCES
// ---------------------------------------------------------------------------

describe('the grammar refuses what it cannot encode soundly', () => {
  it('refuses multiplication — it makes the transition relation nonlinear', () => {
    // Not a parse of `*` into something else: `*` is not a token at all, so this is a
    // lexical refusal naming the offending character.
    const result = errorOf(parseExpression('retry_count * 2 = 4'))
    expect(result.error).toContain('Unexpected character')
    expect(result.offset).toBeGreaterThan(0)
  })

  it('refuses a CHAINED comparison rather than guessing which reading was meant', () => {
    const result = errorOf(parseExpression('0 <= retry_count <= 5'))
    expect(result.error).toContain('Chained comparison')
    // And it hands back the rewrite, which is the whole point of refusing rather than
    // picking: there IS a correct spelling and the message names it.
    expect(result.suggestions.join(' ')).toContain('and')
  })

  it('refuses a unary minus, because a sometimes-parsing one is worse than none', () => {
    const result = errorOf(parseExpression('retry_count = -1'))
    expect(result.error).toMatch(/Unexpected|operand/)
  })

  it('ACCEPTS the documented spelling of a negative value', () => {
    expect(isExprError(validateExpression('retry_count = 0 - 1', MODEL, 'constraint'))).toBe(false)
  })

  it('refuses an unclosed parenthesis, naming where it opened', () => {
    const result = errorOf(parseExpression('not (lock_held and pending'))
    expect(result.error).toContain('Unclosed parenthesis')
    expect(result.offset).toBe(4)
  })

  it('refuses trailing junk rather than silently ignoring it', () => {
    const result = errorOf(parseExpression('lock_held = true pending'))
    expect(result.error).toContain('Trailing')
  })

  it('refuses an empty expression', () => {
    expect(errorOf(parseExpression('   ')).error).toContain('empty')
  })
})

// ---------------------------------------------------------------------------
// 5. The lexer's longest-match ordering — the classic hand-lexer bug
// ---------------------------------------------------------------------------

describe('multi-character operators are lexed BEFORE their single-character prefixes', () => {
  /**
   * A hand-written lexer's reliable bug: matching `<` before `<=`, so `a <= b` lexes as
   * `a < (= b)` and then fails somewhere confusing — or worse, parses as something
   * else. Pinned in BOTH directions so "tidying" the branch order fails here.
   */
  it.each([
    ['retry_count <= 5'],
    ['retry_count >= 5'],
    ['retry_count != 5'],
  ])('lexes %j as ONE comparison', (source) => {
    const expr = parseExpression(source)
    if (isExprError(expr)) throw new Error(expr.error)
    expect(expr.kind).toBe('compare')
    if (expr.kind === 'compare') expect(expr.op.length).toBe(2)
  })

  it('lexes `:=` as an assignment, not as a `:` followed by `=`', () => {
    const effect = parseEffect('lock_held := true')
    if (isExprError(effect)) throw new Error(effect.error)
    expect(effect.assignments).toHaveLength(1)
    expect(effect.assignments[0]?.target).toBe('lock_held')
    // No `when` prefix, so the effect is UNGUARDED — the sound default.
    expect(effect.guard).toBeUndefined()
  })

  it('tells an author who wrote `=` in an effect what the difference IS', () => {
    // The single most likely authoring mistake in this language, so the message has to
    // teach rather than merely reject.
    const result = errorOf(parseEffect('lock_held = true'))
    expect(result.error).toContain(':=')
    expect(result.suggestions.join(' ')).toMatch(/ASSIGNS|comparison/)
  })

  it('accepts the symbolic connectives as aliases for the word forms', () => {
    const words = parseExpression('lock_held and not pending')
    const symbols = parseExpression('lock_held && !pending')
    if (isExprError(words) || isExprError(symbols)) throw new Error('both should parse')
    // Same AST, so the two spellings cannot diverge in meaning.
    expect(JSON.stringify(symbols)).toBe(JSON.stringify(words))
  })

  it('accepts `==` as an alias for `=`', () => {
    const single = parseExpression('retry_count = 1')
    const double = parseExpression('retry_count == 1')
    if (isExprError(single) || isExprError(double)) throw new Error('both should parse')
    expect(JSON.stringify(double)).toBe(JSON.stringify(single))
  })

  it('exposes exactly six comparison operators', () => {
    // Pins the closed set, so adding one without deciding its sort rules fails here.
    expect([...COMPARE_OPS]).toEqual(['=', '!=', '<', '<=', '>', '>='])
  })
})

// ---------------------------------------------------------------------------
// 6. Effects: simultaneity, and the write-write conflict
// ---------------------------------------------------------------------------

describe('effects are SIMULTANEOUS updates, and a write-write conflict is refused', () => {
  it('parses several comma-separated updates as one step', () => {
    const effect = validateEffect('run_state := RUNNING, retry_count := 0', MODEL)
    if (isExprError(effect)) throw new Error(effect.error)
    expect(effect.assignments).toHaveLength(2)
    expect([...writesOf(effect.assignments)].sort()).toEqual(['retry_count', 'run_state'])
  })

  /**
   * The EARS-CTRL case, refused rather than repaired.
   *
   * The AC-2-5 decision doc records that EARS-CTRL — co-authored by EARS's own
   * inventor — hit the "door simultaneously open and close" write-write conflict and
   * resolved it by silently SERIALIZING the two updates. That is a repair the document
   * never asked for, and the two orders give different post-states, so there is no
   * order-independent answer to pick. Refusing is the position a tool that classifies
   * responses as effects can actually take.
   */
  it('refuses assigning one variable twice in ONE step (the EARS-CTRL conflict)', () => {
    const result = errorOf(parseEffect('lock_held := true, lock_held := false'))
    expect(result.error).toContain('twice')
    expect(result.suggestions.join(' ')).toMatch(/write-write|post-state/)
  })

  it('refuses assigning a value of the wrong sort, naming both sorts', () => {
    const result = errorOf(validateEffect('lock_held := 1', MODEL))
    expect(result.error).toContain('Cannot assign')
    expect(result.error).toContain('lock_held')
  })

  it('offers a correctly-sorted example for an ENUM target', () => {
    const result = errorOf(validateEffect('run_state := true', MODEL))
    // The example names a real member of the real domain, not a placeholder.
    expect(result.suggestions.join(' ')).toContain('PENDING')
  })

  it('refuses an empty effect and points at the `constraint` classification', () => {
    const result = errorOf(parseEffect('  '))
    expect(result.suggestions.join(' ')).toContain('constraint')
  })

  it('ACCEPTS a self-referential increment', () => {
    const effect = validateEffect('retry_count := retry_count + 1', MODEL)
    if (isExprError(effect)) throw new Error(effect.error)
    expect([...writesOf(effect.assignments)]).toEqual(['retry_count'])
    // Both halves are references: it WRITES and READS the same variable.
    expect([...touchedByEffect(effect, declaredVars(MODEL))]).toEqual(['retry_count'])
  })

  /**
   * ## The GUARD, and why its absence is the sound direction
   *
   * An EARS requirement is normally `WHEN <trigger>, the system shall <response>`, and
   * the trigger is a guard. Without one, "acquire the lock" encodes as a transition
   * available from EVERY state — including states where nothing requested it — which
   * makes almost every interesting constraint trivially violable by a transition the
   * document never licensed. (Found the hard way: the first `LOCK_SAFE` fixture in
   * `reachability.test.ts` was genuinely VIOLATED for exactly this reason, and the
   * solver was right.)
   *
   * It is OPTIONAL because an unguarded effect admits MORE transitions, so strictly
   * fewer things are provable — a missing guard can only weaken a claim, the same
   * principle as `frame: volatile` on the other axis.
   */
  it('parses a `when` GUARD and keeps it separate from the updates', () => {
    const effect = validateEffect('when pending: lock_held := true', MODEL)
    if (isExprError(effect)) throw new Error(effect.error)
    expect(effect.guard).toBeDefined()
    expect(effect.assignments).toHaveLength(1)
    expect([...writesOf(effect.assignments)]).toEqual(['lock_held'])
  })

  it('counts a GUARD-ONLY reference as a reference, so `unstate` cannot strand it', () => {
    // `pending` is neither written nor assigned — it appears only in the guard. A
    // reference collector that walked assignments alone would let it be undeclared,
    // stranding exactly the reference the guard depends on.
    const names = referencedNames('when pending: lock_held := true', MODEL, 'effect')
    expect([...(names ?? [])].sort()).toEqual(['lock_held', 'pending'])
  })

  it('refuses a non-PREDICATE guard rather than coercing it', () => {
    const result = errorOf(validateEffect('when retry_count: lock_held := true', MODEL))
    expect(result.error).toContain('PREDICATE')
  })

  it('refuses an undeclared reference in the GUARD', () => {
    expect(errorOf(validateEffect('when ghost: lock_held := true', MODEL)).error).toContain('ghost')
  })

  it('refuses a `when` with no terminating colon, rather than swallowing the assignment', () => {
    // Without the colon requirement the parser would absorb `lock_held` into the guard
    // expression and then fail somewhere confusing.
    const result = errorOf(parseEffect('when pending lock_held := true'))
    expect(result.error).toContain('`:`')
  })

  it('reserves `when` globally, so a variable can never shadow the guard keyword', () => {
    // Reserved GLOBALLY rather than only in effect position: a name that works in a
    // constraint and fails in an effect is worse than one that never works, because the
    // failure would surface only on reclassification.
    expect([...RESERVED_WORDS]).toContain('when')
  })

  it('ACCEPTS a conditional value expression', () => {
    expect(isExprError(validateEffect('lock_held := pending and not lock_held', MODEL))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. Reserved words cannot be variables
// ---------------------------------------------------------------------------

describe('reserved words are not usable as names', () => {
  it('exposes the six reserved words', () => {
    // `when` joined the five connectives/literals when effect GUARDS landed: it
    // introduces a guard, so a variable of that name would be unparseable at the one
    // position an effect begins. Pinned as a list rather than a count so ADDING a
    // reserved word is a visible edit — every addition invalidates documents that used
    // the name, which is a decision and not a detail.
    expect([...RESERVED_WORDS]).toEqual(['and', 'or', 'not', 'true', 'false', 'when'])
  })

  it('lexes a reserved word as SYNTAX even when a variable of that name is declared', () => {
    // The document schema refuses such a declaration (`STATE_VAR_NAME_PATTERN`), and
    // this is why: if one existed, it would be unreferenceable — the lexer sees the
    // operator, always. Asserted here so the schema rule's REASON is checkable and not
    // merely stated.
    const shadowed: StateModel = { variables: [boolVar('lock_held')] }
    const result = errorOf(validateExpression('and = true', shadowed, 'constraint'))
    expect(result.error).toMatch(/Unexpected|operand/)
  })
})

// ---------------------------------------------------------------------------
// 8. Reference collection — what the frame logic and the guards consume
// ---------------------------------------------------------------------------

describe('reference collection reports exactly the DECLARED names an expression uses', () => {
  it('collects reads from a constraint, and excludes enum MEMBERS', () => {
    const expr = validateExpression('run_state = PENDING and retry_count > 0', MODEL, 'constraint')
    if (isExprError(expr)) throw new Error(expr.error)
    const reads = readsOf(expr, declaredVars(MODEL))
    // `PENDING` is a member, not a variable, so it must NOT appear — a frame set
    // containing it would name something that is not state.
    expect([...reads].sort()).toEqual(['retry_count', 'run_state'])
  })

  it('collects writes AND reads from an effect', () => {
    const names = referencedNames(
      'run_state := RUNNING, retry_count := retry_count + 1',
      MODEL,
      'effect',
    )
    expect([...(names ?? [])].sort()).toEqual(['retry_count', 'run_state'])
  })

  /**
   * The `undefined` return is a DESIGN choice, not an oversight, and the `unstate`
   * guard depends on it: an expression that already does not validate cannot be made
   * worse by removing a variable, so it must not block the removal. Asserting it here
   * keeps a future "throw instead" refactor from silently stranding a document.
   */
  it('returns undefined — not an error — for an expression that does not validate', () => {
    expect(referencedNames('ghost = true', MODEL, 'constraint')).toBeUndefined()
    expect(referencedNames('ghost := true', MODEL, 'effect')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 9. Operator precedence and associativity
// ---------------------------------------------------------------------------

describe('precedence binds tighter than the connectives, so a predicate means one thing', () => {
  it('binds `and` tighter than `or`', () => {
    const expr = parseExpression('lock_held and pending or run_state = DONE')
    if (isExprError(expr)) throw new Error(expr.error)
    // Top level is the OR; the AND is nested inside it.
    expect(expr.kind).toBe('or')
    if (expr.kind === 'or') expect(expr.operands[0]?.kind).toBe('and')
  })

  it('binds a comparison tighter than `and`', () => {
    const expr = parseExpression('retry_count = 0 and lock_held')
    if (isExprError(expr)) throw new Error(expr.error)
    expect(expr.kind).toBe('and')
    if (expr.kind === 'and') expect(expr.operands[0]?.kind).toBe('compare')
  })

  it('binds arithmetic tighter than a comparison', () => {
    const expr = parseExpression('retry_count + 1 <= 5')
    if (isExprError(expr)) throw new Error(expr.error)
    expect(expr.kind).toBe('compare')
    if (expr.kind === 'compare') expect(expr.left.kind).toBe('arith')
  })

  it('lets parentheses override, and does NOT wrap a single operand', () => {
    const parenthesized = parseExpression('(lock_held)')
    const bare = parseExpression('lock_held')
    if (isExprError(parenthesized) || isExprError(bare)) throw new Error('both should parse')
    // A one-element `and`/`or` is never synthesized — the AST keeps the shape the
    // source had, so the encoder emits no redundant node and evidence a human reads
    // does not grow spurious nesting.
    expect(JSON.stringify(parenthesized)).toBe(JSON.stringify(bare))
  })

  it('left-associates arithmetic', () => {
    const expr = parseExpression('retry_count - 1 - 1')
    if (isExprError(expr)) throw new Error(expr.error)
    expect(expr.kind).toBe('arith')
    // ((c - 1) - 1), not (c - (1 - 1)) — which differ, so the associativity is load-bearing.
    if (expr.kind === 'arith') expect(expr.left.kind).toBe('arith')
  })
})
