/**
 * THE STATE-MODEL EXPRESSION LANGUAGE — the front door that keeps an undeclared
 * variable away from the Horn encoder.
 *
 * ## Why this module exists at all, and why it is in `core/`
 *
 * Donor findings V14 and V21 are the same defect seen twice: a Fixedpoint query
 * given something it does not declare HANGS THE WASM UNKILLABLY. V21's measurement
 * is the sharp one — an undeclared `random_seed` key in the params object silently
 * voids the `timeout` set beside it, and the query then runs past 45s with no
 * JS-side recovery. `interruptibleSolve` (the G2a primitive) is the *escape* from
 * that hang, and G4 uses it; but an escape is the second line of defense. The FIRST
 * is never building the query at all.
 *
 * So the rule this module enforces is structural: **an effect or a constraint may
 * reference ONLY a declared state variable, and that is checked at AUTHORING time,
 * where it is an `ERR_*` a human or agent can fix — never at encode time, where it
 * is a hang.** {@link validateExpression} is the one checker, {@link parseExpression}
 * the one parser, and `../formal/reachability.ts` consumes an already-validated AST
 * rather than text. There is no code path from document text to a Z3 term that
 * skips this file.
 *
 * It lives in `core/` (not `formal/`) for the same reason `mutate.ts` does: it is
 * part of what makes a document VALID, so the write path must reach it, and the
 * write path must not import the transplanted formal tier (the dependency runs the
 * other way, and a cycle would put the atomizer in the load graph of every document
 * read).
 *
 * ## The grammar, and why it is this small
 *
 * ```
 *   effect      ::= assignment ( ',' assignment )*
 *   assignment  ::= IDENT ':=' expr
 *   expr        ::= disjunct ( 'or' disjunct )*
 *   disjunct    ::= conjunct ( 'and' conjunct )*
 *   conjunct    ::= 'not' conjunct | comparison
 *   comparison  ::= sum ( ( '=' | '!=' | '<' | '<=' | '>' | '>=' ) sum )?
 *   sum         ::= atom ( ( '+' | '-' ) atom )*
 *   atom        ::= '(' expr ')' | 'true' | 'false' | INTEGER | IDENT
 * ```
 *
 * Deliberately NOT a general-purpose expression language. Every construct here
 * lowers to a Horn clause over the declared variables with no encoding choice left
 * to make, which is the property that keeps the encoder auditable — and every
 * construct ABSENT is absent because it would not. No quantifiers (Spacer infers
 * over the declared state, and a user-written quantifier would silently change what
 * question is asked); no arithmetic beyond `+`/`-` on declared ints and literals
 * (multiplication makes the transition relation nonlinear, which is where the
 * donor's probe-20 measured an unbounded Spacer hang); no function calls; no
 * strings.
 *
 * `and`/`or`/`not` are WORDS, not `&&`/`||`/`!`. The document is prose that humans
 * review in a `git diff`, and a requirements author writes "not (lock_held and
 * pending)". The symbolic spellings are accepted as aliases anyway, because
 * rejecting them would be a usability tax with no soundness benefit.
 *
 * ## Sorts are CHECKED, not inferred-and-hoped
 *
 * The one union type {@link Expr} covers booleans, integers, and enum members,
 * because a hand-written grammar cannot tell `run_state = PENDING` from
 * `retry_count = 0` until it knows what `run_state` is. {@link sortOf} resolves that
 * against the declared model and REPORTS a mismatch rather than picking a coercion:
 * `lock_held + 1` and `retry_count and pending` are both errors, and each names the
 * variable whose declared type made it one. A coercion here would be the same class
 * of defect as the frame assumption — the tool quietly deciding something the
 * document never said.
 *
 * ## An enum member and a variable share one lexical shape, on purpose
 *
 * `run_state = PENDING` has an IDENT on both sides. Resolving which is which needs
 * the model, so {@link Expr} carries a neutral `ref` node and {@link sortOf} decides:
 * a name that matches a declared variable IS that variable; otherwise it must be a
 * member of the enum domain it is being compared against. Anything else is an
 * undeclared reference — the V14/V21 case — reported with the declared names listed
 * so the fix is mechanical.
 *
 * The alternative (a distinct syntax for enum members, `'PENDING'` or `#PENDING`)
 * was rejected because it puts an encoding artifact into prose a human reviews, and
 * because the ambiguity is genuinely resolvable from data the document already
 * carries.
 */

import type { StateModel, StateVariable } from './document.ts'

// ---------------------------------------------------------------------------
// The AST
// ---------------------------------------------------------------------------

