/**
 * THE PACKAGE BOUNDARY — every import resolves inside the package that ships.
 *
 * ## What this guards, and why a regex would not do
 *
 * `src/donor/**` is a vendored copy of the tier this package's `check` runs on top of. It
 * is FROZEN: `src/operations/check.ts` calls its `runCheck`, so an edit there changes
 * shipped behavior with none of the review a change to `src/formal/**` would attract.
 *
 * The failure mode this file exists to catch is quieter than an edit, though. A test or a
 * script that reaches OUTSIDE the package — `../../../somewhere` — compiles, passes, and
 * then breaks the moment the package is consumed on its own, because the thing it reached
 * for was never in the tarball. That is a whole class of green-locally / broken-published,
 * and it is invisible to `tsc` (which typechecks whatever it can resolve on disk) and to
 * `vitest` (which runs from the repo, not from an install).
 *
 * So the assertion RESOLVES each specifier against its importer's directory and checks the
 * result is under the package root. A depth-counting regex cannot do this: `../../..` is
 * fine from `src/a/b/c.ts` and escapes from `src/a.ts`, and the same literal means
 * different things in different files.
 *
 * Doc comments are deliberately NOT scanned. Several frozen files reference donor paths in
 * prose, and those files must not be edited to satisfy a test.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Every `.ts` file under a directory, recursively. */
const tsFiles = (dir: string): readonly string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      out.push(...tsFiles(full))
    } else if (entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * The relative specifiers a module imports — static and dynamic, type-only included.
 *
 * Matches at statement position (`from '…'` / `import('…')`), which is what keeps the
 * prose mentions of `../../../core/store.ts` inside the frozen files from registering.
 */
const relativeSpecifiers = (source: string): readonly string[] => {
  const found: string[] = []
  for (const match of source.matchAll(/\bfrom\s+'(\.[^']*)'/g)) {
    if (match[1] !== undefined) found.push(match[1])
  }
  for (const match of source.matchAll(/\bimport\(\s*'(\.[^']*)'\s*\)/g)) {
    if (match[1] !== undefined) found.push(match[1])
  }
  return found
}

describe('no module reaches outside the package', () => {
  it('finds source to check — the scan is not vacuous', () => {
    // Without this, deleting `src/` would make every assertion below pass.
    const files = tsFiles(join(PKG_ROOT, 'src'))
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => f.includes(`${sep}donor${sep}`))).toBe(true)
  })

  it('resolves every relative import inside the package root', () => {
    const escaping: string[] = []
    for (const file of [...tsFiles(join(PKG_ROOT, 'src')), ...tsFiles(join(PKG_ROOT, 'scripts'))]) {
      for (const specifier of relativeSpecifiers(readFileSync(file, 'utf8'))) {
        const target = resolve(dirname(file), specifier)
        if (relative(PKG_ROOT, target).startsWith('..')) {
          escaping.push(`${relative(PKG_ROOT, file)} -> ${specifier}`)
        }
      }
    }
    // Named individually rather than counted, because the fix differs per case: vendor the
    // dependency, or drop the assertion that needed it.
    expect(escaping).toEqual([])
  })

  it('keeps the vendored tier self-contained — it imports no greenfield module', () => {
    // The dependency runs ONE way. `src/formal/**` and `src/operations/**` build on
    // `src/donor/**`; the reverse would make the frozen tree un-freezable, because a
    // greenfield refactor would force an edit inside it.
    const donorRoot = join(PKG_ROOT, 'src', 'donor')
    const leaking: string[] = []
    for (const file of tsFiles(donorRoot)) {
      for (const specifier of relativeSpecifiers(readFileSync(file, 'utf8'))) {
        const target = resolve(dirname(file), specifier)
        if (relative(donorRoot, target).startsWith('..')) {
          leaking.push(`${relative(PKG_ROOT, file)} -> ${specifier}`)
        }
      }
    }
    // `core/ops.ts` is the one crossing, and it is the op VOCABULARY rather than an
    // implementation: the tier proposes ops, so it has to name their shape. Pinned as an
    // exact list so a second crossing is a review decision and not an accident.
    expect(leaking).toEqual(['src/donor/parse/result.ts -> ../../core/ops.ts'])
  })

  it('ships a `dist` that the bin actually points at', () => {
    // `bin/symspec.mjs` is a one-line wrapper, and its whole job is to keep the shebang on
    // a stable path while the build output moves. A wrong relative path here is a package
    // that installs and cannot run — invisible to every test that imports `src/`.
    const bin = readFileSync(join(PKG_ROOT, 'bin', 'symspec.mjs'), 'utf8')
    const specifier = /'(\.[^']*)'/.exec(bin)?.[1]
    expect(specifier).toBeDefined()
    const target = resolve(join(PKG_ROOT, 'bin'), specifier ?? '')
    expect(relative(PKG_ROOT, target)).toBe(join('dist', 'cli.mjs'))
    expect(statSync(target).isFile()).toBe(true)
  })
})
