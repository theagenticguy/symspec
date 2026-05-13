---
title: pnpm 11 verify-deps-before-run + prepare lefthook + non-git directory
track: knowledge
category: conventions
module: package.json
component: pnpm@11
severity: info
tags: [pnpm, lefthook, prepare-script, git, ts-stack]
applies_when:
  - pnpm@11.x is the package manager
  - lefthook is installed via the prepare script
  - the project may live in a directory that is NOT yet a git repo (e.g., a fresh POC, a sub-directory of a larger workspace)
pattern: |
  In pnpm 11, every `pnpm exec <cmd>` first runs an internal `pnpm install` to
  verify deps, which re-fires the `prepare` script. If `prepare` exits non-zero
  for ANY reason (lefthook can't find a git repo, a hook tool is missing,
  whatever), every subsequent `pnpm exec` call fails with an opaque
  "Command failed with exit code 1" pointing at pnpm's internal install.

  Two complementary fixes:
    1. Don't put `lefthook install` in `prepare`. Use an explicit
       `hooks:install` script the user runs once after `git init`.
    2. Put `verify-deps-before-run=false` in `.npmrc` to stop pnpm 11 from
       running install before every exec.

  Also add `pnpm.onlyBuiltDependencies` to `package.json` for known native
  builders (esbuild, lefthook) so pnpm's "ignored builds" warning doesn't
  trip CI.
example_files:
  - package.json
  - .npmrc
---

# Why this matters

A canonical TS stack pinned to pnpm 11 will silently fail in any directory that's
not a git repo if `prepare` runs `lefthook install`. The error message points at
pnpm internals, not at lefthook, so it takes a few minutes to diagnose. Move the
hook install out of `prepare` and disable verify-deps-before-run.

# Example

```json
// package.json
{
  "scripts": {
    "hooks:install": "lefthook install",
    "check": "biome ci . && tsc --noEmit && vitest run && knip"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild", "lefthook"]
  }
}
```

```ini
# .npmrc
auto-install-peers=true
strict-peer-dependencies=false
verify-deps-before-run=false
```
