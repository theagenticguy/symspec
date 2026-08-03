#!/usr/bin/env bash
#
# Regenerate the `import` round-trip fixtures from the two hex-bonk production
# documents, USING THE DONOR CLI — so the op stream under test is the one the
# donor actually emits, not one this package invented and then verified against
# itself.
#
# ## How the donor is coaxed into emitting a reproduce stream
#
# The donor emits its op stream on exactly one path: `ERR_SCHEMA_VERSION`, which
# fires when a document satisfies `RequirementsDocSchema` but declares a
# `schemaVersion` other than 2. That is by design (`src/core/load.ts`) — the ops
# are derivable precisely because the document already parsed.
#
# So this script bumps `schemaVersion` to 999 on a COPY, runs any donor command
# that loads a document, and harvests the ops out of the error envelope's
# `suggestions[]`. The donor's own machine contract, stated in that payload:
# a suggestion starting with `{` is one JSONL op record, one starting with
# `symspec ` is a shell command, anything else is prose.
#
# THIS IS THE DONOR-CLI PATH, not a hand-rolled emitter. The alternative — reading
# the v2 JSON directly and synthesizing ops here — would make the round-trip test
# circular: it would prove `import` agrees with this script's idea of an op stream
# rather than with the donor's.
#
# One donor-CLI wrinkle worth recording: the document path must be POSITIONAL.
# `symspec list --file <doc>` fails with ERR_USAGE (that subcommand takes the doc
# as an argument), so `--file` never reaches the loader and no reproduce stream is
# produced. Use `symspec list <doc>`.
#
# Usage: ./scripts/generate-import-fixtures.sh
# Requires: the donor bundle built at the repo root (`pnpm --filter . build`).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(dirname "$here")"
repo="$(cd "$pkg/../.." && pwd)"
donor="$repo/dist/cli.mjs"
fixtures="$pkg/src/operations/__fixtures__"

if [[ ! -f "$donor" ]]; then
  echo "The donor bundle is missing at $donor — run \`pnpm build\` at the repo root first." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for name in hex-bonk-agent-run-triggers hex-bonk-schedule-management; do
  src="$fixtures/$name.v2.json"
  [[ -f "$src" ]] || { echo "Missing source fixture $src" >&2; exit 1; }

  # Bump the version on a copy so the donor takes its reproduce path.
  bumped="$work/$name.bumped.json"
  node -e '
    const fs = require("node:fs")
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    doc.schemaVersion = 999
    fs.writeFileSync(process.argv[2], JSON.stringify(doc, null, 2))
  ' -- "$src" "$bumped"

  # Harvest the envelope. Exit 2 is EXPECTED here — it is the ERR_SCHEMA_VERSION
  # envelope we came for — so the failure is tolerated and the CODE is verified
  # instead, which is a stronger check than a zero exit would be.
  envelope="$work/$name.envelope.json"
  set +e
  node "$donor" list "$bumped" > "$envelope"
  set -e

  node -e '
    const fs = require("node:fs")
    // NOTE the single skip: under `node -e`, argv is [execPath, ...args] with NO
    // script slot, so the first user argument is argv[1], not argv[2].
    const [, envelopePath, outPath, label] = process.argv
    const env = JSON.parse(fs.readFileSync(envelopePath, "utf8"))
    if (env.code !== "ERR_SCHEMA_VERSION") {
      throw new Error(
        `${label}: expected the donor to emit ERR_SCHEMA_VERSION (its reproduce path); got ` +
          `${env.code ?? env.type}. The donor CLI surface changed — re-read src/core/load.ts.`,
      )
    }
    const suggestions = env.suggestions ?? []
    const ops = suggestions.filter((s) => s.startsWith("{"))
    const commands = suggestions.filter((s) => s.startsWith("symspec "))
    const gaps = suggestions
      .filter((s) => s.startsWith("Not reproduced by the plan above: "))
      .map((s) => s.slice("Not reproduced by the plan above: ".length))
    if (ops.length === 0) throw new Error(`${label}: the donor emitted no op records.`)
    // One JSONL record per line, then the commands, then the gaps as `#gap` lines.
    // `import` accepts all three in one stream, which is what makes the migration a
    // single pipe rather than three coordinated steps.
    const lines = [
      ...ops,
      ...commands,
      ...gaps.map((g) => `#gap ${g}`),
    ]
    fs.writeFileSync(outPath, `${lines.join("\n")}\n`)
    console.log(`${label}: ${ops.length} ops, ${commands.length} commands, ${gaps.length} gaps`)
  ' -- "$envelope" "$fixtures/$name.ops.jsonl" "$name"
done

echo "Fixtures written to $fixtures"
