/**
 * Single-source version string (AC-6-7).
 *
 * `package.json` is the ONE source of truth for the version; this module
 * re-exports it for every consumer — the CLI's `--version` flag and the
 * `manifest` command's `version` field alike — so a `pnpm version` bump can
 * never desync them (AC-6-7 verification: `--version` == manifest version ==
 * package.json version).
 *
 * ## Why a type-asserted JSON import survives bundling
 *
 * `import pkg from '../../package.json' with { type: 'json' }` is resolved and
 * INLINED by tsdown at build time — the emitted bundle contains a literal
 * `const VERSION = "<version>"`, never a runtime file read — so there is no
 * `require('package.json')` / `__dirname` / `import.meta.url` fragility once the
 * CLI ships as a single `dist/cli.mjs`. This is the same import mechanism
 * `src/cli/manifest.ts` already uses for `pkg.name`/`pkg.version`, so both
 * agent-facing surfaces read the identical field of the identical file; they
 * cannot drift. (`createRequire('package.json')` would also work but reintroduces
 * a runtime resolution step this static import avoids.)
 *
 * A consumer wires it as `program.version(VERSION)` (commander) so the `-V` /
 * `--version` flag prints exactly `package.json`'s `version`.
 *
 * Cite: AC-6-7 (version from a single source — package.json — for both CLI and
 * manifest).
 */

import pkg from '../../package.json' with { type: 'json' }

/**
 * The package version, read from the single `package.json` source.
 *
 * Bound to the CLI's `--version`/`-V` flag and mirrored by the `manifest`
 * command's `version` field, so all three agree by construction.
 */
export const VERSION: string = pkg.version
