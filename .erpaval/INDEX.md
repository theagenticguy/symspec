# ERPAVal lessons index

Lessons learned from prior ERPAVal sessions. Claude reads this at
session start and greps `.erpaval/solutions/**` for relevant
lessons before starting work.

## By category

### conventions

- [pnpm 11 verify-deps-before-run + lefthook prepare + non-git dir](solutions/conventions/pnpm11-prepare-script-and-git-init-order.md)
- [exactOptionalPropertyTypes — omit the key, don't assign undefined](solutions/conventions/exact-optional-property-types-omit-key-idiom.md)
- [Biome noNonNullAssertion off when noUncheckedIndexedAccess is on](solutions/conventions/biome-noNonNullAssertion-off-when-noUncheckedIndexedAccess.md)
- [knip can't trace variable-specifier dynamic imports — ignoreDependencies carve-out](solutions/conventions/knip-variable-specifier-dynamic-import.md)

### architecture

- [EARS→SMT conflicts need per-context-group reachability; minimize cores before blaming](solutions/architecture/smt-context-group-reachability.md)
- [Manifest/AGENTS.md/code tables derive from Zod .describe() + enums; drift is a test failure](solutions/architecture/manifest-single-source-derivation.md)
- [Embeddings propose, glossary+SMT decide — bridge paraphrased conflicts without breaking determinism](solutions/architecture/embeddings-propose-smt-decide.md)

### orchestration

- [Background subagents can instant-stop with 0 tool calls — SendMessage nudge recovers](solutions/orchestration/subagent-instant-stop-sendmessage-recovery.md)
- [Workflow resume caches byte-identical (prompt, opts) only — edit mid-run with cache discipline](solutions/orchestration/workflow-resume-cache-byte-identity.md)

## Recent additions

- 2026-07-10 — symspec v2 CLI-native rebuild + semantic paraphrase tier on `main` (6 lessons: 3 architecture, 2 orchestration, 1 conventions)
- 2026-05-13 — TS stack migration on `ears-validated/poc` (3 lessons in `conventions/`)
