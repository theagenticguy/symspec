/**
 * THE `AGENTS.md` PROJECTION — the whole agent-facing surface, derived from the kernel.
 *
 * ## Why the generator lives in `src/` and not in `scripts/`
 *
 * v4 put its generator in `scripts/gen-agents.ts` and the drift gate in a shell
 * pipeline, which meant the generator itself was outside the typechecker's `include` and
 * outside the test suite: nothing could assert what it produced except a byte-diff against
 * the committed file. So a bug in the generator was invisible until it had already been
 * committed into `AGENTS.md`.
 *
 * Here the RENDERER is a pure function in `src/`, typechecked and unit-tested like
 * everything else, and `scripts/gen-agents.ts` is a five-line shell around it. The drift
 * gate then compares the committed file against a function the tests already cover, which
 * is a strictly stronger arrangement: the tests say the projection is correct, and the gate
 * says the committed file is that projection.
 *
 * ## What is projected, and from where
 *
 * Nothing in this file states a fact about symspec in its own words. Every row and every
 * claim is read from a corpus:
 *
 * - operations, their summaries and their JSON-Schema inputs → the operations table;
 * - every code in the three catalogs, with severity, tier, and meaning → `./catalog.ts`;
 * - exit codes → the manifest, which reads them from `./exit.ts`'s constants;
 * - the envelope contract → `./envelope.ts`'s `API_VERSION`;
 * - the honest-scope disclosure → `./scope.ts`, all seven claims (unlike the installed
 *   skill, which quotes two — this surface can afford them);
 * - the authoring craft → `./craft.ts`.
 *
 * The consequence is the property the spec asks for: appending an operation or a code makes
 * it appear here with no edit to this file, and a description edit propagates on the next
 * regeneration or fails the gate.
 *
 * ## The one thing this file DOES own
 *
 * Document STRUCTURE — which sections exist and in what order. That is a presentation
 * decision with no corpus to read it from, and it is deliberately the only thing here that
 * is not a projection. The ordering is chosen for an agent reading top-to-bottom: what the
 * tool is, how to talk to it, what it can do, how to author for it, what it does not
 * promise, then the reference tables it will come back to.
 */

import { allCodes, type CodeEntry } from './catalog.ts'
import { renderCraft } from './craft.ts'
import { API_VERSION } from './envelope.ts'
import type { Manifest } from './operation.ts'
import { SCOPE_KEYS, scopeParagraphs } from './scope.ts'

/** The banner every generated file carries, so no one hand-edits it by mistake. */
export const GENERATED_BANNER = [
  '<!-- GENERATED FILE — do not edit by hand. -->',
  '<!-- Regenerate: pnpm gen:agents   (drift fails `pnpm check`) -->',
].join('\n')

/** Escape a cell so a pipe in a description cannot break the table. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()

/** The operations table, projected from the manifest. */
const operationsTable = (manifest: Manifest): string =>
  [
    '| Operation | What it does |',
    '|---|---|',
    ...manifest.operations.map((op) => `| \`symspec ${op.name}\` | ${cell(op.summary)} |`),
  ].join('\n')

/** The exit-code table, projected from the manifest. */
const exitTable = (manifest: Manifest): string =>
  [
    '| Code | Meaning |',
    '|---|---|',
    ...manifest.exitCodes.map((row) => `| **${row.code}** | ${cell(row.meaning)} |`),
  ].join('\n')

/**
 * A code table for one family.
 *
 * `ERR_*` gets two columns (code, meaning) because an operational error has no finding
 * severity or tier — publishing empty cells for both would imply the information is missing
 * rather than inapplicable. `FND_*` gets four (code, severity, tier, meaning) because those
 * are exactly the facts that decide what an agent does about a finding. `GTWR_*` gets
 * three, with severity replaced by a footnote, because GtWR severity is decided PER FINDING
 * and a column of `—` would be read as "no severity" rather than "contextual".
 */
const codeTable = (rows: readonly CodeEntry[], family: 'ERR' | 'FND' | 'GTWR'): string => {
  if (family === 'FND') {
    return [
      '| Code | Severity | Tier | Meaning |',
      '|---|---|---|---|',
      ...rows.map(
        (r) => `| \`${r.code}\` | ${r.severity ?? '—'} | ${r.tier ?? '—'} | ${cell(r.meaning)} |`,
      ),
    ].join('\n')
  }
  return [
    '| Code | Meaning |',
    '|---|---|',
    ...rows.map((r) => `| \`${r.code}\` | ${cell(r.meaning)} |`),
  ].join('\n')
}

