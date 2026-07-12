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
- [transformers.js can't force ONNX WASM in Node — drive onnxruntime-web directly](solutions/conventions/transformersjs-cannot-force-wasm-in-node.md)
- [Z3 quotes digit-leading symbols (UUIDs) as |...| in the unsat core — strip before matching](solutions/conventions/z3-quotes-digit-leading-symbols-in-unsat-core.md)

### architecture

- [EARS→SMT conflicts need per-context-group reachability; minimize cores before blaming](solutions/architecture/smt-context-group-reachability.md)
- [Manifest/AGENTS.md/code tables derive from Zod .describe() + enums; drift is a test failure](solutions/architecture/manifest-single-source-derivation.md)
- [Embeddings propose, glossary+SMT decide — bridge paraphrased conflicts without breaking determinism](solutions/architecture/embeddings-propose-smt-decide.md)
- [A generative-adversarial bad-spec harness finds detector gaps a green suite misses — wire it as a gate](solutions/architecture/generative-adversarial-harness-drives-detector-fixes.md)
- [Bounded LTL→SMT needs an F(antecedent) reachability assertion or every G(trig→…) is vacuously SAT](solutions/architecture/temporal-bounded-ltl-reachability-subtlety.md)
- [Batch CLI mutation: fold the singular applyChange yourself for per-op results; plural applyChanges stops on first error](solutions/architecture/batch-apply-atomic-fold-per-op-results.md)
- [Add key⇄UUID addressing at the one resolver every id-command funnels through — six commands get keys for free](solutions/architecture/stable-key-resolution-single-chokepoint.md)
- [Install an agent skill into a host's dedicated skill/rule dir (never its root doc); .agents/skills covers Claude+Cursor+Codex; generate body from manifest corpus](solutions/architecture/agent-host-skill-install-dirs.md)

### orchestration

- [Background subagents can instant-stop with 0 tool calls — SendMessage nudge recovers](solutions/orchestration/subagent-instant-stop-sendmessage-recovery.md)
- [Workflow resume caches byte-identical (prompt, opts) only — edit mid-run with cache discipline](solutions/orchestration/workflow-resume-cache-byte-identity.md)

## Recent additions

- 2026-07-11 — symspec field-report wishlist (session-3ae937): all 10 items from the bonk-v5 authoring field report shipped — batch `apply` (JSONL, atomic), stable human keys (key⇄UUID), finding waivers, GtWR R6/R33 standard-identifier allowlist, `check --min-severity/--findings-only`, visible FND_NO_PAIRS_CHECKED, multi-attr + bulk `update`, `verificationNote`, `add --dry-run`. +41 tests (862 total), all gates green. 2 new architecture lessons.
- 2026-07-11 — symspec v3 (session-83ea7d): numeric LIA/LRA tier, ambiguity family, embedding graph + DAG invariants, bounded LTL→SMT temporal tier, and a generative-adversarial detection harness — all under the propose/decide determinism rule. 3 new lessons (2 architecture, 1 conventions). Spec: `.erpaval/specs/002-symspec-v3/`.
- 2026-07-10 — Replaced transformers.js with pure onnxruntime-web WASM + @huggingface/tokenizers; model fetched-on-first-use (sha256-pinned), CLS pooling. Updated embeddings-propose lesson + new conventions lesson on the transformers.js WASM-in-Node trap.
- 2026-07-10 — symspec v2 CLI-native rebuild + semantic paraphrase tier on `main` (6 lessons: 3 architecture, 2 orchestration, 1 conventions)
- 2026-05-13 — TS stack migration on `ears-validated/poc` (3 lessons in `conventions/`)
