/**
 * THE INSTALLED SKILL BODY — generated from the ops table, the craft corpus, and the
 * scope corpus (spec AC-A-5).
 *
 * ## Thin pointer, plus the one thing a pointer cannot delegate
 *
 * The donor's skill body was deliberately a THIN POINTER: run `symspec manifest` first,
 * state the one honesty caveat, do not restate every flag. That discipline is right and
 * survives here — the codegraph lesson is that a skill duplicating the tool docs drifts
 * from them, and the manifest is the surface that cannot drift because it IS the tool.
 *
 * But a pointer only works for facts the pointee carries. The manifest carries every
 * command, flag, code, and exit code — and it carries NOTHING about how to write a
 * requirement, because there is no schema field for "align your vocabulary before you
 * start". So the craft corpus is the one thing this body must actually TEACH rather than
 * point at, which is what donor AC-3-6 was asking for when it measured both surfaces at
 * ~85% reference tables.
 *
 * The split, stated as a rule: **reference material is pointed at, craft is taught.**
 *
 * ## Everything here is a projection
 *
 * - the command list comes from the operations table (`../operations/index.ts`), so a new
 *   operation appears in every installed skill with no edit here;
 * - the craft sections come from `../kernel/craft.ts`;
 * - the honesty caveat comes from `../kernel/scope.ts`, and only the two essential claims
 *   — a body that quoted all seven would stop being thin.
 *
 * Nothing in this file restates a summary, a code meaning, or a scope claim in its own
 * words. `install.test.ts` asserts the command list matches the live table, which is what
 * makes that a property rather than an intention.
 */

import { REACHABILITY_FND_CODES } from '../formal/reachability-codes.ts'
import { catalogCounts } from '../kernel/catalog.ts'
import { renderCraft } from '../kernel/craft.ts'
import { SCOPE_ESSENTIAL } from '../kernel/scope.ts'
import { allOperations } from '../operations/index.ts'

/**
 * The operations worth naming in the body's core loop, in the order an author meets
 * them.
 *
 * A SUBSET, and deliberately so: the body lists the loop, not the surface. `symspec
 * manifest` is one command away and carries all 17 with their full schemas, so
 * enumerating every one here would be the duplication the thin-pointer rule exists to
 * prevent.
 *
 * Every id is checked against the live table at render time (see {@link buildSkillBody}),
 * so a renamed or removed operation is a loud failure rather than a stale line in an
 * installed file nobody re-reads.
 */
const CORE_LOOP = [
  'manifest',
  'init',
  'parse',
  'add',
  'apply',
  'check',
  'explain',
  'glossary',
  'antonym',
  'waive',
] as const

/**
 * Build the shared skill body — no frontmatter, which each target layers on.
 *
 * Pure and deterministic: the same corpora produce byte-identical output, so the installed
 * artifact is drift-checkable the same way `AGENTS.md` is. `binName` is threaded through
 * rather than hard-coded so the generator renders correctly for a differently-named
 * install, and so the tests can prove no command string is a hard-coded literal.
 *
 * Throws when {@link CORE_LOOP} names an operation the table does not hold. That is the
 * single-source guard at this seam: a hand-written list of command names is exactly where
 * an installed skill would start telling an agent to run something that does not exist —
 * which is the defect the donor shipped when its manifest told agents to run
 * `apply --file` against a command registered as `--doc`.
 */
export const buildSkillBody = (binName = 'symspec'): string => {
  const table = new Map(allOperations().map((op) => [op.name, op.summary]))
  // INTERPOLATED, never written out. The body said "all 75 stable codes" through G3, and
  // G4 grew the vocabulary to 80 without either sentence noticing — an installed file
  // telling an agent the tool has 75 codes while `explain` resolves 80 of them. Reading the
  // count from the catalog makes the number a projection like everything else here, so the
  // next append cannot leave a stale claim in a file nobody re-reads.
  const counts = catalogCounts()

  const loop = CORE_LOOP.map((name) => {
    const summary = table.get(name)
    if (summary === undefined) {
      throw new Error(
        `The skill body's core loop names "${name}", which is not in the operations table. ` +
          'Every command the installed skill mentions must be a projection of the table — ' +
          'otherwise an installed file tells an agent to run a command that does not exist.',
      )
    }
    // The summary is READ from the table, never restated.
    return `- \`${binName} ${name}\` — ${summary}`
  }).join('\n')

  return `# symspec — authoring and validating EARS requirements

symspec is a deterministic, agent-first CLI for AUTHORING and CHECKING EARS
software-requirements specs. Requirements go in; structural, INCOSE GtWR lint, and
formally-proven conflict findings come out — every command answers in a typed JSON
envelope with stable, branchable codes.

## Discover the surface first

Run this ONCE before driving symspec. It is the machine-readable source of truth for every
command, argument, and code, and it cannot drift from the tool because it is generated from
the tool:

\`\`\`bash
${binName} manifest
\`\`\`

It lists every operation with its JSON-Schema arguments, all ${counts.total} stable codes across the
three catalogs (${counts.ERR} \`ERR_*\` operational failures, ${counts.FND} \`FND_*\` check findings,
${counts.GTWR} \`GTWR_*\` lint rules), the envelope shape, and the exit-code contract. Prefer it over
guessing a flag.

For ONE code, do not fetch the manifest — ask directly:

\`\`\`bash
${binName} explain --code FND_CONTRADICTION
\`\`\`

That returns the code's family, severity, tier, meaning, remedy, and a worked example
where one exists, for any of the ${counts.total} — including the ${REACHABILITY_FND_CODES.length} \`FND_REACHABILITY_*\` codes the
unbounded state-model tier emits.

## The core loop

${loop}

Typical flow: \`init\` a document, then either \`parse\` prose into apply-ready ops or
\`add\` requirements with explicit EARS slots, \`apply\` a batch, \`check\` to surface
findings, fix, re-\`check\`. Every command emits a JSON envelope by default; add
\`--dense\` for token-lean output and \`--pretty\` only when a human is reading.

**Exit codes:** 0 clean, 1 at least one error-severity finding (a valid envelope is still
on stdout), 2 an \`ERR_*\` operational failure, 3 an opt-in strict gate tripped.

**Repairs are structured.** Every demotion in \`data.coverage.demotions\` and most error
envelopes carry \`repair: {ops, commands}\` — \`ops\` pipe into \`${binName} apply\`,
\`commands\` run verbatim. No placeholders. \`data.progress\` is the convergence gradient
(\`demotions\`, \`openFindings\`, \`atomsUncompared\`); all three at zero is the fixed
point.

## What symspec guarantees — and does not

${SCOPE_ESSENTIAL.map((claim) => `> ${claim}`).join('\n>\n')}

Treat a clean \`check\` as "no conflict was PROVEN", not "the spec is proven consistent".
Findings carry an atom table and unsat core as machine-checkable evidence, so a reported
conflict is auditable and real.

---

# How to author a spec symspec can actually check

The reference material above is discoverable from the tool. This part is not: it is the
craft of writing requirements that the solver can reason about, and skipping it is why a
document passes while containing a contradiction.

${renderCraft(2)}
`
}
