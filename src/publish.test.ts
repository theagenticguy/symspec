/**
 * THE PUBLISH POSTURE — publishable but unpublished, and the tarball is what it claims.
 *
 * ## Why this file exists at all
 *
 * `private: true` is a single boolean that stops a publish, and removing it is a one-line
 * edit. Everything that makes the removal SAFE is the rest of the manifest: a `files`
 * whitelist so the tarball is not the whole source tree, a `license` that matches the
 * committed LICENSE bytes, metadata a registry page can render, and a README that describes
 * the thing being published rather than the repository it lives in.
 *
 * None of that is checked by anything. `npm pack` succeeds on a package with the wrong
 * license, no README, and a `files` list that ships `src/`. So the failure mode is a
 * PUBLISHED artifact that is wrong — the one kind that cannot be quietly fixed, because a
 * registry version is immutable and an unpublish window is 72 hours.
 *
 * These assertions are therefore about the SHIPPED SHAPE, and they are cheap: reading
 * `package.json` and the two files it promises to include.
 *
 * ## The one thing deliberately NOT asserted
 *
 * That `private` is absent. It is absent, and a test demanding its absence would make
 * temporarily setting `private: true` — the correct move if a publish ever needs blocking in
 * a hurry — fail the suite. The posture is "publishable", not "must be published"; the
 * decision to press the button stays a human one.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VERSION } from './kernel/version.ts'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')

interface PackageManifest {
  readonly name: string
  readonly version: string
  readonly private?: boolean
  readonly description: string
  readonly keywords?: readonly string[]
  readonly license: string
  readonly repository?: { readonly url?: string; readonly directory?: string }
  readonly homepage?: string
  readonly bugs?: { readonly url?: string }
  readonly bin: Readonly<Record<string, string>>
  readonly files: readonly string[]
  readonly publishConfig?: { readonly access?: string; readonly tag?: string }
  readonly engines?: Readonly<Record<string, string>>
  readonly scripts: Readonly<Record<string, string>>
  readonly dependencies: Readonly<Record<string, string>>
}

const manifest = JSON.parse(read('package.json')) as PackageManifest

// ---------------------------------------------------------------------------
// The identity a registry page renders
// ---------------------------------------------------------------------------

describe('the package is publishable', () => {
  it('is not marked private', () => {
    // The flip G5 performs. Asserted as a fact about the current state, not as a
    // requirement — see the file header for why demanding it would be wrong.
    expect(manifest.private).toBeUndefined()
  })

  it('publishes under the name it owns, at the version the CLI reports', () => {
    expect(manifest.name).toBe('symspec')
    // The same pin `version.test.ts` makes from the other side, restated here because a
    // published tarball whose `--version` disagrees with its registry version is
    // unfixable after the fact.
    expect(manifest.version).toBe(VERSION)
    expect(manifest.publishConfig?.access).toBe('public')
  })

  /**
   * The dist-tag has to AGREE with the version, in both directions.
   *
   * Pinning `tag: 'alpha'` outright would have to be edited by hand at the moment of the
   * first stable release — which is the moment nobody is looking at this file. So the
   * invariant is asserted instead, and it fails in whichever direction is wrong:
   *
   * - a prerelease on the default tag means `npm install symspec` hands a prerelease to
   *   someone who asked for a release. npm 11 refuses this outright, and the refusal
   *   arrives mid-publish;
   * - a STABLE version still carrying `tag: 'alpha'` is the quieter and worse failure. It
   *   publishes successfully, to a channel nobody installs from, and `npm install symspec`
   *   keeps serving the old release with no error anywhere.
   *
   * The second case is why this test exists: release tooling bumps the version and does
   * not know about `publishConfig`.
   */
  it('ships a dist-tag that agrees with the version', () => {
    const tag = manifest.publishConfig?.tag
    const prerelease = manifest.version.includes('-')
    if (prerelease) {
      expect(tag, 'a prerelease must name a non-default dist-tag').toBeDefined()
      expect(tag).not.toBe('latest')
    } else {
      expect(
        tag === undefined || tag === 'latest',
        `version ${manifest.version} is stable but publishConfig.tag is "${tag}" — ` +
          'it would publish to a channel nobody installs from',
      ).toBe(true)
    }
  })

  it('describes what the tool DOES, in a length a registry renders', () => {
    // npm truncates in search results, and a description that stops mid-clause is worse
    // than a short one. The floor matters more: "symspec v5 greenfield: one operations
    // table projected into a CLI" — the previous description — described the ARCHITECTURE
    // to someone who has not heard of the tool.
    expect(manifest.description.length).toBeGreaterThan(80)
    expect(manifest.description.length).toBeLessThan(400)
    // It has to name the capability, not the implementation strategy.
    expect(manifest.description).not.toContain('greenfield')
    for (const word of ['requirements', 'EARS', 'Z3']) {
      expect(manifest.description, `the description never says "${word}"`).toContain(word)
    }
  })

  it('carries keywords covering both audiences that would search for it', () => {
    const keywords = manifest.keywords ?? []
    expect(keywords.length).toBeGreaterThan(10)
    // The requirements-engineering audience and the formal-methods audience use disjoint
    // vocabulary for the same tool, and an agent-host user searches for neither.
    for (const group of [
      ['requirements', 'ears', 'incose'],
      ['smt', 'z3', 'formal-verification'],
      ['cli', 'agent', 'coding-agent'],
    ]) {
      expect(
        group.some((k) => keywords.includes(k)),
        `no keyword from ${group.join('/')}`,
      ).toBe(true)
    }
    expect(new Set(keywords).size, 'duplicate keyword').toBe(keywords.length)
  })

  it('points at a repository, a homepage, and an issue tracker', () => {
    expect(manifest.repository?.url).toContain('github.com')
    // No `directory`: the package IS the repository root, and a `directory` pointing at a
    // path that does not exist breaks npm provenance, which matches the field
    // case-sensitively against the repo it was built from.
    expect(manifest.repository?.directory).toBeUndefined()
    expect(manifest.homepage).toContain('github.com/theagenticguy/symspec')
    expect(manifest.bugs?.url).toContain('issues')
  })

  it('declares the node floor the bundle actually needs', () => {
    // `tsdown` targets node24 and the bundle uses no shims, so an older node fails at
    // parse time with no useful message. The engines field is what turns that into an
    // install-time refusal.
    expect(manifest.engines?.node).toBe('>=24')
  })
})

