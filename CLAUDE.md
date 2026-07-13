# symspec — project notes for Claude

## Prior lessons (ERPAVal)

This repo accumulates hard-won lessons under `.erpaval/solutions/`. **Before
starting non-trivial work, read [`.erpaval/INDEX.md`](.erpaval/INDEX.md)** and
grep `.erpaval/solutions/**` for anything touching your task — especially the
propose/decide determinism rule, the sound-modulo-atomization contract, and the
manifest/AGENTS.md single-source derivation (drift is a test failure).

## Gates

`pnpm check` runs biome + tsc + vitest + knip. Also run `pnpm gen:agents` after
touching command descriptions/manifest (or `pnpm check:agents` guards drift), and
`pnpm build` before exercising the built CLI. Every failure is a blocker.
