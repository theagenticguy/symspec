/**
 * Portable SMT-LIB2 artifact emitter (AC-4-8).
 *
 * `--emit-smt2` gives the calling agent a standard-conformant `.smt2` text
 * file it can hand to ANY SMT-LIB2-compliant reader — not just the in-process
 * `z3-solver` WASM backend this package ships by default. Two portability
 * rules, both load-bearing (research-smt.md §0, §1.3, §3.3; spec AC-4-8):
 *
 *   1. Declare `(set-logic ALL)`. cvc5 requires an explicit `set-logic`
 *      before assertions; Z3 tolerates `ALL` too, so this is the one logic
 *      string both solvers accept for symspec's propositional (`Bool`-only)
 *      encoding (research-smt.md §1.6, §3.3).
 *   2. NEVER bake a solver-specific option into the emitted prelude. The
 *      concrete example the spec calls out is Z3's core-minimization knob
 *      (`(set-option :smt.core.minimize true)`) — real, and used by the
 *      in-process contradiction path (AC-4-4), but NOT standard SMT-LIB2 and
 *      rejected/ignored unpredictably by other readers. The only `set-option`
 *      this module emits is `:produce-unsat-cores true`, which the SMT-LIB2
 *      standard itself defines and both Z3 and cvc5 honor identically.
 *
 * Encoding shape emitted, matching {@link encode}/{@link EncodedRequirement}
 * exactly so the artifact is a faithful export of what the in-process backend
 * checks (AC-4-2, AC-4-3):
 *
 *   (set-option :produce-unsat-cores true)
 *   (set-logic ALL)
 *   (declare-const |guard| Bool)              ; one per requirement id (the assumption literal)
 *   (declare-const |atom| Bool)               ; one per atom-table entry (trig/pre/resp)
 *   (assert guardedFormula)                   ; one per requirement — `guard ⇒ body`
 *   (assert |contextAtom|)                    ; one per asserted context atom
 *   (check-sat-assuming (|guard1| |guard2| …))
 *   (get-unsat-core)
 *
 * `check-sat-assuming` with the requirement-id guards as assumption literals
 * (rather than `:named` assertions) mirrors the in-process `solver.check(g1,
 * g2, …)` call in `contradiction.ts`/`subsumption.ts` exactly, and sidesteps a
 * real portability trap: each `formula` is already `guard ⇒ body` where
 * `guard` is the SAME Bool const asserted as the assumption, so wrapping the
 * assertion in `(! … :named guard)` would try to redeclare a name that
 * collides with the already-declared `guard` constant — verified live against
 * `z3 4.16.0` (`invalid named expression, declaration already defined with
 * this name`). `check-sat-assuming` is a top-level SMT-LIB2 command (2.6+)
 * both Z3 and cvc5 implement, and the CLI invocations from research-smt.md
 * §1.3/§2.2 (`z3 file.smt2`, `cvc5 --produce-unsat-cores file.smt2`) run this
 * artifact with zero extra flags — it is fully self-contained.
 *
 * Pure and Z3-free: this module only reads the plain-data {@link Formula} AST
 * and {@link EncodedRequirement} shapes from `encode.ts`; it never imports
 * `z3-solver` or `backend.ts`, so `--emit-smt2` never pays the WASM init cost
 * (unlike the in-process solving path).
 */

import type { AtomTableEntry, EncodedRequirement, Formula } from './encode.js'

/** Options controlling what gets asserted alongside the encoded requirements. */
export interface EmitSmt2Options {
  /**
   * Context atoms to assert `true` (the reachability discipline from AC-4-3 —
   * e.g. a single context group's trigger/precondition atoms). Defaults to
   * none (the baseline empty-context check).
   *
   * Mutually exclusive with {@link contextGroups}: this option emits ONE
   * check-sat for ONE group, which is the right shape for a caller that is
   * already looping groups itself (the binary cross-check does exactly that,
   * because {@link runSolverBinary} parses a single verdict).
   */
  contextAtoms?: readonly string[]
  /**
   * Context groups to sweep in a SINGLE self-contained artifact (AC-1-3): one
   * `push`/`assert context`/`check-sat-assuming`/`get-unsat-core`/`pop` block
   * per group, in the given order.
   *
   * This is what makes an exported `--emit-smt2` file answer the same QUESTION
   * the in-process tier answers. Emitting the guarded formulas alone is not a
   * weaker check, it is a DIFFERENT one: `(X ⇒ Y) ∧ (X ⇒ ¬Y)` is satisfiable by
   * setting `X` false, so without asserting a context reachable, an external
   * solver reports `sat` on precisely the conflicts symspec exists to find.
   * Verified: on a two-requirement grant/revoke contradiction the in-process
   * tier proved `unsat` while `z3` on the old single-block artifact said `sat`.
   *
   * Takes precedence over {@link contextAtoms} when both are supplied.
   */
  contextGroups?: readonly { readonly key: string; readonly contextAtoms: readonly string[] }[]
}

