---
title: lefthook vs. Amazon git-defender — global core.hooksPath collision
track: knowledge
category: conventions
module: .git/config
component: lefthook
severity: medium
tags: [lefthook, git, amazon, git-defender, hooksPath, ts-stack]
applies_when:
  - the dev machine is an Amazon corp laptop with git-defender installed
  - a project uses lefthook (or husky / any per-repo hook manager)
  - `git config --get core.hooksPath` returns `/usr/local/amazon/var/git-defender/hooks`
pattern: |
  Amazon's git-defender sets `core.hooksPath` GLOBALLY to its own hooks dir
  (read-only for the user). Out of the box, `lefthook install` either:
    1. tries to write into git-defender's dir → permission denied, or
    2. refuses to install because `core.hooksPath` is already set.

  Resolution: scope a per-repo override that lets lefthook own this repo's
  hooks while everything else still routes to git-defender:

    git init
    git config --local core.hooksPath .git/hooks
    pnpm exec lefthook install --force

  `--force` is required because lefthook still notices the local hooksPath
  override; it installs into `.git/hooks` anyway. Subsequent runs of
  `lefthook install` (e.g. via a `prepare`-style script) work without
  --force as long as the local config is still set.

  Verify with:
    git config --local --get core.hooksPath   # → .git/hooks
    ls -la .git/hooks/                        # → pre-commit, pre-push (non-sample)

  Without the override, lefthook's pre-commit / pre-push jobs simply never
  fire — the failure is silent because git-defender's hooks pass cleanly.
example_files:
  - lefthook.yml
  - package.json
---

# Why this matters

Without the local override, every TS project on an Amazon laptop ships
unenforced hooks — biome, typecheck, vitest, knip never gate a push. The
failure is silent: commits succeed, lefthook never warns, and the regression
only surfaces when a teammate on a non-Amazon machine catches what corp CI
should have caught.

# Example

```bash
# Amazon laptop, fresh project
git init
git config --local core.hooksPath .git/hooks   # scope override to THIS repo
pnpm install                                   # installs lefthook
pnpm exec lefthook install --force             # writes hooks into .git/hooks

# Verify
git config --local --get core.hooksPath        # → .git/hooks
ls .git/hooks/ | grep -v sample                # → pre-commit, pre-push
```

# What NOT to do

- Don't `git config --global --unset core.hooksPath` — that breaks
  git-defender for every other repo on the machine.
- Don't put `git config --local core.hooksPath .git/hooks` in `prepare` —
  pnpm 11's verify-deps-before-run will re-fire prepare on every `pnpm exec`
  and the redundant config writes are noise. Set it once after `git init`.
