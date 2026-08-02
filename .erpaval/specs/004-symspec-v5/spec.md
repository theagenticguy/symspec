# symspec v5 — Greenfield on Effect v4, with transplant (PLAN, pre-Gate-1)

**Status:** APPROVED at Gate 1 (Laith, 2026-08-02 18:08 CDT) with amendments:
monorepo confirmed; **no MCP server** (G5 reduced to skill/AGENTS projections + publish
posture); **cold-start gate relaxed** — no 100ms kill criterion, measure and report,
"prefer good clean code first"; **certify removed**. Implementation begins.
**Date:** 2026-08-02 · Session: `.erpaval/sessions/session-d4dc8e`
**Supersedes:** DRAFT v1 (strangler migration). Laith redirected 2026-08-02: greenfield,
no backwards compat, built as Effect v4 end-to-end, "transplant the capabilities and
lessons and hardening into greenfield."
**Reference baseline (the donor):** branch `feat/wave1-honesty-repairs` @ `4b11b8e`,
1270 tests, adversarial 15/15. The donor repo is FROZEN as differential oracle once
Wave G1 starts — no further feature work lands on it.

**Standing constraints carried forward (not relitigated):**
- Z3 Spacer in-process; no Veil, Quint, Apalache, nuXmv, or JVM. (Re-examined twice
  this session under greenfield assumptions; verdict unchanged — the weight argument
  is about the product, not legacy. Veil re-enters only if parameterized/quantified
  invariants become a requirement — the old Wave 4 territory.)
- Propose/decide split and demotion-only rule are load-bearing doctrine.
- Single-source derivation: every human- and agent-readable surface is a projection
  of one corpus; drift is a test failure.
- Determinism: given (doc + committed tables + pinned model), `check` is
  byte-reproducible.
- All 75 stable codes (21 ERR_* / 24 GTWR_* / 30 FND_* — verified against the built
  manifest 2026-08-02) survive with meanings intact; append-only discipline continues. Codes are the API agents switch on — greenfield
  drops compat on the DOCUMENT FORMAT and internals, not on the code vocabulary.

---

## What greenfield changes, and what it must not

Greenfield buys four structural wins the strangler could only approximate:

1. **One operations table as the kernel.** Every use case is one entry; CLI parsing,
   MCP server, manifest, AGENTS.md, SKILL.md, and help are projections. The
   commander/manifest/descriptions triple-wiring, the roundtrip drift test, and
   `gen:agents` never exist. (Pattern proven in mem-tml on Effect v4.)
2. **Effect v4 end-to-end, including `effect/unstable/cli`.** With no existing shell,
   the second-migration argument evaporates; we absorb beta churn on a surface we own.
   `HelpDoc` is a format-independent IR — `manifest` derives from the same tree that
   renders `--help`, correct by construction.
3. **State model first-class in the document format from day one.** Requirements
   declare state variables; responses classify as effect-or-constraint at authoring
   time. V27 (retrofitted field silently stripped) is unrepresentable. The Spacer
   reachability chain (donor 003 AC-2-1…2-5, 2-8b) lands as a native wave here, using
   the donor's probe corpus and hazard catalog verbatim.
4. **The agent loop is the spec, not a later wave.** Findings and demotions carry
   structured `repair: {ops[], commands[]}` from the first commit; `data.progress`
   gradient, `explain <code>`, one `proposedOps` name everywhere.

What it must NOT lose (the transplant manifest, § below): the formal tier's
accumulated negative knowledge, the adversarial suite, the code catalogs, the parse
ladder, the GtWR rules, the probe scripts, and `.erpaval/solutions/` (28 lessons).
Precedent that motivates the discipline: the v2 rebuild took ~7 hardening sessions to
reach 15/15 adversarial. The transplant exists so v5 does not reset that clock.

## Where it lives