// ---------------------------------------------------------------------------
// The LICENSE, matched to its bytes rather than to its name
// ---------------------------------------------------------------------------

describe('the declared license matches the committed LICENSE file', () => {
  /**
   * The SPDX identifier and the file are two independent claims, and a mismatch between
   * them is the kind of defect that is discovered by a downstream compliance scan rather
   * than by anyone here.
   *
   * Checked by reading the LICENSE text, not by trusting the field: `license: "MIT"` over
   * an Apache-2.0 file is a legal misstatement that `npm publish` will happily ship.
   */
  it('declares Apache-2.0 AND ships the Apache-2.0 text', () => {
    expect(manifest.license).toBe('Apache-2.0')
    const license = read('LICENSE')
    expect(license).toContain('Apache License')
    expect(license).toContain('Version 2.0, January 2004')
    expect(license).toContain('http://www.apache.org/licenses/LICENSE-2.0')
    // And it is NOT some other license's text under an Apache name.
    expect(license).not.toContain('MIT License')
    expect(license).not.toContain('GNU GENERAL PUBLIC LICENSE')
  })

  it('the README states the same license', () => {
    expect(read('README.md')).toContain('Apache-2.0')
  })
})

// ---------------------------------------------------------------------------
// The tarball contents, as a whitelist
// ---------------------------------------------------------------------------

describe('the `files` whitelist ships the artifact and nothing else', () => {
  it('lists exactly dist, README, and LICENSE', () => {
    // A WHITELIST, not an ignore file, and asserted exactly. `files` is the field where an
    // accidental addition ships source, fixtures, or the 110 MB embedding model, and an
    // "at least these" assertion would never notice.
    expect([...manifest.files].sort()).toEqual(['LICENSE', 'README.md', 'dist'])
  })

  it('does NOT list `bin`, which npm includes from the `bin` field automatically', () => {
    // Verified against a real `npm pack --dry-run`: with `files: [dist, README.md,
    // LICENSE]` the tarball still contains `bin/symspec.mjs`, because npm always includes
    // the declared bin entry. Listing it would be redundant, and the redundancy would read
    // as load-bearing to the next person editing the list.
    expect(manifest.files).not.toContain('bin')
    expect(manifest.bin).toEqual({ symspec: './bin/symspec.mjs' })
  })

  it('ships NO source, tests, fixtures, or configuration', () => {
    // The things that were in the tarball before the whitelist tightened, each named so a
    // regression says which one came back.
    for (const excluded of [
      'src',
      'scripts',
      'probes',
      'AGENTS.md',
      'tsconfig.json',
      'vitest.config.ts',
      'biome.json',
      'tsdown.config.ts',
    ]) {
      expect(manifest.files, `the tarball would ship ${excluded}`).not.toContain(excluded)
    }
  })

  it('builds on `prepack`, so a publish cannot ship a stale bundle', () => {
    // `files` ships `dist/`, which is gitignored build output. Without `prepack` a publish
    // from a clean checkout would produce a tarball with no `dist/` at all — a package that
    // installs and then cannot run.
    expect(manifest.scripts.prepack).toBe('tsdown')
  })

  it('builds on `prepare` too, which is the hook a git-URL install runs', () => {
    // `prepack` fires on pack/publish and NEVER for a dependency. Installing straight from
    // the git URL runs `prepare` instead, so without it `pnpm add -g git+https://…` yields
    // an installed package whose `bin` points into an empty `dist/`.
    //
    // Both, and asserted EQUAL: two build hooks that can disagree are a tarball and a
    // git install that ship different bytes.
    expect(manifest.scripts.prepare).toBe(manifest.scripts.prepack)
  })
})