/** The six comparison operators. `=` is equality, not assignment — `:=` assigns. */
export const COMPARE_OPS = ['=', '!=', '<', '<=', '>', '>='] as const
export type CompareOp = (typeof COMPARE_OPS)[number]

/**
 * One expression node.
 *
 * A single union across booleans, integers, and enum members rather than separate
 * `Predicate` / `Term` types, because the PARSER cannot separate them — see the
 * module header. {@link sortOf} is what makes the distinction, and it does so
 * against the declared model.
 */
export type Expr =
  /** `true` / `false`. */
  | { readonly kind: 'bool'; readonly value: boolean }
  /** An integer literal. */
  | { readonly kind: 'int'; readonly value: number }
  /** A bare identifier: a declared variable, or an enum member. Resolved by
   * {@link sortOf}, never by the parser. */
  | { readonly kind: 'ref'; readonly name: string }
  | { readonly kind: 'not'; readonly operand: Expr }
  | { readonly kind: 'and'; readonly operands: readonly Expr[] }
  | { readonly kind: 'or'; readonly operands: readonly Expr[] }
  | {
      readonly kind: 'compare'
      readonly op: CompareOp
      readonly left: Expr
      readonly right: Expr
    }
  | {
      readonly kind: 'arith'
      readonly op: '+' | '-'
      readonly left: Expr
      readonly right: Expr
    }

/**
 * One state update: `target := value`.
 *
 * The target is a NAME rather than an `Expr`, which is the whole point of having a
 * separate assignment shape: only a declared variable can be written, so the write
 * set of a requirement is readable off the AST without evaluating anything. The
 * frame logic (AC-2-5) and the two-valuedness sanity gate both consume exactly that.
 */
export interface Assignment {
  readonly target: string
  readonly value: Expr
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/**
 * A parse or validation failure, as a VALUE.
 *
 * Never a throw, for the reason the whole codebase is built on: this runs on the
 * WRITE path, where a failure has to become an `ERR_*` envelope with suggestions,
 * and it runs on the CHECK path, which must stay throw-free. A returned union makes
 * both call sites exhaustive.
 *
 * `offset` is a character index into the source text, present when the failure is
 * lexical. Omitted for a semantic failure (an undeclared name is a fact about the
 * MODEL, not about a position), which is why the field is optional rather than
 * `-1`-sentinelled.
 */
export interface ExprError {
  /** Human-readable, and written to be pasted into an error envelope as-is. */
  readonly error: string
  /** Actionable next steps. Always at least one. */
  readonly suggestions: readonly string[]
  /** Character offset into the source, for a lexical failure. */
  readonly offset?: number
}

/**
 * Narrow a `T | ExprError` to its failure branch.
 *
 * `T` is UNCONSTRAINED, deliberately: {@link Sort} is `'bool' | 'int' | {enumOf}`, so
 * the success branch here is legitimately sometimes a STRING. A `T extends object`
 * bound (the shape `isOpFailure` uses, where every success is an object) makes
 * `sortOf`'s result unusable at every call site.
 *
 * That means the runtime test has to survive a primitive input, which `'error' in
 * value` does not — `in` throws on a string. Hence the `typeof` guard first. The
 * discriminant is still structural and still safe: no success shape reachable here
 * carries both an `error` and a `suggestions` key.
 */
export const isExprError = <T>(value: T | ExprError): value is ExprError =>
  typeof value === 'object' && value !== null && 'error' in value && 'suggestions' in value

const fail = (error: string, suggestions: readonly string[], offset?: number): ExprError => ({
  error,
  suggestions,
  ...(offset !== undefined ? { offset } : {}),
})

// ---------------------------------------------------------------------------
// The lexer
// ---------------------------------------------------------------------------

/**
 * A variable or enum-member name: identifier-shaped, dots allowed.
 *
 * Dots are in because the donor's own state-variable examples use them
 * (`perf.p99`-style naming is idiomatic in these documents), and they cannot be
 * confused with anything else in this grammar — there is no member access.
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_.]*/

/** The reserved words. A variable may not be named one of these. */
export const RESERVED_WORDS = ['and', 'or', 'not', 'true', 'false'] as const

interface Token {
  readonly type: 'ident' | 'int' | 'op' | 'lparen' | 'rparen' | 'comma' | 'assign'
  readonly text: string
  readonly offset: number
}

/**
 * Tokenize. Total: every failure is a returned {@link ExprError} naming the offset.
 *
 * The multi-character operators are matched BEFORE their single-character prefixes
 * (`<=` before `<`, `:=` before a bare `:`), which is the one ordering bug a
 * hand-written lexer reliably ships. `state-expr.test.ts` pins it in both
 * directions so the ordering cannot be "tidied" into a `<` that swallows the `=`.
 */
const tokenize = (source: string): readonly Token[] | ExprError => {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i] as string
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', text: ch, offset: i })
      i += 1
      continue
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', text: ch, offset: i })
      i += 1
      continue
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', text: ch, offset: i })
      i += 1
      continue
    }
    // LONGEST FIRST. `:=` and the two-character comparisons must be tried before
    // any prefix of themselves.
    const two = source.slice(i, i + 2)
    if (two === ':=') {
      tokens.push({ type: 'assign', text: two, offset: i })
      i += 2
      continue
    }
    if (two === '<=' || two === '>=' || two === '!=' || two === '==') {
      // `==` is accepted as an alias for `=`: it is what a programmer types, it
      // cannot mean anything else here, and rejecting it would be a usability tax
      // with no soundness benefit.
      tokens.push({ type: 'op', text: two === '==' ? '=' : two, offset: i })
      i += 2
      continue
    }
    if (two === '&&' || two === '||') {
      tokens.push({ type: 'op', text: two === '&&' ? 'and' : 'or', offset: i })
      i += 2
      continue
    }
    if (ch === '=' || ch === '<' || ch === '>' || ch === '+' || ch === '-') {
      tokens.push({ type: 'op', text: ch, offset: i })
      i += 1
      continue
    }
    if (ch === '!') {
      tokens.push({ type: 'op', text: 'not', offset: i })
      i += 1
      continue
    }
    if (/[0-9]/.test(ch)) {
      const digits = /^[0-9]+/.exec(source.slice(i))?.[0] as string
      tokens.push({ type: 'int', text: digits, offset: i })
      i += digits.length
      continue
    }
    const ident = IDENT.exec(source.slice(i))?.[0]
    if (ident !== undefined) {
      const lowered = ident.toLowerCase()
      if (lowered === 'and' || lowered === 'or' || lowered === 'not') {
        tokens.push({ type: 'op', text: lowered, offset: i })
      } else {
        tokens.push({ type: 'ident', text: ident, offset: i })
      }
      i += ident.length
      continue
    }
    return fail(
      `Unexpected character ${JSON.stringify(ch)} at offset ${i} in "${source}".`,
      [
        'State expressions use: declared variable names, integer literals, `true`/`false`,',
        'the comparisons = != < <= > >=, arithmetic + and -, the connectives and/or/not, and parentheses.',
      ],
      i,
    )
  }
  return tokens
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/**
 * A recursive-descent parser over the token list, as a small mutable cursor.
 *
 * A class rather than threaded indices purely for readability of the five mutually
 * recursive productions; nothing here escapes the module, and `parse*` returns a
 * value-or-error at every level so no exception is used for control flow.
 */
