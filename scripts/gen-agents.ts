/**
 * `AGENTS.md` generator — a shell around the renderer, which lives in `src/`.
 *
 * The renderer is `src/kernel/agents-doc.ts`, deliberately: the donor kept its generator in
 * `scripts/`, outside the typechecker's `include` and outside the test suite, so a bug in
 * the generator was invisible until it had been committed into the file. Here the tests
 * cover the projection and this script only decides where the bytes go.
 *
 * Usage:
 *   pnpm gen:agents            # regenerate AGENTS.md in place
 *   pnpm gen:agents --stdout   # write to stdout (what the drift gate diffs)
 *   pnpm check:agents          # regenerate and diff — fails on drift
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { currentManifest } from '../src/app/operations/index.ts'
import { renderAgentsDoc } from '../src/app/runtime/agents-doc.ts'

const doc = renderAgentsDoc(currentManifest())

if (process.argv.includes('--stdout')) {
  process.stdout.write(doc)
} else {
  const target = resolve(import.meta.dirname, '..', 'AGENTS.md')
  writeFileSync(target, doc)
  console.error(`wrote ${target} (${doc.length} bytes)`)
}