New pnpm workspace package inside the same repo: `packages/symspec/` (greenfield)
with the donor frozen at the repo root (or moved to `packages/donor/` — mechanical
choice at G1 start). Same repo, because: the adversarial fixtures, probe scripts, and
solutions corpus stay adjacent; differential testing runs both CLIs in one CI job; and
git history over the donor remains greppable during ports. The new package is
`symspec@1.0.0-alpha.N`, publishes the same `symspec` bin, and OWNS the name at GA.

**Document format:** new format (v3), no read-compat with v2 docs. Migration is a
one-shot import: the donor's reproduce-ops (AC-1-5) already emits the exact op stream
that rebuilds a document — `symspec-v4 reproduce | symspec import` is the entire
migration story. The two production docs in hex-bonk (`agent-run-triggers`,
`schedule-management`) are the import test fixtures.

**Effect posture:** exact pin `effect@4.0.0-beta.<current>` + `@effect/platform-node`
same version, coordinated catalog, lockfile-committed, deliberate bumps with changelog
review. `@effect/language-service` in the check gate. Local lessons file
(mem-tml/croq-studio/codegraph, digested in session-d4dc8e) is REQUIRED READING in
every Act brief: `Effect.result` not `either`; `{onExcessProperty:"error"}` on every
decode; `Schema.Finite` on JSON-Schema surfaces; `provideMerge` composes top-down;
`NullOr` over `optional` on wires; `Config` snapshots env at init; `Logger.LogToStderr`
in the MCP server; never trust recalled v4 API shapes — verify against the installed
beta.

**Kill/freeze criteria (amended at Gate 1):**
- Cold start: NOT a gate. Measure at G0 and again at each wave exit; report the number.
  Clean code wins ties; optimize only if a real agent loop feels it.
- K3: two consecutive beta bumps each breaking > 10 files → freeze the pin until GA.

---

## Transplant manifest (port as-is; wrap, don't rewrite)

| Asset | From (donor) | Into | Port mode |
|---|---|---|---|
| Formal tier (~7.8k LOC: atomizer, encoder, Z3 backend, contradiction/subsumption/vacuity/numeric/temporal/semantic, budget) | `src/formal/` | `formal/` behind a `SolverService` Layer | Verbatim first, Effect-ize interfaces only; findings byte-identical vs donor on shared fixtures |
| Code catalogs + meta corpora (ERR_*/GTWR_*/FND_* + describe text) | `src/{core,lint,formal}/codes.ts` | Schema-annotated literals; tags of `Schema.TaggedErrorClass` for ERR_* | Meanings/text verbatim; append-only snapshot guards re-created |
| Adversarial suite (12 pinned eval rounds, generator, harness) | `adversarial/` | `adversarial/` unchanged | Fixtures verbatim; harness re-pointed at new `runCheck`. 15/15 is a merge gate from Wave G2 on |
| Parse ladder (Tier1 regex / Tier2 wink-nlp / Tier3 structured error) | `src/parse/` | `parse/` | Verbatim; one field name `proposedOps` (donor AC-3-9 fixed by construction) |
| GtWR lint rules + waiver semantics | `src/lint/` | `lint/` | Verbatim rules; gate logic re-expressed |
| Spacer probe corpus + hazard catalog (V13/V14/V15/V16 + ~30 scripts) | `.erpaval/sessions/session-511b2b/probes/`, spec 003 findings table | committed under `probes/` in the new package | Copy + a PROBES.md index; these are the reachability wave's design inputs |
| reproduce-ops | `src/core/reproduce.ts` | the `import` command | Adapted: emitter stays donor-side, consumer is new |
| Lessons corpus (28) | `.erpaval/solutions/` | unchanged location (shared) | Nothing to do; recall already works |
| Test fixtures | `src/**/__tests__/` fixture docs | new test tree | Fixtures port even where plumbing doesn't; donor test COUNT is not the metric — behavior parity is |
| Envelope + exit contract | `src/cli/{envelope,exit}.ts` | kernel types | Shape preserved (`{apiVersion,type,data}`, exit 0/1/2/3) — this is agent API, not legacy |

