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
import { currentManifest } from './app/operations/index.ts'
import { VERSION } from './app/runtime/version.ts'

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
    // byte-identical to v4's. So softening the README means softening the corpus,
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

  it('names the agent-CLI contract as ONE section, each move stated once', () => {
    expect(readme).toContain('## The agent-CLI contract')
    const moves = [
      '`manifest` is the surface',
      'Branch on exit codes, not prose',
      'Movement, not retries',
      'The tool owns the load-bearing format',
    ]
    for (const move of moves) {
      expect(prose, move).toContain(move)
      // COUNTED, not merely present. The four properties were each stated twice, in the
      // runbook and again in the loop section — and a section that names a reusable unit
      // while leaving its restatements two screens down is duplication, not a contract.
      // The count is what keeps the absorption from silently reverting.
      expect(prose.split(move).length - 1, `"${move}" is stated more than once`).toBe(1)
    }
    // The pointer a reader hits before deciding whether to keep reading.
    expect(readme.slice(0, readme.indexOf('## Quick start'))).toContain('#the-agent-cli-contract')
  })

  it('names the COVERAGE boundary before the reader installs anything', () => {
    // The one critique the honest-scope section does not answer: scope is EARS-shaped
    // requirements, and a reader who points this at a design doc should learn that here
    // rather than from a parse error. Asserted on the first screen, because a boundary
    // disclosed on screen four is a boundary the skeptic has already invented for you.
    const opening = prose.slice(0, prose.indexOf('## Quick start'))
    expect(opening).toContain('Narrative prose is not in scope')
    expect(opening).toContain('EARS')
  })

  it('shows ONE copy-pasteable session with the tool`s own output at every step', () => {
    // Bytes only a real `parse` produces: the recovered slots, the ladder rung that
    // recovered them, and the op line `apply` consumes. A section that describes the
    // envelope without showing it is a claim rather than a demonstration.
    expect(readme).toContain('"slots"')
    expect(readme).toContain('"tier":1')
    expect(readme).toContain('opsJsonl')
    const session = readme.slice(
      readme.indexOf('### See it prove a conflict'),
      readme.indexOf('## The agent-CLI contract'),
    )
    for (const step of ['symspec init', 'symspec parse', 'symspec apply', 'symspec check']) {
      expect(session, step).toContain(step)
    }
    // The measured atom table, which is what makes the proof auditable rather than
    // asserted: one response atom, present at both polarities.
    expect(session).toContain('FND_CONTRADICTION')
    expect(session).toContain('sys__auth_service__resp__allow_access')
    expect(session.indexOf('symspec parse')).toBeLessThan(session.indexOf('FND_CONTRADICTION'))
  })

  it('carries an SMT-tier case study that ABSTAINS before it proves', () => {
    expect(readme).toContain('## Two requirements that quietly disagree')
    const study = readme.slice(
      readme.indexOf('## Two requirements that quietly disagree'),
      readme.indexOf('## The state model'),
    )
    // Asserted as an ORDERING, not as two `toContain`s. A case study that proved the
    // conflict first and mentioned the candidate afterwards would demonstrate the exact
    // opposite of the propose-then-decide claim it exists to make.
    expect(study).toContain('FND_QUANTITY_ALIAS_CANDIDATE')
    expect(study).toContain('FND_NUMERIC_CONTRADICTION')
    expect(study.indexOf('FND_QUANTITY_ALIAS_CANDIDATE')).toBeLessThan(
      study.indexOf('FND_NUMERIC_CONTRADICTION'),
    )
    // Abstention SHOWN rather than asserted: `verified` is false while nothing is proven.
    expect(study).toContain('"verified":false')
    // And the decide step in the form the CLI accepts — two positionals. The vendored
    // finding message spells it `glossary add`, which parses `add` as the canonical.
    expect(study).toMatch(/symspec glossary \\?"[^"\\]+\\?" \\?"[^"\\]+\\?"/)
  })

  it('shows the WHOLE-DOCUMENT vocabulary pass, including what it refuses', () => {
    expect(readme).toContain('## Designing the vocabulary in one pass')
    const section = readme.slice(
      readme.indexOf('## Designing the vocabulary in one pass'),
      readme.indexOf('## Honest scope'),
    )
    expect(section).toContain('symspec propose-glossary')
    // The load-bearing half. A section that only showed the merges it proposes would sell the
    // convenience and skip the reason to trust it: the refusal happens ABOVE the similarity
    // threshold, which is the one fact that shows cosine is not deciding.
    expect(section).toContain('opposition-candidate')
    expect(section).toContain('0.809')
    expect(section).toContain('above the 0.72')
    // And the non-vacuity signal, so "nothing to merge" is distinguishable from "did not look".
    expect(section).toContain('pairsCompared')
  })

  it('names the gates that make the no-drift claim checkable', () => {
    expect(readme).toContain('### Check these claims yourself')
    for (const gate of [
      'pnpm check',
      'check:agents',
      'src/publish.test.ts',
      'src/cli.test.ts',
      'src/app/runtime/agents-doc.test.ts',
      'src/domain/advice/repair.test.ts',
    ]) {
      expect(readme, gate).toContain(gate)
    }
    // The cited gates EXIST. Checked in the OTHER files, because a literal named here is
    // present by virtue of being written here — `toContain` on this file would pass for a
    // describe block that had already been renamed away.
    expect(read('src/app/runtime/agents-doc.test.ts')).toContain(
      "describe('the committed AGENTS.md matches the generator'",
    )
    expect(read('src/cli.test.ts')).toContain('drift — manifest summaries vs root --help')
    // And the script the README sends a skeptic to is real, and is IN the gate.
    expect(manifest.scripts['check:agents']).toContain('gen-agents.ts')
    expect(manifest.scripts.check).toContain('check:agents')
  })

  it('states the version posture and what is stable', () => {
    expect(readme).toContain('## Status')
    expect(readme).toContain(VERSION)
    // What an agent may depend on vs what may move. A README that said "stable API" over an
    // alpha would be the same species of overclaim as a certify.
    expect(prose).toContain('codes and the envelope shape')
  })
})

