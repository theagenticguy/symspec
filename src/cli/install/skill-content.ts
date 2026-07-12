/**
 * The symspec skill body — single-sourced, like the manifest and AGENTS.md.
 *
 * `symspec install` drops a skill/rule file into each detected host's config
 * dir. The BODY of that file is generated here from the SAME corpora that feed
 * the manifest and the generated AGENTS.md — the one-line command summaries
 * (`descriptions.ts`) and the honest-scope disclosure (`scope-text.ts`) — so an
 * installed skill can never teach an agent something the manifest contradicts.
 * Per-host frontmatter (Claude/Cursor/Codex `name`+`description`, Kiro
 * `inclusion`, Windsurf `trigger`, Copilot `applyTo`) is layered on by each
 * target; this module owns only the shared prose.
 *
 * The content is deliberately a THIN POINTER, not a second copy of the tool
 * docs (the lesson codegraph learned the hard way): it teaches the agent to run
 * `symspec manifest` first — the real self-describing surface — and states the
 * one load-bearing honesty caveat, rather than duplicating every command's
 * flags (which would drift). One short trigger sentence + the manifest-first
 * instruction + the loop + the caveat is everything an agent needs to START
 * using symspec correctly; the manifest carries the rest.
 */

import { COMMAND_SUMMARIES } from '../descriptions.js'
import { SCOPE } from '../scope-text.js'

/** The skill's stable identifier — its directory/file name across hosts. */
export const SKILL_NAME = 'symspec'

/**
 * The one-line description hosts match on to decide relevance (Claude/Cursor/
 * Codex `description`, Windsurf model_decision, Kiro auto). Names the concrete
 * triggers — EARS, requirements, spec conflicts — so a host's relevance matcher
 * fires on the right prompts, not on every mention of "check".
 */
export const SKILL_DESCRIPTION =
  'Validate and lint EARS software-requirements specs with symspec — a deterministic ' +
  'CLI that parses requirements, runs INCOSE GtWR lint, and formally proves ' +
  'contradictions/subsumption/redundancy via Z3 SMT with unsat-core evidence. Use when ' +
  'writing, editing, linting, or checking a requirements document (requirements.json), ' +
  'authoring EARS requirements, or looking for conflicts between requirements.'

/** The commands worth surfacing in the skill body, in the order an author meets them. */
const HIGHLIGHT_COMMANDS = [
  'manifest',
  'init',
  'add',
  'apply',
  'check',
  'update',
  'waive',
  'certify',
] as const

/**
 * Build the shared skill body (no frontmatter). `binName` is the on-PATH binary
 * (`symspec`), threaded in so the same generator can render for a differently
 * named install if that ever happens. Pure and deterministic: same corpora →
 * byte-identical body, so the install artifact is drift-checkable the same way
 * AGENTS.md is.
 */
export function buildSkillBody(binName = 'symspec'): string {
  const commandList = HIGHLIGHT_COMMANDS.map(
    (name) => `- \`${binName} ${name}\` — ${COMMAND_SUMMARIES[name]}`,
  ).join('\n')

  return `# symspec — EARS requirements validation

symspec is a deterministic, agent-first CLI for authoring and checking EARS
software-requirements specs. Requirements go in; structural, INCOSE GtWR lint,
and formally-proven conflict findings come out — every command answers in a
typed JSON envelope with stable, branchable error/finding codes.

## Discover the surface first

Run this ONCE before driving symspec — it is the machine-readable source of
truth for every command, argument, and code, and it never drifts from the tool:

\`\`\`bash
${binName} manifest
\`\`\`

The manifest lists every command with its JSON-Schema arguments, the closed
\`ERR_*\`/\`GTWR_*\`/\`FND_*\` code catalogs you branch on, the envelope \`type\` set,
and a live \`backends\` report (Z3 WASM is always available; external z3/cvc5 and
a Lean toolchain are reported if present). Prefer it over guessing flags.

## The core loop

${commandList}

Typical flow: \`init\` a document, \`add\` requirements (or \`apply\` a JSONL batch of
ops in one shot), \`check\` to surface findings, fix, re-\`check\`, then optionally
\`certify\`. Every command takes \`--dense\` for token-lean output and defaults to a
JSON envelope; add \`--pretty\` only when a human is reading.

## What symspec guarantees — and does not

${SCOPE.soundness}

${SCOPE.silence}

Treat a clean \`check\` as "no conflict was PROVEN", not "the spec is proven
consistent". Findings carry an atom table / unsat core as machine-checkable
evidence, so a reported conflict is auditable and real.
`
}
