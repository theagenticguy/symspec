# Binding scope changes (user decisions, override spec.md where they conflict)

## SC-1 (2026-07-10): No migrate command
v2 ships no `symspec migrate`. AC-1-10 cancelled.

## SC-2 (2026-07-10): Clean slate — remove ALL v1 + migration ceremony
v2 behaves as if v1 never existed. Concretely:

- **No legacy-binary detection**: `src/core/load.ts` must not sniff Automerge
  magic bytes or special-case "legacy format" in errors/suggestions. Any
  unparseable/unknown file is plain `ERR_DOC_PARSE` (generic suggestions:
  check the path, or `symspec init` a new doc). Remove
  `RECREATE_DOC_SUGGESTIONS` legacy-notice wording and the legacy-vs-stale
  disjointness tests' legacy half.
- **ERR_SCHEMA_VERSION survives** but is forward-looking only (a v2-shaped doc
  with schemaVersion != 2); its suggestions never mention v1 or migration.
- **No `migrate` anywhere**: remove the `migrate` command entry from
  `src/cli/manifest.ts`; remove stale migrate/Automerge doc-comments (e.g.
  `src/core/doc.ts` header).
- **@automerge/automerge fully gone**: package.json, lockfile, tsdown.config.ts,
  knip.json — no carve-outs needed.
- **Spec hygiene**: spec.md AC-1-10 marked cancelled; error-code table row for
  migrate suggestions corrected (edit is allowed despite tasks.md being
  generated — record the change here).
- **README/AGENTS.md (Wave 8)**: no mention of v1, migration, Automerge, MCP,
  or Bedrock history. The docs describe v2 on its own terms.

Enforcement: integration-gate agents grep for `migrate`, `automerge`,
`Automerge`, `legacy` across src/ and fail the gate on hits (except this file
and session logs).