// ---------------------------------------------------------------------------
// The release config, which nothing else would catch
// ---------------------------------------------------------------------------

/**
 * release-please bumps the version in FOUR files, and a misconfiguration here is silent.
 *
 * The generic updater is a per-line substring match for `x-release-please-version`. It has
 * `createIfMissing: false` and no diagnostic for a file it matched nothing in — so an
 * `extra-files` entry pointing at a file with no annotation, or an annotation on the wrong
 * line, simply does not bump that file. Nothing fails. The result is a published version
 * whose `--version`, README and AGENTS.md disagree with the registry, which is exactly the
 * class of error a registry's immutability makes permanent.
 *
 * So both directions are asserted: every configured file carries an annotation, and every
 * file carrying the version string is configured.
 */
describe('the release config bumps every place the version appears', () => {
  const config = JSON.parse(read('release-please-config.json')) as {
    'bootstrap-sha'?: string
    packages: Record<string, { 'extra-files'?: readonly { type: string; path: string }[] }>
  }
  const releaseManifest = JSON.parse(read('.release-please-manifest.json')) as Record<
    string,
    string
  >
  const extraFiles = (config.packages['.']?.['extra-files'] ?? []).map((entry) => entry.path)

  it('agrees with package.json about the current version', () => {
    // The manifest is release-please's version-of-record — it backfills from this file even
    // with no git tag, so a stale entry makes the NEXT release bump from the wrong base.
    expect(releaseManifest['.']).toBe(manifest.version)
  })

  it('lists every file that carries the version, and no others', () => {
    // `package.json` is handled natively by `release-type: node`, so it is correctly ABSENT
    // from `extra-files` — listing it would be redundant, not harmful.
    expect([...extraFiles].sort()).toEqual(['AGENTS.md', 'README.md', 'src/app/runtime/version.ts'])
  })

  it('finds the annotation ON THE SAME LINE as the version, in every configured file', () => {
    for (const path of extraFiles) {
      const annotated = read(path)
        .split('\n')
        .filter((line) => line.includes('x-release-please-version'))
      expect(annotated, `${path} has no x-release-please-version annotation`).toHaveLength(1)
      // The updater replaces the first semver-looking substring ON the matched line. An
      // annotation one line off is a no-op, and the only symptom is a version that stops
      // moving.
      expect(annotated[0], `${path}: annotation is not on the version's own line`).toContain(
        manifest.version,
      )
    }
  })

  it('pins a bootstrap-sha, so the first changelog is not the whole history', () => {
    // Without it release-please walks up to `commit-search-depth` (500) and puts every
    // conventional commit ever written into the first release's changelog.
    expect(config['bootstrap-sha']).toMatch(/^[0-9a-f]{40}$/)
  })

  it('names the workflow the npm trusted publisher has to be configured against', () => {
    // The publish job must live in the workflow named in `npm trust github … --file`, and
    // that name is a bare filename rather than a path. If this file is ever renamed, the
    // trusted publisher stops matching and the publish fails with an opaque 404.
    const workflow = read('.github/workflows/release-please.yml')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('pnpm publish')
    // Scoped to the publish job, never granted workflow-wide.
    expect(workflow).toContain('permissions: {}')
    expect(read('RELEASING.md')).toContain('--file release-please.yml')
  })
})

