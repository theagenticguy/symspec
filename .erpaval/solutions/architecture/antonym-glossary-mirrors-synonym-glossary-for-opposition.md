---
title: A doc-committed antonym table is the opposition twin of the synonym glossary — reuse the seed union-find, validate consistency at write time, keep it propose/decide
track: knowledge
category: architecture
module: src/core/schema.ts, src/cli/glossary.ts, src/formal/atomize.ts, src/formal/antonyms.ts, src/formal/semantic.ts
component: symspec
severity: high
tags: [antonym, glossary, atomize, union-find, propose-decide, opposition, contradiction, cli, false-positive]
applies_when:
  - a sound checker unifies synonyms via a committed glossary but has no equivalent for OPPOSITES
  - opposite-word conflicts (open/shut, grant/deny) atomize to distinct atoms and hide
  - adding an embedding "propose opposition candidates" pass
pattern: |
  symspec already ships embeddings-propose / glossary-decide for SYNONYMS: a
  committed doc glossary canonicalizes response atoms so paraphrased conflicts
  become provable. There was no equivalent for OPPOSITES — open/shut, grant/deny,
  permit/prohibit in different words are distinct atoms, so the SMT tier never
  sees same-atom-opposite-polarity and the conflict is a false negative.

  The clean shape is a doc-committed antonym table that MIRRORS the synonym
  glossary end-to-end:
    - Doc schema: `antonyms: {a,b}[]` next to `glossary`, `.default([])` so it is
      backward-compatible with existing docs (no SCHEMA_VERSION bump — same as how
      glossary/waivers default). Store NORMALIZED verb heads.
    - Atomize: the existing seed antonym table (antonyms.ts) already resolves a
      signed union-find via buildAntonymIndex(pairs). Reuse it: at check time fold
      seed + doc pairs through the SAME builder (buildAntonymIndexWithDoc), thread
      the merged index into atomize via a new optional `antonyms?` arg (default =
      seed ANTONYM_INDEX, so every existing caller is byte-identical). A doc pair
      that bridges or shares a member with a seed class is resolved correctly
      because the builder rebuilds the whole union-find, not an overlay.
    - CLI: cores in glossary.ts mirroring glossaryAdd/Remove/List, wired as a
      command. NOTE the envelope-type contract: the types-enum test requires the
      enum to equal exactly {command names} + 'error', and each type has ONE data
      shape — so antonym data ({action, antonyms}) cannot ride under the
      'glossary' type. Ship it as a peer TOP-LEVEL `antonym` command (like
      `waive`), not folded under glossary, even if a `glossary antonym <a> <b>`
      sub-command reads more naturally.
    - contradiction.ts needs NO change: get open/shut to atomize to one atom at
      opposite polarity and the existing solver proves it. Thread the doc antonym
      index through BOTH makeAtomize call sites (main closure AND encodeIncluded,
      so the --emit-smt2 export matches the in-process check).

  Load-bearing WRITE-TIME validation (the false-positive guard): buildAntonymIndex
  THROWS on an odd/inconsistent polarity cycle. Validate in `antonym add` and
  return ERR_USAGE if the new pair makes the classes inconsistent — this keeps the
  check path throw-free (a hand-edited bad doc falls back to seed-only). Also
  reject a self-pair (a≡a).

  The DANGER, surfaced by adversarial review: an antonym is the ONE committed
  entry whose wrong value MANUFACTURES a false contradiction (glossary's worst
  case only MASKS one). If an embedding "opposition proposal" (#6) suggests
  `antonym add` for a SYNONYM pair (delete/remove, close/shut — embeddings CANNOT
  separate antonymy from synonymy, they embed CLOSE), a careless commit collapses
  two identical responses to R vs ¬R → false FND_CONTRADICTION. So the opposition
  proposal must be propose-only, structural (same object remainder + different
  leading verb, cosine only a topical-relatedness floor), and its MESSAGE must
  offer BOTH `antonym add` (if opposites) and `glossary add` (if synonyms) with an
  explicit "committing the wrong one manufactures a false contradiction" warning —
  never a bare antonym-add command.
example_files:
  - src/core/schema.ts
  - src/cli/glossary.ts
  - src/formal/atomize.ts
  - src/formal/antonyms.ts
  - src/cli/__tests__/antonym.test.ts
---

# Why this matters

Opposition is the symmetric gap to synonymy, and closing it with the same
propose/decide discipline is what flips the largest class of "conflict in
different words" false negatives (open/shut bypass valve) into provable
contradictions — without a fuzzy score ever touching a verdict. See
[[embeddings-propose-smt-decide]] for the synonym half this mirrors.

# What NOT to do

Do not fold a new command's distinct data shape under an existing envelope type
(the types-enum contract forbids it). Do not emit a bare `antonym add` suggestion
from a fuzzy pass — embeddings cannot tell opposites from synonyms, and the wrong
commit is the tool's worst bug (a manufactured false positive). Always validate
antonym consistency at write time so the sound check path never throws.
