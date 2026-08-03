---
title: A migration round-trip test must consume the DONOR's own emitted stream, not one the consumer's test synthesized
track: knowledge
category: architecture
module: packages/symspec/scripts/generate-import-fixtures.sh
component: testing
severity: medium
tags: [differential-testing, fixtures, migration, round-trip, circularity, oracle]
applies_when:
  - writing an importer for a format another tool exports
  - a round-trip test compares "what came out" against "what went in"
  - the producer and consumer live in the same repo and both are yours
pattern: |
  symspec v5's `import` consumes the op stream v4 emits. The obvious way to build
  a fixture is to read the v2 document in the test and synthesize the ops — same
  repo, same author, trivially easy. It is also CIRCULAR: it proves `import`
  agrees with the test file's idea of an op stream, which is the one thing that
  was never in doubt. The producer's actual behavior — including whatever it does
  that nobody remembered — goes untested.

  Generate the fixture by RUNNING THE PRODUCER:

    node dist/donor-cli.mjs <command> <input> > envelope.json
    # harvest the stream out of the real output, per the producer's own
    # documented machine contract

  Then check the generated fixture IN, so the suite stays hermetic and offline,
  and add a test asserting the fixture still LOOKS like producer output (only the
  line kinds it emits, only the op verbs the consumer knows). Without that second
  test, a hand edit to a fixture silently converts the round trip back into a test
  of the consumer's imagination.

  Two practical notes that cost real time:

  - The producer may only emit the stream on a NON-OBVIOUS path. symspec v4 emits
    reproduce-ops exclusively inside its `ERR_SCHEMA_VERSION` error envelope
    (by design — the ops are derivable precisely because the doc already parsed).
    So the generator bumps the version on a COPY, tolerates exit 2, and VERIFIES
    THE ERROR CODE — which is a stronger check than a zero exit, because it
    asserts the intended path was taken rather than merely that something
    happened.

  - Read the producer's CLI surface, do not assume it. `symspec list --file <doc>`
    fails ERR_USAGE (that subcommand takes the doc POSITIONALLY), so the flag
    never reaches the loader and no stream is produced at all — a silent empty
    harvest if the generator does not check the code.

  Compare FIELD FOR FIELD, not by count. A count check passes while an optional
  slot is quietly dropped, which is exactly the failure a migration makes.
example_files:
  - packages/symspec/scripts/generate-import-fixtures.sh
  - packages/symspec/src/operations/import.test.ts
---

# Why this matters

This is the differential-oracle discipline applied to a migration: the donor is
the oracle, so the test input has to come from the donor. When producer and
consumer share a repo and an author, the circularity is invisible — the test is
green, the counts match, and the one behavior nobody wrote down is the one that
breaks in production on the only two documents that exist.

# What NOT to do

Do not synthesize the stream in the test. Do not hand-edit a generated fixture
(regenerate it). Do not assert only on counts. Do not let the generator swallow a
nonzero exit without checking WHICH failure it was — the producer's error path may
be the very path you came for, or it may be a usage error that produced nothing.