class Parser {
  private index = 0
  constructor(
    private readonly tokens: readonly Token[],
    private readonly source: string,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.index]
  }

  private next(): Token | undefined {
    const token = this.tokens[this.index]
    this.index += 1
    return token
  }

  private atEnd(): boolean {
    return this.index >= this.tokens.length
  }

  /** The offset to blame when the input simply ran out. */
  private endOffset(): number {
    return this.source.length
  }

  /** `expr ::= disjunct ( 'or' disjunct )*` */
  parseExpr(): Expr | ExprError {
    const first = this.parseDisjunct()
    if (isExprError(first)) return first
    const operands: Expr[] = [first]
    while (this.peek()?.type === 'op' && this.peek()?.text === 'or') {
      this.next()
      const operand = this.parseDisjunct()
      if (isExprError(operand)) return operand
      operands.push(operand)
    }
    // A one-element `or` is NOT wrapped: the AST stays the shape the source had, so
    // the encoder never emits a redundant Z3 node and the evidence a human reads
    // does not grow spurious nesting.
    return operands.length === 1 ? first : { kind: 'or', operands }
  }

  /** `disjunct ::= conjunct ( 'and' conjunct )*` */
  private parseDisjunct(): Expr | ExprError {
    const first = this.parseConjunct()
    if (isExprError(first)) return first
    const operands: Expr[] = [first]
    while (this.peek()?.type === 'op' && this.peek()?.text === 'and') {
      this.next()
      const operand = this.parseConjunct()
      if (isExprError(operand)) return operand
      operands.push(operand)
    }
    return operands.length === 1 ? first : { kind: 'and', operands }
  }

  /** `conjunct ::= 'not' conjunct | comparison` */
  private parseConjunct(): Expr | ExprError {
    if (this.peek()?.type === 'op' && this.peek()?.text === 'not') {
      this.next()
      const operand = this.parseConjunct()
      if (isExprError(operand)) return operand
      return { kind: 'not', operand }
    }
    return this.parseComparison()
  }

  /** `comparison ::= sum ( CMP sum )?` — NON-associative, deliberately. */
  private parseComparison(): Expr | ExprError {
    const left = this.parseSum()
    if (isExprError(left)) return left
    const token = this.peek()
    if (token?.type !== 'op') return left
    const op = COMPARE_OPS.find((c) => c === token.text)
    if (op === undefined) return left
    this.next()
    const right = this.parseSum()
    if (isExprError(right)) return right
    // `a < b < c` is REFUSED rather than parsed as `(a < b) < c`. In a language with
    // no boolean-to-int coercion the chained form has no meaning, and the two
    // plausible readings (chained conjunction, or left-associated nonsense) differ —
    // so guessing would be exactly the silent-decision class of defect this whole
    // tier exists to avoid.
    const trailing = this.peek()
    if (trailing?.type === 'op' && COMPARE_OPS.some((c) => c === trailing.text)) {
      return fail(
        `Chained comparison at offset ${trailing.offset} in "${this.source}": \`a ${op} b ${trailing.text} c\` has no single meaning here.`,
        [`Write it as two comparisons joined by \`and\`: \`a ${op} b and b ${trailing.text} c\`.`],
        trailing.offset,
      )
    }
    return { kind: 'compare', op, left, right }
  }

  /** `sum ::= atom ( ( '+' | '-' ) atom )*` — LEFT-associative. */
  private parseSum(): Expr | ExprError {
    let left = this.parseAtom()
    if (isExprError(left)) return left
    for (;;) {
      const token = this.peek()
      if (token?.type !== 'op' || (token.text !== '+' && token.text !== '-')) break
      this.next()
      const right = this.parseAtom()
      if (isExprError(right)) return right
      left = { kind: 'arith', op: token.text, left, right }
    }
    return left
  }

  /** `atom ::= '(' expr ')' | 'true' | 'false' | INTEGER | IDENT` */
  private parseAtom(): Expr | ExprError {
    const token = this.next()
    if (token === undefined) {
      return fail(
        `Unexpected end of expression in "${this.source}" — an operand is missing.`,
        ['Complete the expression, e.g. `lock_held = false` or `retry_count + 1`.'],
        this.endOffset(),
      )
    }
    if (token.type === 'lparen') {
      const inner = this.parseExpr()
      if (isExprError(inner)) return inner
      const close = this.next()
      if (close?.type !== 'rparen') {
        return fail(
          `Unclosed parenthesis opened at offset ${token.offset} in "${this.source}".`,
          ['Add the matching `)`.'],
          token.offset,
        )
      }
      return inner
    }
    if (token.type === 'int') {
      // Every integer here is a decimal run of digits (the lexer guarantees it), so
      // `Number` cannot produce NaN. A NEGATIVE literal is not a token — it is
      // `0 - n` or a unary position the grammar does not admit, which is deliberate:
      // `-` is binary only, so `x = -1` must be written `x = 0 - 1`. Stated in the
      // field description rather than silently accepted, because a unary minus that
      // only sometimes parses is worse than one that never does.
      return { kind: 'int', value: Number(token.text) }
    }
    if (token.type === 'ident') {
      const lowered = token.text.toLowerCase()
      if (lowered === 'true') return { kind: 'bool', value: true }
      if (lowered === 'false') return { kind: 'bool', value: false }
      return { kind: 'ref', name: token.text }
    }
    return fail(
      `Unexpected ${JSON.stringify(token.text)} at offset ${token.offset} in "${this.source}" — expected a variable, a literal, or \`(\`.`,
      ['Check the expression reads as a predicate over declared state variables.'],
      token.offset,
    )
  }

  /** Fail unless every token was consumed. */
  requireEnd(): ExprError | undefined {
    if (this.atEnd()) return undefined
    const token = this.peek() as Token
    return fail(
      `Trailing ${JSON.stringify(token.text)} at offset ${token.offset} in "${this.source}" — the expression already ended.`,
      [
        'Join two predicates with `and`/`or` rather than juxtaposing them.',
        'Separate two state updates with a comma: `a := true, b := false`.',
      ],
      token.offset,
    )
  }

  /** `assignment ::= IDENT ':=' expr` */
  parseAssignment(): Assignment | ExprError {
    const target = this.next()
    if (target?.type !== 'ident') {
      return fail(
        `A state update must start with a declared variable name, got ${JSON.stringify(target?.text ?? '<end>')} in "${this.source}".`,
        ['Write `<variable> := <expression>`, e.g. `lock_held := true`.'],
        target?.offset ?? this.endOffset(),
      )
    }
    const assign = this.next()
    if (assign?.type !== 'assign') {
      return fail(
        `Expected \`:=\` after ${JSON.stringify(target.text)} in "${this.source}", got ${JSON.stringify(assign?.text ?? '<end>')}.`,
        [
          'A state update ASSIGNS with `:=`. A single `=` is the equality COMPARISON, which belongs in a constraint.',
          'Example effect: `lock_held := true`. Example constraint: `lock_held = true`.',
        ],
        assign?.offset ?? this.endOffset(),
      )
    }
    const value = this.parseExpr()
    if (isExprError(value)) return value
    return { target: target.text, value }
  }

  /** Whether a comma follows, consuming it when it does. */
  takeComma(): boolean {
    if (this.peek()?.type === 'comma') {
      this.next()
      return true
    }
    return false
  }
}