// ---------------------------------------------------------------------------
// The README's own numbers, checked against the tool
// ---------------------------------------------------------------------------

/**
 * A README that counts things WILL rot, because nothing else reads it.
 *
 * "21 operations" and "80 stable codes" were both true when written and both wrong by the
 * time anyone noticed — the operations table had also silently dropped a command. A reader
 * who runs `symspec manifest` and counts 22 has no way to tell which source is stale, and
 * the answer they trust is the one that is easier to read.
 *
 * So the counts are asserted against the table they describe. The alternative — deleting
 * the numbers to avoid the problem — loses real information: "22 operations" tells a reader
 * the surface is small enough to learn, which "several operations" does not.
 */
describe('the README agrees with the tool about its own surface', () => {
  const readme = read('README.md')
  const manifestNow = currentManifest()
  const codeCount =
    manifestNow.errorCodes.length + manifestNow.findingCodes.length + manifestNow.lintCodes.length

  it('states the operation count the table actually holds', () => {
    expect(readme).toContain(`${manifestNow.operations.length} operations`)
    // NEGATIVE GUARD. `toContain` on the correct number passes just as happily for a
    // hardcoded copy that happens to be right today, which is how three separate places
    // kept claiming 75 codes against a real 81. Asserting the PREDECESSOR is absent is
    // what makes the next append fail here instead of shipping.
    expect(readme).not.toContain(`${manifestNow.operations.length - 1} operations`)
  })

  it('states the total code count across the three catalogs', () => {
    expect(readme).toContain(`**${codeCount} stable codes**`)
  })

  it('lists EVERY operation in the operations TABLE, not merely somewhere', () => {
    // Scoped to the table on purpose. Searching the whole README passes as long as the
    // command is mentioned anywhere — and every command is mentioned somewhere, so that
    // version of this test cannot fail. Verified by sabotage: removing `download-model`
    // from the table left a whole-file search green.
    const table = readme.slice(readme.indexOf('| Group | Operations |'))
    const rows = table.slice(0, table.indexOf('\n\n'))
    expect(rows, 'the operations table moved or lost its header').toContain('| Documents |')

    const missing = manifestNow.operations
      .map((op) => op.name)
      .filter((name) => !rows.includes(`\`${name}\``))
    expect(missing).toEqual([])
  })

  it('names no SUBCOMMAND form the tool does not accept', () => {
    // The surface is FLAT: every operation is `symspec <op>` with flags and positionals,
    // and none has a nested verb. `glossary add "a" "b"` is `import`'s v2 op-stream
    // side-table grammar, not a shell command — run it and `add` binds to the `canonical`
    // positional, the extra argument fails, and the CLI prints usage.
    //
    // The test below cannot see this: its regex captures only the FIRST word after
    // `symspec`, so `glossary add` passes as `glossary`. Which is exactly how this README
    // came to instruct a reader to run a command that does nothing.
    const nested = [...readme.matchAll(/`(?:symspec )?([a-z][a-z-]*) (add|remove|list|set)\b/g)]
      .filter(
        (m) => m[1] !== undefined && new Set(manifestNow.operations.map((o) => o.name)).has(m[1]),
      )
      .map((m) => `${m[1]} ${m[2]}`)
    expect([...new Set(nested)]).toEqual([])
  })

  it('names no command the tool does not have', () => {
    // The other direction: a README that documents a removed command sends a reader to a
    // usage error. Checked against the backticked words that look like subcommands.
    const known = new Set(manifestNow.operations.map((op) => op.name))
    const advertised = [...readme.matchAll(/`symspec ([a-z][a-z-]*)/g)].map((m) => m[1])
    const unknown = [
      ...new Set(advertised.filter((name) => name !== undefined && !known.has(name))),
    ]
    expect(unknown).toEqual([])
  })
})
