# Post-v2 follow-ups

## v3+ — Semantic EARS→Lean encoding for `certify` (validate-critic M3)

**Decision (2026-07-10):** v2's `certify` maps each requirement to a placeholder
`True := by decide` theorem — it exercises the full Lean toolchain path (batched
emission, elaboration, `#print axioms` provenance, artifact retention) but does
NOT encode requirement semantics, so the certificate attests only that Lean ran.
This is disclosed honestly in the `FND_CERTIFIED` finding message and in a
`docToTheorems` code comment (src/cli/index.ts).

**Follow-up scope:** encode EARS requirements as real Lean propositions (reuse
the atomize/encode formal model that already feeds the SMT tier — the guarded
implication `guard → obligation` translates to a Lean `Prop`), so the certificate
is a kernel-checked proof ABOUT the spec's consistency, not a tautology. No
published EARS→Lean pipeline exists — this is the genuine research contribution
the Lean tier was chosen for (research-lean4.md). Reserve for after the core
tiers stabilize.

---

**NOTE:** The semantic-similarity tier (local BGE embeddings) was PROMOTED out
of this follow-up list into CORE v2 scope on 2026-07-10 — see
`spec-semantic.md`. Rationale: symspec's stated goal is *conflict-free
specifications*; a conflict hidden only because two responses are worded
differently ("issue a session token" vs "issue a login credential") is a
conflict symspec must surface, so paraphrase-bridging is a prerequisite for the
core promise, not an assist.