/**
 * Parse a PREDICATE — an initial-state predicate, or a constraint.
 *
 * Syntax only. Nothing here knows whether a referenced name is declared; that is
 * {@link validateExpression}, and keeping the two separate is what lets the parser
 * be tested exhaustively without a model and lets one model-validation pass cover
 * every expression in a document.
 */
export const parseExpression = (source: string): Expr | ExprError => {
  const trimmed = source.trim()
  if (trimmed.length === 0) {
    return fail('An empty expression is not a predicate.', [
      'Write a predicate over declared state variables, e.g. `lock_held = false`.',
    ])
  }
  const tokens = tokenize(trimmed)
  if (isExprError(tokens)) return tokens
  const parser = new Parser(tokens, trimmed)
  const expr = parser.parseExpr()
  if (isExprError(expr)) return expr
  const trailing = parser.requireEnd()
  return trailing ?? expr
}

/**
 * Parse an EFFECT — one or more comma-separated state updates.
 *
 * A LIST, because one requirement's response legitimately changes several variables
 * at once ("transition the run to RUNNING and clear the retry counter"), and
 * splitting that across two requirements would misrepresent the document: the two
 * updates happen in ONE step, and encoding them as two steps admits an intermediate
 * state the system never occupies.
 *
 * A DUPLICATE target is refused. `a := true, a := false` is the write-write conflict
 * the AC-2-5 decision doc calls out as EARS-CTRL's papered-over case ("door
 * simultaneously open and close", which that tool silently serialized). Refusing it
 * at authoring time is the "detect and report instead of silently repairing"
 * position, and it has to be refused rather than merged because the two orders give
 * different post-states.
 */
