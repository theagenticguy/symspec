---
title: Collapsing a pnpm workspace to one root package silently drops packageManager and allowBuilds — both fail at INSTALL time in messages that name neither the file nor the setting
track: knowledge
category: conventions
module: pnpm-workspace.yaml
component: build
severity: high
tags: [pnpm, workspace, monorepo, packageManager, allowBuilds, lockfile, prepare, git-rename, ci]
applies_when:
  - collapsing a pnpm workspace to a single package at the repo root
  - promoting a nested package out of packages/* into the root
  - deleting the workspace root package while keeping one of its members
  - two workspace projects share a name and `--filter <name>` is ambiguous
pattern: |
  Four settings only exist at the workspace level, and a collapse deletes the files they
  live in. None of the four fails where you are looking.

  1. **`packageManager`** lives in the ROOT package.json only. Delete that file and CI
     breaks at `pnpm/action-setup`, before a single script runs. Compounding it: the
     workflow deliberately omits `version:` because action-setup ERRORS when both pins
     exist — so the field is load-bearing precisely because the workflow trusts it.
  2. **`allowBuilds`** lives in pnpm-workspace.yaml. `pnpm.onlyBuiltDependencies` /
     `ignoredBuiltDependencies` in package.json are REMOVED in pnpm 11, so migrating them
     "back" into the manifest silently un-decides every dependency's build. An undecided
     entry makes `pnpm install --frozen-lockfile` interactive, and CI hangs or fails on a
     prompt nobody sees.
  3. **Non-auth `.npmrc` settings are no longer read** by pnpm 11. `auto-install-peers`,
     `strict-peer-dependencies`, `verify-deps-before-run` become camelCase keys in
     pnpm-workspace.yaml. Left in `.npmrc` they are inert, and `npm` warns about each one
     on every invocation, which trains you to ignore the warnings.
  4. So **keep pnpm-workspace.yaml** with no `packages:` key. A settings-only workspace
     file is the supported shape, and it is the only place pnpm 11 reads (2) and (3).

  Two orderings are load-bearing and neither is obvious:

  - Regenerate the lockfile only AFTER `packages:` is gone, or pnpm re-adds the second
    importer and `--frozen-lockfile` keeps passing against a layout that no longer exists.
    Verify by grepping the lockfile for the old path and expecting zero hits.
  - Commit the DELETION and the MOVE separately. Git detects renames at diff time, so
    deleting `src/pipeline/check.ts` in the same commit that moves a near-identical
    `src/donor/pipeline/check.ts` lets the detector pair the wrong two —
    `git log --follow` then walks into the deleted file's history instead of the moved
    file's. Two commits removes the ambiguity, and the second is 100%-similarity renames
    with no competing deletions.

  The reason the collapse was worth doing is worth recording too: BOTH projects were named
  `symspec`, so `pnpm --filter symspec check` matched both and CI's root `pnpm check` had
  tsconfig/vitest/knip globs that reached neither `packages/*`. The shipping package had
  never been gated. It was red — 2 tsc errors, 11 failing assertions, a stale generated
  doc — and nothing had noticed. A duplicate project name is not a cosmetic detail; it is
  a filter that silently matches the wrong thing.
anti_pattern: |
  Moving `allowBuilds` decisions into `pnpm.onlyBuiltDependencies` because that is where
  they used to live. Regenerating the lockfile before deleting `packages:`. Doing the
  delete and the move in one commit. Assuming `--filter <name>` is unambiguous when two
  projects declare the same name. Adding a `prepare` script without checking what a
  non-zero exit from it does (see the pnpm11-prepare lesson: every later `pnpm exec` fails
  with an opaque error pointing into pnpm's internals, not at the build that broke).
resolution: |
  pnpm-workspace.yaml retained, `packages:` stripped, `allowBuilds` kept and extended with
  an explicit `z3-solver: true` — it ships prebuilt WASM and declares no install hook
  today, so recording the decision now is cheaper than meeting an interactive prompt in CI
  later. The three `.npmrc` lines migrated to camelCase keys and `.npmrc` deleted.
  `packageManager` carried into the promoted manifest and bumped to a version that can
  actually publish (see below).

  Verified rather than assumed, and this is the whole test: `pnpm install` regenerates ONE
  importer (`.`), and `pnpm install --frozen-lockfile` completes NON-INTERACTIVELY.

  Adjacent, and the reason a version bump was not optional: pnpm below 11.1.3 sends the
  literal `${NODE_AUTH_TOKEN}` that actions/setup-node writes as a bearer token, and 404s
  before OIDC trusted publishing can engage (pnpm#11513). A workspace pinned to 11.1.1
  cannot publish via OIDC at all, and the failure is a 404 that names nothing.
see_also:
  - solutions/conventions/pnpm11-prepare-script-and-git-init-order.md
  - solutions/architecture/a-transplant-that-outlives-its-oracle.md
example_files:
  - pnpm-workspace.yaml
  - package.json
  - .github/workflows/check.yml
---

## The `prepare` / `prepack` pair

A single-package repo that wants to be installable from its git URL needs BOTH, and they
are not interchangeable:

- `prepack` runs on pack and publish. It is what keeps a gitignored `dist/` out of a
  published tarball's blind spot.
- `prepare` runs for a DEPENDENCY. `prepack` never does. Without `prepare`, a
  `pnpm add -g git+https://…` install succeeds and leaves a `bin` pointing into an empty
  directory.

Declare both, identical, and assert they are EQUAL — two build hooks that can disagree are
a tarball and a git install shipping different bytes.

One more consumer-side gate that no amount of manifest correctness fixes: pnpm 10.26+
refuses to run a git dependency's `prepare` unless the INSTALLING user allowlists it, keyed
`<name>@<git-url>`. A bare package name does not match a git dependency. That belongs in
the README's install line, because it is the user's config and not something the package
can set for them.
