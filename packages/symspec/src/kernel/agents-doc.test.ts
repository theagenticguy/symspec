/**
 * `AGENTS.md` — the projection is correct, and the COMMITTED file is that projection.
 *
 * ## The two claims, and why they need separate tests
 *
 * The `check:agents` shell gate answers only "is the committed file what the generator
 * produces". That is necessary and not sufficient: a generator that dropped every code
 * table would pass its own diff gate forever, because the committed file would be
 * regenerated to match. The donor's arrangement had exactly that hole — the generator lived
 * in `scripts/`, outside the typechecker and outside the tests, so nothing could assert
 * what it SHOULD contain.
 *
 * So this file asserts the projection is COMPLETE (every operation, all 75 codes, every
 * scope claim, every craft section, verbatim from their corpora), and the cross-boundary
 * check that the committed file matches is the shell gate in `pnpm check`. Neither alone is
 * enough; the pair is.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { allOperations, currentManifest } from '../operations/index.ts'
import { GENERATED_BANNER, renderAgentsDoc } from './agents-doc.ts'
import { allCodes } from './catalog.ts'
import { CRAFT_SECTIONS } from './craft.ts'
import { API_VERSION } from './envelope.ts'
import {
  EXIT_CLEAN,
  EXIT_FINDINGS_FAILURE,
  EXIT_INCONCLUSIVE,
  EXIT_OPERATIONAL_ERROR,
} from './exit.ts'
import { SCOPE_KEYS, scopeParagraphs } from './scope.ts'
import { VERSION } from './version.ts'

const doc = (): string => renderAgentsDoc(currentManifest())

/** The COMMITTED file, read from disk — the other side of the drift gate. */
const committed = (): string =>
  readFileSync(fileURLToPath(new URL('../../AGENTS.md', import.meta.url)), 'utf8')

// ---------------------------------------------------------------------------
// Determinism — the property the drift gate rests on
// ---------------------------------------------------------------------------

describe('the generated doc is byte-stable', () => {
  /**
   * A gate over a generator that embedded a clock, a cwd, or a backend probe would fail on
   * every run and be disabled within a week. This is the assertion that keeps the gate
   * worth having.
   */
  it('renders identical bytes across calls', () => {
    expect(doc()).toBe(doc())
  })

  it('carries the do-not-edit banner with the regeneration command', () => {
    expect(doc().startsWith(GENERATED_BANNER)).toBe(true)
    expect(GENERATED_BANNER).toContain('gen:agents')
    expect(GENERATED_BANNER).toContain('do not edit by hand')
  })

  it('embeds no timestamp, no absolute path, and no environment value', () => {
    const rendered = doc()
    // A date, a home directory, or a node version in the output would make the gate
    // machine-dependent — green on the author's box and red in CI.
    expect(rendered).not.toMatch(/\b20\d{2}-\d{2}-\d{2}T/)
    expect(rendered).not.toContain('/mnt/')
    expect(rendered).not.toContain(process.cwd())
    expect(rendered).not.toContain(process.version)
  })
})

// ---------------------------------------------------------------------------
// The projection is COMPLETE — the half the shell gate cannot check
// ---------------------------------------------------------------------------

describe('every operation is projected, with the table`s own summary', () => {
  it('lists all 21 operations', () => {
    const rendered = doc()
    const operations = allOperations()
    // 18 through G3, plus G4's three reachability-authoring ops (`state`,
    // `state-initial`, `classify`). Pinned as a NUMBER rather than derived from
    // `allOperations()` so growing the agent-facing surface is a visible edit in
    // review — the count is the point, not a restatement of the array's length.
    expect(operations.length).toBe(21)
    for (const op of operations) {
      expect(rendered, `${op.name} is missing from AGENTS.md`).toContain(`\`symspec ${op.name}\``)
    }
  })

  it('quotes each summary VERBATIM, never paraphrased', () => {
    // The single-source claim at the seam where it would break. A paraphrase here is how
    // the donor ended up documenting `apply --file` for a command registered as `--doc`.
    const rendered = doc()
    for (const op of allOperations()) {
      expect(rendered, `${op.name}'s summary was paraphrased`).toContain(
        `| \`symspec ${op.name}\` | ${op.summary} |`,
      )
    }
  })
})