// ---------------------------------------------------------------------------
// The README describes the PACKAGE
// ---------------------------------------------------------------------------

/**
 * The README is the registry page, so its job is different from `AGENTS.md`'s: a reader has
 * not installed anything yet and does not know what the tool claims.
 *
 * These assertions are about COVERAGE of the four things a reader needs before installing —
 * how to start, what the agent loop is, what the state model does, and what the tool does
 * NOT promise — plus the one property that makes the honest-scope section trustworthy: the
 * claims are the tool's own words rather than a paraphrase, so they cannot be softened here
 * without being softened in the corpus.
 */
describe('the README is a PACKAGE readme, greenfield-first and honest', () => {
  const readme = read('README.md')
  /**
   * The README with newlines and Markdown emphasis flattened, for asserting on a SENTENCE.
   *
   * Written because the first version of these assertions failed on prose that was present
   * and correct: `**the absence is the all-clear**` is hard-wrapped mid-phrase, so a
   * `toContain` on the sentence looks for bytes no line holds. Reflowing a paragraph is a
   * formatting change and must not fail a content test — otherwise the test trains people to
   * avoid reformatting, which is the opposite of what a doc test should do.
   */
  const prose = readme.replace(/\*\*/g, '').replace(/\s+/g, ' ')

  it('opens with a quick start that a reader can run', () => {
    expect(readme).toContain('## Quick start')
    // The three commands a first-time reader runs, in order. Verified by hand against the
    // built CLI on a fresh directory.
    expect(readme).toContain('npm install -g symspec')
    expect(readme).toContain('symspec install')
    expect(readme).toContain('symspec init')
    expect(readme).toContain('symspec check')
  })

  it('documents the AGENT LOOP with all three fields', () => {
    expect(readme).toContain('## The agent loop')
    for (const field of ['repair: {ops, commands}', 'data.progress', 'data.budgetHint']) {
      expect(readme, field).toContain(field)
    }
    // The two properties an agent's control flow depends on.
    expect(prose).toContain('no placeholders')
    expect(prose).toContain('the batch did nothing')
    expect(prose).toContain('the absence is the all-clear')
  })

  it('documents the STATE MODEL with the worked example, numbers included', () => {
    expect(readme).toContain('## The state model, and a worked example')
    // The measured trace, verbatim from a real run. A README example without the actual
    // output is a claim rather than a demonstration.
    expect(readme).toContain('init -> TX-A1 -> TX-A3 -> TX-A2 -> TX-C2')
    expect(readme).toContain('"provedUnderHypotheses":1')
    // And the verdict a reader will actually see most often, explained rather than hidden.
    expect(prose).toContain('PROVED_UNDER_HYPOTHESES')
    expect(prose).toContain('demotes `verified`')
  })

  it('carries the HONEST-SCOPE section in the tool`s own words', () => {
    expect(readme).toContain('## Honest scope')
    // The load-bearing sentences, verbatim from `kernel/scope.ts` — which is itself asserted
    // byte-identical to the donor's. So softening the README means softening the corpus,
    // which fails a different test. That chain is the point.
    expect(prose).toContain('sound modulo atomization')
    expect(prose).toContain('silence is not a consistency certificate')
    expect(prose).toContain('over-unification')
    expect(prose).toContain('propose-only')
    expect(prose).toContain('Nonlinear-integer arithmetic remains out of scope')
    // The consequence, restated in the reader's terms.
    expect(prose).toContain('"no conflict was proven"')
  })

  it('makes NO certify claim — honesty by absence', () => {
    // `certify` was removed from the spec at Gate 1 and no encoding exists, so the README
    // must not imply one. This is the assertion that keeps a future marketing edit honest:
    // a disclosed tautology is worse than a missing feature.
    expect(readme.toLowerCase()).not.toContain('certifies')
    expect(readme.toLowerCase()).not.toContain('symspec certify')
    expect(readme.toLowerCase()).not.toContain('proof certificate')
    // It says so explicitly, which is stronger than merely omitting it.
    expect(prose).toContain('it does not certify specs')
  })

  it('states the version posture and what is stable', () => {
    expect(readme).toContain('## Status')
    expect(readme).toContain(VERSION)
    // What an agent may depend on vs what may move. A README that said "stable API" over an
    // alpha would be the same species of overclaim as a certify.
    expect(prose).toContain('codes and the envelope shape')
  })
})