/**
 * Quote an SMT-LIB2 symbol as a `|...|`-delimited quoted symbol so ANY
 * atom/requirement-id text is safe to declare/name, regardless of spaces,
 * hyphens, or other characters not in the simple-symbol charset. `|` and `\`
 * are themselves illegal inside a quoted symbol per the SMT-LIB2 spec, so we
 * defensively strip them rather than emit a file that fails to parse — atom
 * names and requirement ids never legitimately contain those characters in
 * this pipeline (AC-4-2a normalization never produces `|`/`\`).
 */
function quoteSymbol(name: string): string {
  const sanitized = name.replace(/[|\\]/g, '_')
  return `|${sanitized}|`
}

/** Render a {@link Formula} AST as SMT-LIB2 s-expression text. */
function renderFormula(f: Formula): string {
  switch (f.op) {
    case 'atom':
      return quoteSymbol(f.name)
    case 'not':
      return `(not ${renderFormula(f.arg)})`
    case 'and':
      return `(and ${f.args.map(renderFormula).join(' ')})`
    case 'or':
      return `(or ${f.args.map(renderFormula).join(' ')})`
    case 'implies':
      return `(=> ${renderFormula(f.lhs)} ${renderFormula(f.rhs)})`
    case 'cmp': {
      // AC-30-1: an arithmetic comparison over a Real quantity variable. `!=`
      // has no direct SMT-LIB2 operator, so it renders as `(not (= …))`.
      const q = quoteSymbol(f.quantity)
      const v = String(f.value)
      const OP: Record<typeof f.comparator, string> = {
        '<': '<',
        '<=': '<=',
        '=': '=',
        '>=': '>=',
        '>': '>',
        '!=': 'distinct',
      }
      return `(${OP[f.comparator]} ${q} ${v})`
    }
  }
}

/** Collect the distinct atom names referenced across a set of encoded requirements. */
function collectAtomNames(encoded: readonly EncodedRequirement[]): string[] {
  const names = new Set<string>()
  for (const e of encoded) {
    for (const a of e.atoms as readonly AtomTableEntry[]) names.add(a.atom)
  }
  return [...names].sort()
}

/**
 * Emit a standard-conformant SMT-LIB2 text artifact for a set of encoded
 * requirements (AC-4-8).
 *
 * Deterministic: atom declarations and requirement assertions are both
 * emitted in a stable sort order (atoms lexicographically by name,
 * requirements by their `id`), so byte-identical input always produces
 * byte-identical output — the same discipline the encoder/atomizer hold
 * upstream (AC-4-2, AC-4-2a).
 *
 * Pure: no solver contact, no filesystem I/O. The caller (`--emit-smt2` CLI
 * wiring) is responsible for writing the returned string to disk.
 */
export function emitSmt2(
  encoded: readonly EncodedRequirement[],
  options: EmitSmt2Options = {},
): string {
  const contextAtoms = options.contextAtoms ?? []
  const sortedReqs = [...encoded].sort((a, b) => a.id.localeCompare(b.id))
  const atomNames = collectAtomNames(sortedReqs)
  const guardNames = [...new Set(sortedReqs.map((r) => r.guard))].sort()

  const lines: string[] = []
  lines.push('(set-option :produce-unsat-cores true)')
  lines.push('(set-logic ALL)')
  lines.push('')
  lines.push('; Assumption-literal guards (AC-4-4) — one Bool per requirement id.')
  for (const name of guardNames) {
    lines.push(`(declare-const ${quoteSymbol(name)} Bool)`)
  }
  lines.push('')
  lines.push(
    '; Atom table (AC-4-2a) — one Boolean per distinct trigger/precondition/response atom.',
  )
  for (const name of atomNames) {
    lines.push(`(declare-const ${quoteSymbol(name)} Bool)`)
  }
  lines.push('')
  lines.push('; Guarded requirement formulas (AC-4-2) — `guard ⇒ (context ⇒ response)`.')
  for (const req of sortedReqs) {
    lines.push(`(assert ${renderFormula(req.formula)})`)
  }
  const assuming = `(check-sat-assuming (${guardNames.map(quoteSymbol).join(' ')}))`

  // AC-1-3 — multi-group sweep in one artifact. Each group is scoped by
  // push/pop so its context assertions cannot leak into the next group: two
  // mutually exclusive triggers asserted together would fake a conflict, which
  // is the exact unsoundness `planContextGroups` upstream exists to prevent.
  if (options.contextGroups !== undefined) {
    for (const group of options.contextGroups) {
      const sorted = [...group.contextAtoms].sort()
      lines.push('')
      lines.push(
        `; ── Context group ${group.key === '' ? '<baseline: no context asserted>' : `[${sorted.join(' ')}]`}`,
      )
      lines.push('(push 1)')
      for (const name of sorted) {
        lines.push(`(assert ${quoteSymbol(name)})`)
      }
      lines.push(assuming)
      lines.push('(get-unsat-core)')
      lines.push('(pop 1)')
    }
    lines.push('')
    return lines.join('\n')
  }

  if (contextAtoms.length > 0) {
    lines.push('')
    lines.push(
      "; Context reachability (AC-4-3) — the group's trigger/precondition atoms asserted true.",
    )
    for (const name of [...contextAtoms].sort()) {
      lines.push(`(assert ${quoteSymbol(name)})`)
    }
  }
  lines.push('')
  lines.push(assuming)
  lines.push('(get-unsat-core)')
  lines.push('')

  return lines.join('\n')
}