describe('all 75 codes are projected, in all three families', () => {
  it('names every code from every catalog', () => {
    const rendered = doc()
    const codes = allCodes()
    expect(codes).toHaveLength(75)
    for (const row of codes) {
      expect(rendered, `${row.code} is missing`).toContain(`\`${row.code}\``)
    }
  })

  it('publishes severity AND tier for the FND_* family, where they decide the response', () => {
    const rendered = doc()
    expect(rendered).toContain('| Code | Severity | Tier | Meaning |')
    // Spot-check the shape on the code an agent most often has to act on.
    expect(rendered).toContain('| `FND_CONTRADICTION` | error | formal |')
    // And the honest dual severity, uncollapsed.
    expect(rendered).toContain('| `FND_AMBIGUOUS_QUANTIFIER` | warn/info | lint |')
  })

  it('does NOT print an empty severity column for ERR_* or GTWR_*', () => {
    // Two columns for ERR_* (no finding severity applies — an ERR_* replaces the result),
    // and a footnote instead of a column of `—` for GTWR_* (severity is per finding).
    // A column of dashes would read as "unknown" rather than "inapplicable".
    const rendered = doc()
    expect(rendered).toContain('## Error codes (`ERR_*`)')
    expect(rendered).toContain('## Lint rule codes (`GTWR_*`)')
    expect(rendered).toContain('Severity is decided PER FINDING, not per code')
    expect(rendered).not.toContain('| `ERR_USAGE` | — |')
    expect(rendered).not.toContain('| `GTWR_R1_PATTERN` | — |')
  })

  it('escapes a pipe so a description cannot break a table', () => {
    // `FND_AMBIGUOUS_QUANTIFIER`'s meaning contains "and…or" phrasing and several codes
    // carry slashes; a raw `|` anywhere in a cell would silently split the row.
    const rendered = doc()
    for (const line of rendered.split('\n')) {
      if (!line.startsWith('| `')) continue
      // Every table row must have a consistent cell count for its section, which fails
      // first if an unescaped pipe crept in. Checking that no cell is empty catches the
      // split-row shape.
      const cells = line.split(/(?<!\\)\|/).slice(1, -1)
      expect(cells.length, `malformed row: ${line.slice(0, 80)}`).toBeGreaterThanOrEqual(2)
      for (const cellText of cells) {
        expect(cellText.trim().length, `empty cell in: ${line.slice(0, 80)}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('the contract sections are projected from their constants', () => {
  it('publishes all four exit codes with their meanings', () => {
    const rendered = doc()
    for (const code of [
      EXIT_CLEAN,
      EXIT_FINDINGS_FAILURE,
      EXIT_OPERATIONAL_ERROR,
      EXIT_INCONCLUSIVE,
    ]) {
      expect(rendered, `exit ${code}`).toContain(`| **${code}** |`)
    }
    for (const row of currentManifest().exitCodes) {
      expect(rendered).toContain(row.meaning)
    }
  })

  it('publishes the envelope apiVersion from the constant, not a literal', () => {
    expect(doc()).toContain(`"apiVersion": ${API_VERSION}`)
  })

  it('publishes the package version', () => {
    expect(doc()).toContain(VERSION)
  })

  it('documents the THREE v5 agent-loop fields', () => {
    const rendered = doc()
    // repair (AC-A-1), progress (AC-A-2), budgetHint (AC-A-8) — the fields that make the
    // envelope a work list rather than a verdict.
    expect(rendered).toContain('repair: {ops, commands}')
    expect(rendered).toContain('data.progress')
    expect(rendered).toContain('data.budgetHint')
    // And the honest statement about when budgetHint is absent.
    expect(rendered).toContain('the absence is the all-clear')
  })
})

describe('the scope and craft corpora are projected whole', () => {
  it('quotes ALL seven scope claims verbatim — unlike the thin skill body', () => {
    const rendered = doc()
    const paragraphs = scopeParagraphs()
    expect(paragraphs).toHaveLength(SCOPE_KEYS.length)
    for (const claim of paragraphs) {
      expect(rendered, 'a scope claim is missing or paraphrased').toContain(claim)
    }
  })

  it('carries every craft section', () => {
    const rendered = doc()
    for (const section of CRAFT_SECTIONS) {
      expect(rendered, section.id).toContain(section.title)
    }
    // And the worked example's measured numbers, which are the part that makes the section
    // convincing rather than merely advisory.
    expect(rendered).toContain('atomsUncompared')
    expect(rendered).toContain('antonym')
  })

  it('renders craft sub-headings at the right depth under the section', () => {
    const rendered = doc()
    expect(rendered).toContain('## Anti-patterns, and the code each one actually fires')
    expect(rendered).toContain('### Compound requirement')
  })
})

// ---------------------------------------------------------------------------
// The committed file IS the projection
// ---------------------------------------------------------------------------

describe('the committed AGENTS.md matches the generator', () => {
  /**
   * The same claim `pnpm check:agents` makes at the shell, asserted in-process too.
   *
   * Both, deliberately. The shell gate is what fails a `pnpm check` on a stale commit and
   * it is the one a pre-push hook can run cheaply; this one gives the failure a NAME and a
   * diff inside the suite, so an agent that ran only `vitest` still learns the file is
   * stale rather than discovering it at push time.
   */
  it('is byte-identical to a fresh render', () => {
    expect(committed()).toBe(doc())
  })

  it('is a substantial document, not a stub', () => {
    // A guard against a generator regression that produced a valid-looking header and
    // nothing else — which would pass every `toContain` above if the corpora were empty,
    // but cannot pass this.
    const bytes = committed().length
    expect(bytes).toBeGreaterThan(30_000)
  })
})