Explicitly NOT ported: commander wiring, manifest.ts hand-table, descriptions.ts,
`gen-agents.ts`, the roundtrip test, `emit(): never` spine, Zod (greenfield is
Effect Schema native; no bridge needed), the placeholder `certify` command (deferred
until a real encoding exists — honesty by absence beats a disclosed tautology; donor
Wave 4 AC-4-1/4-2 remain the future-work spec).

---

## Waves

```
G0 spikes (~1 day, parallel)
   S1 cold-start bench (K1)   S2 ops-table kernel PoC   S3 formal-tier-in-Layer PoC
        │
G1 kernel: ops table → CLI/help/manifest projections, envelope, exit contract,
   TaggedErrorClass catalog, doc store (v3 format WITH stateModel), import command
        │
G2 transplant: formal + parse + lint + adversarial + differential oracle in CI
   (donor and greenfield `check` on shared fixtures → same findings, same codes)
        │
G3 agent loop native: repair{ops[],commands[]} on every demotion/finding,
   data.progress gradient, explain <code>, budgetHint, authoring-craft skill surface,
   install targets (Kiro md glob, .agents/skills for opencode/gemini, auto default)
        │
G4 reachability: state-model authoring UX + Spacer Horn encoding
   (donor 003 AC-2-1…2-5 + 2-8b designs adopted wholesale: explicit frame choice,
   out-of-band timeout detection vs the "ok" bug, invariant/trace as evidence,
   unknown → demotion with the exact supplying command, feasibility gate in CI)
        │
G5 fleet surface (reduced at Gate 1: no MCP server):
   skill/AGENTS generation as HelpDoc projections, install targets, npm publish posture
```

Gates: G2 exits only when the differential oracle is green and adversarial is 15/15.
G4 exits only when every V13–V16 hazard has a regression test that FAILS if the
mitigation is removed (guards-must-fire discipline). Each wave is its own erpaval
session with its own task packets; this spec is the map, not the packets.

**Donor 003 Wave 2 disposition:** absorbed into G4. The Spacer chain does NOT land on
the donor; its spec sections, probe corpus, and the AC-2-5 frame decision transfer as
G4's design documents. Donor 003 Waves 3/4 map to G3 and future-work respectively.

## Effort shape (estimate, not commitment)

G0 ~1 day · G1 ~2 sessions · G2 ~2-3 sessions (differential debugging is the long
pole) · G3 ~2 sessions · G4 ~2-3 sessions (hazard-heavy; budget like donor Wave 2) ·
G5 ~1-2 sessions. Total ~10-12 sessions to parity-plus; donor stays usable throughout.

## Risks, priced

| Risk | Mechanism | Mitigation |
|---|---|---|
| Rebuild resets the hardening clock | v2 precedent: ~7 sessions to 15/15 | transplant manifest + differential oracle + fixtures-verbatim; adversarial gate from G2 |
| v4 beta churn on the CLI surface we now own | unstable/cli breaks in minors | exact pin, K3 freeze; ops-table kernel isolates the shell — a CLI-API break touches one projection |
| Cold start | Effect runtime + 22 commands, <150ms target | S1 first; K1 is stop-and-decide with Laith |
| LLM/recall API drift | 3 codebases documented "differs from recall" | lessons file required in every Act brief; verify against installed beta |
| Formal-tier port introduces silent behavior drift | interface Effect-ization touches call sites | byte-identical findings gate on shared fixtures (G2 exit) |
| Two live symspec docs strand | hex-bonk agent-run-triggers, schedule-management | reproduce→import path is a G1 deliverable with those docs as fixtures |

## Gate 1 record (2026-08-02)

1. Repo shape → APPROVED: monorepo, `packages/symspec/`, donor frozen as oracle.
2. Cold-start → GATE REMOVED: "I don't need the 100ms cold start thing, just raise
   it. Prefer good clean code first." Measure and report only.
3. `certify` removal → APPROVED.
4. Volunteered: no MCP server needed. G5 reduced accordingly; the ops-table kernel
   still keeps that door open at near-zero cost if it's ever wanted.