export const parseEffect = (source: string): readonly Assignment[] | ExprError => {
  const trimmed = source.trim()
  if (trimmed.length === 0) {
    return fail('An empty effect changes no state.', [
      'Write one or more updates, e.g. `run_state := RUNNING, retry_count := 0`.',
      'If the response does not change state, classify it as a `constraint` instead.',
    ])
  }
  const tokens = tokenize(trimmed)
  if (isExprError(tokens)) return tokens
  const parser = new Parser(tokens, trimmed)
  const assignments: Assignment[] = []
  for (;;) {
    const assignment = parser.parseAssignment()
    if (isExprError(assignment)) return assignment
    const clash = assignments.find((a) => a.target === assignment.target)
    if (clash !== undefined) {
      return fail(
        `The effect "${trimmed}" assigns ${JSON.stringify(assignment.target)} twice in ONE step.`,
        [
          'Two updates to one variable in a single step is a write-write conflict, not a sequence — the two orders give different post-states, so it cannot be resolved by picking one.',
          'Assign it once with the intended final value, or split the requirement so the updates happen in different steps.',
        ],
      )
    }
    assignments.push(assignment)
    if (!parser.takeComma()) break
  }
  const trailing = parser.requireEnd()
  return trailing ?? assignments
}

// ---------------------------------------------------------------------------
// Sorts and validation — the V14/V21 front door
// ---------------------------------------------------------------------------

/**
 * A resolved sort: a plain boolean, a plain integer, or a specific enum's domain.
 *
 * The enum case carries the VARIABLE NAME rather than just "enum", because two
 * enums with disjoint domains are different sorts and comparing across them is an
 * error worth naming precisely: `run_state = DONE` where `DONE` belongs to a
 * different variable's domain is exactly the typo a state model is written to make
 * impossible.
 */
export type Sort = 'bool' | 'int' | { readonly enumOf: string }

