# symspec — project notes for Claude

One package, at the repo root. `symspec` is published to npm from here.

## Prior lessons (ERPAVal)

This repo accumulates hard-won lessons under `.erpaval/solutions/`. **Before
starting non-trivial work, read [`.erpaval/INDEX.md`](.erpaval/INDEX.md)** and
grep `.erpaval/solutions/**` for anything touching your task — especially the
propose/decide determinism rule, the sound-modulo-atomization contract, and the
manifest/AGENTS.md single-source derivation (drift is a test failure).

## Gates

`pnpm check` is the whole gate, and it is the same one CI and the pre-push hook
run: `biome ci` + `tsc --noEmit` + `check:agents` + `gate:reachability` + `build`
+ `vitest run` + `knip`.

The ORDER is load-bearing. The CLI suite spawns `dist/cli.mjs`, so `build` must
precede `vitest` — run `vitest` alone and you are testing whatever the last build
left behind. Never split these into parallel steps; that is how the hook, the
workflow, and `mise run check` drift into gating different things.

Run `pnpm gen:agents` after touching any operation summary, description, or code
catalog. `AGENTS.md` is generated, and `check:agents` fails on drift.

Every failure is a blocker.

### A gate never observed to fail is not known to be a gate

Break the thing a new assertion guards, watch it go red, then put the sabotage in the
commit message. `src/publish.test.ts:444` records a check that passed against a
deliberately broken table; `scripts/reachability-feasibility.ts:8-18` records the
donor gate that was well-built and wired to nothing — "a gate nobody runs is
documentation with a non-zero exit code."

A sabotage that does NOT break the test is worth recording too: it either proves the
assertion is robust for a reason worth naming, or it shows the test is asserting
something other than what its name says.

### A derivable number in prose is a bug

Counts and names come from the table or catalog that owns them, interpolated — never
typed out. `explain`, the installed skill body, and `waive`'s own `--help` each said
"75 codes" against a real 81, at three different times.

The test needs a NEGATIVE guard: assert the stale literal is ABSENT. Asserting the
correct number passes just as happily for a hardcoded copy, which is how the second and
third instances survived a fix to the first.

## `src/domain/engine/**` is the engine tier — owned code, edited under its gates

That subtree is the v4-derived analysis core this tool's `check` actually runs on:
`src/app/operations/check.ts` calls its `runCheck`. An edit there changes a shipped
proof claim, so the bar is the sabotage rule below, applied without exception:
break the behavior, watch a gate go red (the pinned red-team rounds, the
generated-defect harness, or a suite assertion), and record the sabotage in the
commit message. If no gate fails, the edit is uncovered — write the test first.

`src/package-boundary.test.ts` keeps the dependency one-way: the engine imports
nothing greenfield beyond the pinned `core/ops.ts` crossing, so a greenfield
refactor never forces an engine edit.

New finding codes still go in files owned by their tier, unioned by
`app/runtime/catalog.ts` — see `src/domain/reachability/reachability-codes.ts`.
Cross-cutting shaping still goes at the boundary — see `src/domain/compat.ts`.
Both are modularity, not access control.

## Releasing

Conventional Commits on `main`; release-please opens the release PR and the same
workflow publishes through OIDC. The version lives in FOUR files and every one is
asserted to agree. See [`RELEASING.md`](RELEASING.md) — read it before cutting a
release, because getting off a prerelease version needs a `Release-As:` trailer
that the default merge-commit message would drop.

## Anything with a network cost sits behind a service seam

The embedding model is a ~110 MB pinned download, and no test fetches it. The
suite sets `SYMSPEC_EMBED_STUB=1`, and `download-model` is tested through the
`ModelDownload` service rather than a seeded cache directory — a seeded cache
cannot work, because the assets are sha256-verified and a preimage cannot be
faked. Follow that pattern: put the seam above the expensive call, not inside it.
