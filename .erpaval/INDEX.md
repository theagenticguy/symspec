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
- [A propose-only similarity threshold should favor recall and be MEASURED against the real model, not guessed — 0.82 sat above the whole paraphrase band](solutions/architecture/propose-only-threshold-favor-recall-measure-it.md)
- [A coverage/"nothing checked" disclaimer must be gated on ALL tiers that could have checked — a per-tier counter behind a whole-run claim is a contradictory signal](solutions/architecture/coverage-disclaimer-must-account-for-all-tiers.md)
- [Close a differently-named-guard conflict gap by re-encoding the doc's own state-implications into the conjunction (bridge => context => state), not by fuzzy candidate selection](solutions/architecture/guard-implication-closure-widens-reachability-soundly.md)
- [A doc-committed antonym table is the opposition twin of the synonym glossary — reuse the seed union-find, validate consistency at write time, keep it propose/decide](solutions/architecture/antonym-glossary-mirrors-synonym-glossary-for-opposition.md)
- ["Compared something" ≠ "verified consistency" — a propose-only fuzzy finding may suppress a coverage disclaimer but must NEVER flip a `verified` boolean or exit-code gate](solutions/architecture/verified-is-decide-tier-not-any-comparison.md)
- [For a sound checker's blind spots: SOLVE what's soundly recoverable (propose/decide), DETECT-AND-DEMOTE what isn't — never fabricate a solver](solutions/architecture/detect-and-demote-vs-solve-for-intractable-blind-spots.md)
- [Lenient normalization that helps a PROPOSE signal must not touch the DECIDE key — it turns a suggestion into a fabricated verdict](solutions/architecture/normalization-for-a-propose-signal-must-not-touch-the-decide-key.md)

### orchestration

- [Background subagents can instant-stop with 0 tool calls — SendMessage nudge recovers](solutions/orchestration/subagent-instant-stop-sendmessage-recovery.md)
- [Workflow resume caches byte-identical (prompt, opts) only — edit mid-run with cache discipline](solutions/orchestration/workflow-resume-cache-byte-identity.md)

## Recent additions

- 2026-07-16 — symspec adversarial-eval hardening, round 2 (session-22cb17): closed GitHub issue #2 (28/30 red-team escapes: numeric tier pairwise/same-verb) + the wiki-kernel field report, under DEMOTION-ONLY. SPLIT: reproducer (a) same-quantity-two-verbs → propose-only FND_QUANTITY_ALIAS_CANDIDATE demotes verified + suggests the exact `glossary add` that makes it z3-provable (DECIDE); reproducers (b)/aggregate/cross-quantity/odd-cycle → FND_RELATIONAL_UNCHECKED detect-and-demote (never fabricate a solver). Lint→formal exclusion now LOUD: FND_EXCLUDED_FROM_FORMAL + coverage.{encoded,excluded} + demotion; W1c made the gate waiver-aware (waiving a blocking lint re-admits to the solver). CLI: usage errors name the arg + --file/SYMSPEC_DOC, apply delete accepts id|ref, --field projection, manifest units section, inline antonym suggestion on FND_SIMILAR_SEMANTIC, trace-gated FND_ORPHAN/FND_MISSING_TRACE_LINK. R6 units broadened (mass/volume/rate/distance/currency/calendar) + [0,1] ratio escape. Both reproducers now verified:false, added as regression fixtures (eval-rounds 13/13). Adversarial-critic (refute) caught 3 real issues pre-merge — a fabricated FND_NUMERIC_CONTRADICTION from key-mangling (CRITICAL), a waiver promoting verified (HIGH), a disclaimer-suppression contradiction (MED) — all fixed and re-verified on the built CLI. 1071→1100 tests, all gates green. 2 new architecture lessons.
- 2026-07-13 — symspec v0.1.0 improvement feedback (session-d8d9d5): shipped all 6 ranked items closing the "formal tier only reasons about atoms that already match; mismatch signals capped below the error gate" root cause. #4 `check --strict`/`--fail-on-unmatched` gating coverage signals (new EXIT_INCONCLUSIVE=3); #5 first-class `data.verified` boolean (verified vs inconclusive); #1 doc-committed antonym table + top-level `antonym` command (open/shut now provable — flagship); #3 numeric same-quantity via glossary quantity-alias canonicalization (expire-after vs keep-valid-for); #2 guard-implication closure (bridge requirement links guard→state, transitive conflict named); #6 propose-only FND_OPPOSITION_CANDIDATE under `--semantic`. 916→963 tests, all gates green. Adversarial-critic pass: both new deterministic features SOUND (no constructible false contradiction); fixed 2 low findings — propose-only findings no longer flip `verified`/soften `--strict`, opposition message hardened against the synonym trap. 3 new architecture lessons.
- 2026-07-12 — symspec agent-friendly-CLI eval fixes (session-c9cada): 8 fixes from a hands-on manifest-driven eval. Flagship: `apply` manifest said `--file` but parser takes `--doc` (ERR_USAGE) — gave apply its own describe-field + a manifest ROUND-TRIP test that introspects the commander program (proven to catch the bug on revert). Also: retuned semantic threshold 0.82→0.72 (measured real BGE cosines), suppressed contradictory FND_NO_PAIRS_CHECKED when cross-req findings fired, added `residualRisk` summary to `check`, compound-splitter now emits 2 ready-to-apply `proposedOps` on ERR_PARSE_COMPOUND, documented doc-path convention in manifest, fixed README temporal example to clear GTWR_R26_ABSOLUTE. 880→916 tests, all gates green, adversarial harness 100%/0 gaps. 2 new architecture lessons + extended manifest-single-source lesson.
- 2026-07-11 — symspec field-report wishlist (session-3ae937): all 10 items from the bonk-v5 authoring field report shipped — batch `apply` (JSONL, atomic), stable human keys (key⇄UUID), finding waivers, GtWR R6/R33 standard-identifier allowlist, `check --min-severity/--findings-only`, visible FND_NO_PAIRS_CHECKED, multi-attr + bulk `update`, `verificationNote`, `add --dry-run`. +41 tests (862 total), all gates green. 2 new architecture lessons.
- 2026-07-11 — symspec v3 (session-83ea7d): numeric LIA/LRA tier, ambiguity family, embedding graph + DAG invariants, bounded LTL→SMT temporal tier, and a generative-adversarial detection harness — all under the propose/decide determinism rule. 3 new lessons (2 architecture, 1 conventions). Spec: `.erpaval/specs/002-symspec-v3/`.
- 2026-07-10 — Replaced transformers.js with pure onnxruntime-web WASM + @huggingface/tokenizers; model fetched-on-first-use (sha256-pinned), CLS pooling. Updated embeddings-propose lesson + new conventions lesson on the transformers.js WASM-in-Node trap.
- 2026-07-10 — symspec v2 CLI-native rebuild + semantic paraphrase tier on `main` (6 lessons: 3 architecture, 2 orchestration, 1 conventions)
- 2026-05-13 — TS stack migration on `ears-validated/poc` (3 lessons in `conventions/`)