/** The declared variables, indexed by name — what every check here resolves against. */
export type DeclaredVars = ReadonlyMap<string, StateVariable>

/** Index a state model's variables by name. */
export const declaredVars = (model: StateModel): DeclaredVars =>
  new Map(model.variables.map((v) => [v.name, v]))

/** The sort a declared variable has. */
const sortOfVar = (variable: StateVariable): Sort =>
  variable.type === 'bool' ? 'bool' : variable.type === 'int' ? 'int' : { enumOf: variable.name }

const sortName = (sort: Sort): string =>
  sort === 'bool' ? 'bool' : sort === 'int' ? 'int' : `enum ${sort.enumOf}`

const sameSort = (a: Sort, b: Sort): boolean =>
  typeof a === 'object' && typeof b === 'object' ? a.enumOf === b.enumOf : a === b

/**
 * The "you referenced something that does not exist" failure, with the declared
 * names listed.
 *
 * The list is what makes this mechanically fixable rather than merely correct: the
 * commonest cause is a typo or a case difference, and an author who can see
 * `lock_held` next to their `lockHeld` needs no further explanation. Sorted, so the
 * message is deterministic and diffable.
 */
const undeclared = (name: string, vars: DeclaredVars): ExprError => {
  const declared = [...vars.keys()].sort()
  return fail(`"${name}" is not a declared state variable.`, [
    declared.length === 0
      ? 'This document declares no state variables yet. Declare one first: `symspec state --name <name> --type bool`.'
      : `Declared variables: ${declared.join(', ')}.`,
    'Every name in an effect or a constraint must be declared in the state model — an undeclared reference is refused HERE, at authoring time, because it would otherwise reach the Horn encoder and hang the solver (donor findings V14/V21).',
    'Declare it: `symspec state --name <name> --type bool|int|enum`.',
  ])
}

/**
 * Resolve an expression's sort against the declared model, reporting the first
 * mismatch.
 *
 * ## `expected` is the enum-resolution channel, and it flows DOWNWARD
 *
 * An enum MEMBER is lexically indistinguishable from a variable (see the module
 * header), so a bare `ref` that is not a declared variable can only be understood
 * relative to what it is being compared with. {@link sortOfCompare} therefore
 * resolves the side it CAN (a declared variable) and passes that sort down as
 * `expected` when resolving the other. A `ref` with no `expected` and no
 * declaration is an undeclared reference — the V14/V21 case.
 *
 * This is the only context-sensitivity in the checker, and it is one level deep by
 * construction: an enum member is always an atom, never a subexpression.
 */
export const sortOf = (expr: Expr, vars: DeclaredVars, expected?: Sort): Sort | ExprError => {
  switch (expr.kind) {
    case 'bool':
      return 'bool'
    case 'int':
      return 'int'
    case 'ref': {
      const variable = vars.get(expr.name)
      if (variable !== undefined) return sortOfVar(variable)
      // Not a variable. It can only legitimately be a member of the enum domain it
      // is being compared against.
      if (expected !== undefined && typeof expected === 'object') {
        const owner = vars.get(expected.enumOf)
        const domain = owner !== undefined && owner.type === 'enum' ? owner.domain : []
        if (domain.includes(expr.name)) return expected
        return fail(
          `"${expr.name}" is not a member of enum ${expected.enumOf}'s declared domain.`,
          [
            `Declared domain of ${expected.enumOf}: ${[...domain].join(', ')}.`,
            `Add the member with \`symspec state --name ${expected.enumOf} --type enum --domain "${[...domain, expr.name].join(',')}"\`, or fix the spelling.`,
          ],
        )
      }
      return undeclared(expr.name, vars)
    }
    case 'not': {
      const operand = sortOf(expr.operand, vars, 'bool')
      if (isExprError(operand)) return operand
      if (operand !== 'bool') {
        return fail(`\`not\` needs a boolean operand, got ${sortName(operand)}.`, [
          'Compare it first: `not (retry_count = 0)` rather than `not retry_count`.',
        ])
      }
      return 'bool'
    }
    case 'and':
    case 'or': {
      for (const operand of expr.operands) {
        const sort = sortOf(operand, vars, 'bool')
        if (isExprError(sort)) return sort
        if (sort !== 'bool') {
          return fail(`\`${expr.kind}\` needs boolean operands, got ${sortName(sort)}.`, [
            `Compare the non-boolean operand first: \`retry_count = 0 ${expr.kind} lock_held\`.`,
          ])
        }
      }
      return 'bool'
    }
    case 'compare':
      return sortOfCompare(expr, vars)
    case 'arith': {
      for (const side of [expr.left, expr.right]) {
        const sort = sortOf(side, vars, 'int')
        if (isExprError(sort)) return sort
        if (sort !== 'int') {
          return fail(`Arithmetic \`${expr.op}\` needs integer operands, got ${sortName(sort)}.`, [
            'Only declared `int` variables and integer literals may be added or subtracted.',
            'A bool or enum variable has no arithmetic — compare it instead.',
          ])
        }
      }
      return 'int'
    }
  }
}

