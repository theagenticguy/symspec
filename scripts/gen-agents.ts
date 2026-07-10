/**
 * AGENTS.md generator (AC-7-1, AC-7-5).
 *
 * Derives the committed AGENTS.md ENTIRELY from the live manifest — the same
 * `buildManifest()` the `symspec manifest` command emits — plus the honest-
 * scope constants. There is no hand-maintained prose about commands or codes
 * in the output: mutate a `.describe()` and the regenerated doc changes,
 * which is the whole anti-drift design (agent-friendly-cli pattern #8).
 *
 * Deterministic by construction: `buildManifest()` is pure/byte-stable (no
 * backends probe, no timestamps), so `gen:agents` twice yields identical
 * bytes and the `check:agents` diff gate (lefthook pre-push) is meaningful.
 *
 * Usage:
 *   pnpm gen:agents          # regenerate AGENTS.md in place
 *   pnpm check:agents        # regenerate to a temp file and diff (CI gate)
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildManifest, type ManifestCode } from '../src/cli/manifest.js'

const manifest = buildManifest()

function codeTable(rows: readonly ManifestCode[]): string {
  const lines = ['| Code | Meaning |', '|---|---|']
  for (const { code, description } of rows) {
    lines.push(`| \`${code}\` | ${description ?? ''} |`)
  }
  return lines.join('\n')
}

function commandTable(): string {
  const lines = ['| Command | What it does |', '|---|---|']
  for (const { name, summary } of manifest.commands) {
    lines.push(`| \`symspec ${name}\` | ${summary} |`)
  }
  return lines.join('\n')
}

const doc = `<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: pnpm gen:agents   (drift fails the pre-push gate) -->

# symspec — agent guide

symspec is a deterministic spec validator built for coding agents: EARS
requirements go in; structural, lint, and formally proven conflict findings
come out. Every command answers in a typed JSON envelope, every error carries
a stable code you can branch on, and this file plus \`symspec manifest\` are
the complete surface — no other docs are needed to drive the tool.

## Install and discover

\`\`\`bash
pnpm build && pnpm pack           # produce the tarball from a checkout
npm install -g ./symspec-*.tgz    # 'symspec' lands on PATH
symspec manifest                  # one JSON blob: every command, flag, code
\`\`\`

The manifest is the machine-readable version of this document: commands with
JSON-Schema argument shapes, the envelope \`type\` set, all three code
catalogs, backend availability (\`symspec manifest\` reports whether the
z3/cvc5 binaries or a Lean toolchain are present — the built-in Z3 WASM
backend is always available), and the honest-scope disclosure quoted below.

## Response envelope

Success (stdout, default output — \`--json\` is a no-op alias):

\`\`\`json
{ "apiVersion": ${manifest.apiVersion}, "type": "<command>", "data": { } }
\`\`\`

Failure:

\`\`\`json
{ "apiVersion": ${manifest.apiVersion}, "type": "error", "error": "<message>", "code": "ERR_*", "suggestions": ["..."], "partial": { } }
\`\`\`

- \`type\` is a closed discriminant set (see the manifest \`types\` array):
  ${manifest.types.map((t) => `\`${t}\``).join(', ')}.
- Exit codes: **0** clean (warn/info findings do not fail), **1** at least one
  error-severity finding (success envelope still on stdout), **2** an
  \`ERR_*\` operational failure (error envelope on stdout).
- \`--dense\` minifies and strips defaults/evidence for token-lean piping
  (add \`--evidence\` to keep evidence); \`--pretty\` renders prose for humans.
- Doc path resolution: positional file → \`SYMSPEC_DOC\` env → \`./requirements.json\`.

## Commands

${commandTable()}

## Recommended workflow

1. \`symspec init\` a document (or point \`SYMSPEC_DOC\` at one).
2. Author requirements: \`symspec add\` with explicit EARS slots, or
   \`symspec add --from-parse "When the user logs out, the auth service shall
   invalidate the session token."\` to parse prose, or \`symspec parse --file\`
   to batch-triage a prose list first (each line returns ok / skipped / an
   \`ERR_PARSE_*\` envelope with partial slots and a mechanical rewrite
   suggestion — apply the suggestion and retry).
3. \`symspec check\` — one envelope contains structural, lint, and formal
   findings together, with severity counts.
4. Resolve findings in priority order:
   1. **structural errors** (dangling references, missing slots, cycles) —
      the graph is broken; formal results are incomplete until these clear;
   2. **\`FND_CONTRADICTION\`** — proven conflicts; the \`evidence.core\` array
      names exactly the culprit requirement ids, and \`evidence.atomTable\`
      shows what the solver compared;
   3. **error-severity lint** (\`GTWR_*\`) — these statements were EXCLUDED
      from formal analysis (the \`excluded\` array says why), so fixing them
      widens proof coverage;
   4. **warns/infos** (subsumption, redundancy, vacuity, orphans,
      \`FND_SIMILAR_UNUNIFIED\`, \`FND_NEEDS_REVIEW\`) — judgment calls;
      \`FND_NEEDS_REVIEW\` explicitly means "not proven either way".
5. Re-run \`symspec check\` after every edit batch; exit 0 = conflict-free
   modulo the scope statement below.
6. Optionally \`symspec certify\` for Lean-kernel-checked certificates
   (requires a Lean toolchain; never needed for \`check\`).

## Honest scope — read before trusting a verdict

> ${manifest.scope.soundness}

> ${manifest.scope.silence}

> ${manifest.scope.overUnification}

> ${manifest.scope.contextualAmbiguityNotChecked}

## Error codes (\`ERR_*\`)

${codeTable(manifest.codes.error)}

## Lint rule codes (\`GTWR_*\`)

${codeTable(manifest.codes.gtwr)}

## Finding codes (\`FND_*\`)

${codeTable(manifest.codes.fnd)}
`

const target = resolve(import.meta.dirname, '..', 'AGENTS.md')

if (process.argv.includes('--stdout')) {
  process.stdout.write(doc)
} else {
  writeFileSync(target, doc)
  console.error(`wrote ${target}`)
}
