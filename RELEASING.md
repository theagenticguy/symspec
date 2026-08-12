# Releasing

Versions are cut by [release-please][rp] from Conventional Commit subjects, and published
to npm by GitHub Actions using [npm Trusted Publishing][tp] — OIDC, no long-lived token in
any secret.

[rp]: https://github.com/googleapis/release-please
[tp]: https://docs.npmjs.com/trusted-publishers

## The normal path

1. Merge Conventional Commits to `main`. `feat:` moves the minor, `fix:` the patch, and a
   `!` or a `BREAKING CHANGE:` footer moves the major.
2. release-please opens (and keeps updating) a release PR that bumps the version, writes
   `CHANGELOG.md`, and updates the four places the version appears.
3. Merge that PR. release-please tags `vX.Y.Z`, creates the GitHub Release, and the
   `publish` job in the same workflow run publishes to npm with provenance.

The version lives in **four** files and every one of them is asserted to agree:
`package.json`, `src/kernel/version.ts`, `README.md`, and the generated `AGENTS.md`. The
three beyond `package.json` are updated through `extra-files` in
`release-please-config.json`, each marked with an `x-release-please-version` comment on the
SAME line as the version — the updater is a per-line substring match, so the comment syntax
does not matter but the line does.

`AGENTS.md` is generated, so its annotation is emitted by `src/kernel/agents-doc.ts`. Edit
it there or `pnpm check:agents` reverts it on the next run.

## Cutting a specific version

Put a `Release-As:` trailer in the commit BODY:

```
chore: cut the first stable release

Release-As: 1.0.0
```

Squash-merge and confirm the trailer survived with `git log -1 --format=%B` — GitHub's
default *merge* commit message drops footers, and the trailer is what release-please reads.

This matters more than it looks. From a prerelease version, release-please's default
strategy carries the prerelease suffix FORWARD: `1.0.0-alpha.0` plus a `feat:` yields
`1.1.0-alpha.0`, not `1.1.0`. The suffix is sticky until something explicitly clears it,
and `Release-As:` is that something.

## What the un-bootstrapped publish job looks like

Until the bootstrap below is done, the `publish` job fails, and the log is the useful part —
probed live on the v1.0.0 run:

```
GET .../idtoken/...?audience=npm%3Aregistry.npmjs.org  200
[WARN] Skipped OIDC: ERR_PNPM_AUTH_TOKEN_EXCHANGE: Failed token exchange request
       with body message: Unknown error (status code 404)
[E404] 404 Not Found - PUT https://registry.npmjs.org/symspec - Not found
```

Read it top to bottom: GitHub issued the OIDC token (`200`, so `id-token: write` is scoped
correctly and the workflow side is fine), **npm** refused the exchange with a 404 because no
trusted publisher exists for a package that does not exist, and pnpm then fell through to an
unauthenticated `PUT` which also 404s.

So `ERR_PNPM_AUTH_TOKEN_EXCHANGE` + `404` on a first release means "the bootstrap has not
happened yet", not "the workflow is wrong". The same pair of errors AFTER bootstrapping means
the trusted publisher does not match — check the workflow filename and that
`repository.url` matches the GitHub repo case-sensitively.

## First publish: the one manual step

Trusted publishing cannot bootstrap a package that does not exist — npm requires the
package to be on the registry before a trusted publisher can be configured for it
(npm/cli#8544). So the first release needs a token, exactly once:

```bash
# 1. Land the release PR so the tag, the manifest and all four version sites agree.
git checkout v1.0.0 && pnpm install --frozen-lockfile

# 2. A short-lived granular token: read-write, "Bypass 2FA" ON (required for
#    non-interactive publish), shortest expiry. It cannot be scoped to `symspec` yet,
#    because the package is not selectable until it exists.
NODE_AUTH_TOKEN=<token> pnpm publish --no-git-checks --tag latest

# 3. Register the trusted publisher now that the package exists. `--file` takes a bare
#    filename, not a path.
npm trust github symspec \
  --repo theagenticguy/symspec \
  --file release-please.yml \
  --allow-publish

# 4. Revoke the token. It is the thing OIDC exists to remove.
npm token list && npm token revoke <id>
```

That first publish carries no provenance attestation: provenance requires a cloud-hosted CI
runner and cannot be generated from a laptop. Every release after it gets one automatically
— provenance is per-version, not per-package.

Worth 30 seconds first: check <https://npmjs.com/settings/~/packages> for a pending-publisher
affordance. If npm has added one, steps 2 and 4 disappear.

## Repository settings this depends on

- **Settings → Actions → General → Allow GitHub Actions to create and approve pull
  requests** must be ON, or release-please fails with `GitHub Actions is not permitted to
  create or approve pull requests`. `default_workflow_permissions` stays `read`: every
  workflow here declares its own per-job permissions, so the repo default should remain
  least-privilege.
- The npm trusted publisher must name `release-please.yml`, because that is the workflow
  whose `publish` job runs `pnpm publish`.

## The release PR runs no CI, and cannot

release-please creates its release PR with the default `GITHUB_TOKEN`, and GitHub does not
start workflow runs from `GITHUB_TOKEN` events. A `push` trigger scoped to the
`release-please--**` branch does not help — that push is the same token.

This is not a gap to work around; it is why the `publish` job runs `pnpm check` before
`pnpm publish`. That step is the ONLY gate on a release PR's contents, so do not remove it
to save a minute.

It is also why `publishConfig.tag` had to be dropped in the release PR itself rather than on
`main`: publish.test.ts asserts the dist-tag agrees with the version in BOTH directions, so
a prerelease with no tag fails just as a stable version with `tag: "alpha"` does. The version
and the tag move together.

## Why one workflow with two jobs

A second workflow keyed on `release: [published]` would never fire. GitHub does not start
workflow runs from events raised by the default `GITHUB_TOKEN`, and release-please's own
README says so. Rescuing that shape needs a PAT or a GitHub App token — reintroducing
exactly the long-lived credential OIDC removes. So the publish job lives in the same
workflow, gated on `release_created`, with `id-token: write` scoped to that job alone.