/**
 * Render the whole `AGENTS.md`.
 *
 * PURE and byte-stable: no timestamps, no environment reads, no backend probe. That is what
 * makes the regenerate-and-diff gate meaningful — a gate over a generator that embedded a
 * clock would fail on every run and be disabled within a week.
 *
 * Takes the manifest as an ARGUMENT rather than calling `currentManifest()`, so a test can
 * render against a constructed manifest and assert the projection rather than only the
 * production output.
 */
export const renderAgentsDoc = (manifest: Manifest): string => {
  const codes = allCodes()
  const err = codes.filter((c) => c.family === 'ERR')
  const fnd = codes.filter((c) => c.family === 'FND')
  const gtwr = codes.filter((c) => c.family === 'GTWR')

  return `${GENERATED_BANNER}

# symspec — agent guide

symspec is a deterministic spec validator and authoring tool built for coding agents: EARS
requirements go in; structural, INCOSE GtWR lint, and formally-proven conflict findings come
out. Every operation answers in a typed JSON envelope, every finding and error carries a
stable code you can branch on, and this file plus \`symspec manifest\` are the complete
surface.

**Version:** \`${manifest.version}\` · **Envelope apiVersion:** \`${manifest.apiVersion}\` <!-- x-release-please-version -->

## Discover the surface

\`\`\`bash
symspec manifest                          # every operation, flag, and code as JSON
symspec explain --code FND_CONTRADICTION   # ONE code, without fetching the manifest
symspec install                            # drop this guidance into your agent host
\`\`\`

\`manifest\` is the machine-readable version of this document. \`explain\` answers for a
single code across all ${codes.length} of them (${err.length} \`ERR_*\`, ${fnd.length} \`FND_*\`, ${gtwr.length} \`GTWR_*\`) and returns
its family, severity, tier, meaning, remedy, and a worked example where the catalog carries
one — so a fix loop never pays for the whole contract to learn what one code means.

## Response envelope

Success (stdout, the zero-flag default):

\`\`\`json
{ "apiVersion": ${API_VERSION}, "type": "<operation>", "data": { } }
\`\`\`

Failure:

\`\`\`json
{ "apiVersion": ${API_VERSION}, "type": "error", "error": "<message>", "code": "ERR_*", "suggestions": ["..."], "partial": { }, "repair": { "ops": [], "commands": [] } }
\`\`\`

- \`type\` discriminates: the literal \`"error"\` is a failure, anything else is a success.
- Optional keys are **absent**, never \`null\` — \`partial\` and \`repair\` appear only when
  they carry information.
- \`--dense\` minifies and elides the heavy \`evidence\` payload (\`--evidence\` keeps it);
  \`--pretty\` renders prose for a human; \`--field data.verified,data.findings.0.code\`
  projects the envelope down to dotted paths. None of the three ever changes the exit code.
- Document path resolution: the positional path → \`SYMSPEC_DOC\` → \`./requirements.json\`.

### Exit codes

${exitTable(manifest)}

### The agent loop is first-class

- Every \`data.coverage.demotions[]\` entry and most error envelopes carry
  \`repair: {ops, commands}\`. \`ops\` are records \`symspec apply\` decodes **by
  construction**; \`commands\` run verbatim. **No placeholders.**
- \`data.progress\` is the convergence gradient: \`demotions\`, \`openFindings\` (error
  severity only), and \`atomsUncompared\`. All three at zero is the fixed point. If none moved
  after a repair batch, the batch did nothing.
- \`data.budgetHint\` appears when a run has something measured to say about its own
  \`--solver-budget-ms\`: \`{recommendedBudgetMs, reason, basis, rationale}\`, extrapolated
  from the work THIS run completed and the time it took. Absent on an unbounded run and on a
  run with comfortable headroom — the absence is the all-clear.

## Operations

${operationsTable(manifest)}

${renderCraft(2)}

## Honest scope — read before trusting a verdict

All ${SCOPE_KEYS.length} claims, verbatim:

${scopeParagraphs()
  .map((claim) => `> ${claim}`)
  .join('\n>\n')}

## Error codes (\`ERR_*\`)

An operational failure. The envelope's \`type\` is \`"error"\` and the process exits 2.
No finding severity applies — an \`ERR_*\` replaces the result rather than appearing inside
one.

${codeTable(err, 'ERR')}

## Finding codes (\`FND_*\`)

A finding inside a **successful** \`check\`. Only \`error\` severity gates the exit code, and
an error-severity finding also excludes its requirement from the formal tier.

${codeTable(fnd, 'FND')}

## Lint rule codes (\`GTWR_*\`)

INCOSE Guide to Writing Requirements rules, all on the \`lint\` tier.

**Severity is decided PER FINDING, not per code.** The legitimate-exception rules
(R16/R26/R32/R35) downgrade contextually — an absolute qualified by a conditional clause is
\`warn\` where a bare one is \`error\`. Read each finding's own \`severity\` field.

${codeTable(gtwr, 'GTWR')}
`
}