/**
 * Resolve a comparison, which is where the enum-member ambiguity is settled.
 *
 * The order of work matters and is not arbitrary: try the LEFT side with no
 * expectation first, and if it resolves, use its sort as the expectation for the
 * right. If the left is an unresolvable bare `ref`, try the RIGHT first and feed
 * ITS sort back — so both `run_state = PENDING` and `PENDING = run_state` work.
 * Without the second direction the checker would reject a perfectly clear document
 * for writing a comparison "backwards", which is a rule with no soundness content.
 *
 * `<`/`<=`/`>`/`>=` are INTEGER-ONLY. An enum has a declared domain, not a declared
 * order — its members are listed in some sequence in the document, and treating that
 * sequence as an ordering would let a reordering of the domain array silently change
 * what a requirement means.
 */
const sortOfCompare = (
  expr: Extract<Expr, { kind: 'compare' }>,
  vars: DeclaredVars,
): Sort | ExprError => {
  const leftFirst = sortOf(expr.left, vars)
  let left: Sort
  let right: Sort
  if (isExprError(leftFirst)) {
    // The left side could not stand alone. Resolve the right and retry the left
    // against it — the `PENDING = run_state` direction.
    const rightAlone = sortOf(expr.right, vars)
    if (isExprError(rightAlone)) return leftFirst
    const leftRetry = sortOf(expr.left, vars, rightAlone)
    if (isExprError(leftRetry)) return leftRetry
    left = leftRetry
    right = rightAlone
  } else {
    left = leftFirst
    const rightWithHint = sortOf(expr.right, vars, leftFirst)
    if (isExprError(rightWithHint)) return rightWithHint
    right = rightWithHint
  }

  if (!sameSort(left, right)) {
    return fail(`Cannot compare ${sortName(left)} with ${sortName(right)}.`, [
      'Both sides of a comparison must have the same declared sort.',
      'A bool compares with `true`/`false` or another bool; an int with an integer expression; an enum only with a member of its OWN declared domain.',
    ])
  }
  if (expr.op !== '=' && expr.op !== '!=') {
    if (left !== 'int') {
      return fail(`\`${expr.op}\` is integer-only, but both sides are ${sortName(left)}.`, [
        'Use `=` or `!=` for bool and enum variables.',
        'An enum domain is an unordered SET — the order it is listed in is not a declared ordering, so `<` over it would change meaning whenever the domain array is reordered.',
      ])
    }
  }
  return 'bool'
}

/**
 * Validate a PREDICATE against a model: it must resolve, and it must be boolean.
 *
 * "Must be boolean" is the load-bearing half. `retry_count` alone parses fine and is
 * a perfectly good integer expression, but as a constraint it asserts nothing — and
 * an encoder handed it would have to invent a coercion (`!= 0`? `> 0`?) to produce a
 * Horn clause at all. Rejecting it here means the encoder never faces the question.
 */
export const validateExpression = (
  source: string,
  model: StateModel,
  role: 'initial' | 'constraint',
): Expr | ExprError => {
  const expr = parseExpression(source)
  if (isExprError(expr)) return expr
  const vars = declaredVars(model)
  const sort = sortOf(expr, vars)
  if (isExprError(sort)) return sort
  if (sort !== 'bool') {
    return fail(
      `A${role === 'initial' ? 'n initial-state' : ''} ${role} must be a PREDICATE (boolean), but "${source}" is ${sortName(sort)}.`,
      [
        'Compare it: `retry_count = 0` rather than `retry_count`.',
        role === 'constraint'
          ? 'A constraint states what must ALWAYS hold, so it has to be true-or-false in every state.'
          : 'An initial-state predicate states what holds before any requirement fires.',
      ],
    )
  }
  return expr
}

/**
 * Validate an EFFECT against a model: every target declared and writable, every
 * assigned value sort-compatible with its target.
 *
 * Returns the parsed assignments so the caller (`../formal/reachability.ts`) never
 * re-parses — one parse per expression per run, and the encoder consumes an AST that
 * has already been proven to reference only declared variables. That is the
 * invariant the whole V14/V21 mitigation rests on, and it is enforced by this
 * function being the only producer of the type the encoder accepts.
 */
