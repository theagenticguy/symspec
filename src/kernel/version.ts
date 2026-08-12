/**
 * The package version, as a single constant.
 *
 * ## Why this is a literal and not a `package.json` read
 *
 * The shipped artifact is a single-file bundle (`dist/cli.mjs`) that must run
 * under plain `node` with nothing resolved at runtime. Reading `package.json`
 * would mean either a filesystem read relative to a bundled module's location —
 * fragile, and different in `dist/` than in `src/` — or an import that inlines
 * the whole manifest into the bundle. A constant plus a test that pins it to
 * `package.json` gets the same guarantee with neither cost: the drift is caught
 * at test time rather than risked at runtime.
 *
 * `version.test.ts` asserts this equals the `version` field in
 * `packages/symspec/package.json`, so bumping one without the other fails the
 * suite.
 */

/**
 * The package version. Kept in lockstep with `package.json` by
 * `version.test.ts`.
 *
 * DISTINCT from the envelope's `apiVersion`: this moves on every release, that
 * one moves only when the envelope shape changes in a way an agent must
 * negotiate.
 */
export const VERSION = '1.0.0' // x-release-please-version
