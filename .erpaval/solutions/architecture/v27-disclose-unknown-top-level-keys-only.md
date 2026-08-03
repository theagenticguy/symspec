---
title: Forward compatibility that survives a WRITE — partition unknown TOP-LEVEL keys, disclose them, write them back
track: knowledge
category: architecture
module: packages/symspec/src/core/document.ts
component: effect-schema
severity: high
tags: [forward-compatibility, schema-strictness, silent-data-loss, V27, diagnostics, disclosure]
applies_when:
  - a persisted document is read, mutated, and written back by a tool that may be older than the file
  - choosing between strip / passthrough / strict on a schema for an on-disk format
  - a later wave will add a new top-level table to a format that already ships
pattern: |
  Donor finding V27, verified: a document schema in Zod's default STRIP mode,
  round-tripped through `safeParse` on every mutation, DESTROYS any key the build
  does not know. Measured: a doc carrying `stateModel` loaded and checked fine,
  and after ONE `symspec add` the key was gone — no error, no warning, no
  finding. Forward compatibility was READ-ONLY, and because a proof was
  conditional on that model, the next check silently fell back to "no state
  model" and demoted with the cause invisible.

  All three obvious options are wrong, and each is wrong differently:
    - STRIP (`onExcessProperty:'ignore'`) — the defect itself.
    - PASSTHROUGH (`'preserve'`) — round-trips UNVALIDATED data into a file the
      rest of the system reads. A typo'd `requirments` persists forever looking
      authoritative.
    - STRICT (`'error'`) — breaks the forward READ that already worked: a file
      written by a newer build becomes unreadable by an older one, for a key the
      older one does not even need.

  The fourth option, which is the one that works:

    1. PARTITION the top level into keys the schema names and keys it does not.
    2. Decode ONLY the known keys, STRICTLY. Strictness is not weakened anywhere
       except the single place forward compat needs it.
    3. Carry the unknown keys on the load result (`unknownKeys`) and DISCLOSE
       them as info-grade diagnostics.
    4. Re-attach them at SERIALIZE time, so a save writes them back verbatim.

  Step 4 is the half V27 was missing. With it, forward compatibility is
  read-AND-write: an older binary can load, mutate, and save a newer file without
  destroying the part it does not understand.

  SCOPE IT TO THE TOP LEVEL, deliberately. A top-level key is the granularity a
  whole new table arrives at (`stateModel` was exactly that shape) and preserving
  one costs nothing because no existing code reads it. An unknown key INSIDE a
  record is a different animal: records are what the analysis tier consumes, so
  an unrecognized field there is far likelier a typo than a forward-compat table,
  and letting it through means silently ignoring data the author believed was
  load-bearing. Asserting each of those separately is what keeps a future
  "let's just relax the decode options" from passing the suite.

  Grade the disclosure `info` EXPLICITLY, as data, not by convention — the exit
  contract reads `severity` structurally, and `error` would gate the process to a
  nonzero exit for a key that is emphatically not a build failure.

  Structural complement: make the field FIRST-CLASS in the format from day one
  rather than adding it later. There is then no "retrofit a field into a
  strip-mode object" step to get wrong, because the field was never absent.
example_files:
  - packages/symspec/src/core/document.ts
  - packages/symspec/src/core/document.test.ts
  - packages/symspec/src/core/store.ts
---

# Why this matters

"Forward compatible" almost always means forward-READ compatible, and nobody
notices the difference until an older tool writes the file back. The write is
where the data dies, and it dies quietly — which is why the mitigation has to
include a save-side step and a round-trip test, not just a lenient decode.

# What NOT to do

Do not reach for passthrough because it is one option flag: unvalidated data
persisting into a file the analysis tier reads is a worse problem than the one
being solved. Do not scope the leniency below the top level. Do not grade the
disclosure above `info` — a forward-compat key is not a defect, and gating on it
teaches an agent to ignore the exit code. Do not skip the negative control: strip
the keys the way a strip-mode decode would and assert the round trip demonstrably
LOSES them, or the preservation tests are measuring nothing.