export const validateEffect = (
  source: string,
  model: StateModel,
): readonly Assignment[] | ExprError => {
  const assignments = parseEffect(source)
  if (isExprError(assignments)) return assignments
  const vars = declaredVars(model)
  for (const assignment of assignments) {
    const target = vars.get(assignment.target)
    if (target === undefined) return undeclared(assignment.target, vars)
    const want = sortOfVar(target)
    const got = sortOf(assignment.value, vars, want)
    if (isExprError(got)) return got
    if (!sameSort(want, got)) {
      return fail(
        `Cannot assign ${sortName(got)} to ${JSON.stringify(assignment.target)}, which is declared ${sortName(want)}.`,
        [
          `Assign a ${sortName(want)} value, e.g. \`${assignment.target} := ${
            want === 'bool' ? 'true' : want === 'int' ? '0' : exampleMember(target)
          }\`.`,
        ],
      )
    }
  }
  return assignments
}

/** A domain member to show in an example, for an enum target. */
const exampleMember = (variable: StateVariable): string =>
  variable.type === 'enum' ? (variable.domain[0] ?? '<member>') : '<value>'

// ---------------------------------------------------------------------------
// Derived facts the reachability tier and the frame logic both need
// ---------------------------------------------------------------------------

/**
 * The variable names an expression READS.
 *
 * Used for two different honest disclosures rather than for encoding: the
 * per-variable two-valuedness sanity gate (a declared variable nothing reads or
 * writes is not state), and the frame-set minimization that makes a
 * `PROVED_UNDER_HYPOTHESES` finding actionable by naming the variables the proof
 * actually leaned on.
 *
 * A bare `ref` that is NOT a declared variable is an enum member and is skipped —
 * which is safe here precisely because {@link validateExpression} has already
 * refused any ref that is neither.
 */
export const readsOf = (expr: Expr, vars: DeclaredVars): ReadonlySet<string> => {
  const found = new Set<string>()
  const walk = (node: Expr): void => {
    switch (node.kind) {
      case 'bool':
      case 'int':
        return
      case 'ref':
        if (vars.has(node.name)) found.add(node.name)
        return
      case 'not':
        walk(node.operand)
        return
      case 'and':
      case 'or':
        for (const operand of node.operands) walk(operand)
        return
      case 'compare':
      case 'arith':
        walk(node.left)
        walk(node.right)
        return
    }
  }
  walk(expr)
  return found
}

/** The variable names an effect WRITES — the write set, read straight off the
 * assignment targets. This is what the frame logic partitions on. */
export const writesOf = (assignments: readonly Assignment[]): ReadonlySet<string> =>
  new Set(assignments.map((a) => a.target))

/**
 * Every declared variable an effect TOUCHES — its write targets plus everything the
 * assigned values read.
 *
 * Both halves, because both are references: `retry_count := retry_count + 1` writes
 * one variable and reads it, and a caller asking "does this expression depend on
 * `retry_count`" needs the union. Separated by {@link writesOf} / {@link readsOf}
 * where the distinction matters (the frame logic partitions on writes alone).
 */
export const touchedByEffect = (
  assignments: readonly Assignment[],
  vars: DeclaredVars,
): ReadonlySet<string> => {
  const found = new Set<string>(assignments.map((a) => a.target))
  for (const assignment of assignments) {
    for (const read of readsOf(assignment.value, vars)) found.add(read)
  }
  return found
}

/**
 * Every declared variable one expression SOURCE references, or `undefined` when the
 * source does not currently validate.
 *
 * The `undefined` return is the honest answer rather than an error: this exists for
 * the `unstate` guard, which asks "is this variable still referenced?" — and an
 * expression that ALREADY does not validate cannot be made worse by removing a
 * variable, so it must not block the removal. A document in that state has a
 * different, louder problem, and the reachability tier reports it as its own demotion.
 *
 * One function for both roles so the caller does not branch on `kind` twice (once to
 * validate and once to collect), which is where the two paths would drift.
 */
export const referencedNames = (
  source: string,
  model: StateModel,
  kind: 'effect' | 'constraint',
): ReadonlySet<string> | undefined => {
  const vars = declaredVars(model)
  if (kind === 'effect') {
    const assignments = validateEffect(source, model)
    if (isExprError(assignments)) return undefined
    return touchedByEffect(assignments, vars)
  }
  const expr = validateExpression(source, model, 'constraint')
  if (isExprError(expr)) return undefined
  return readsOf(expr, vars)
}
