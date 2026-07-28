---
name: lexicon-entries-need-per-entry-reachability-tests
description: A trailing \b after a lexicon entry ending in '.' can never match; assert every entry fires, and classify by the MATCHED text not the source's last character
metadata:
  type: conventions
---

# Lexicon entries need per-entry reachability tests

Both GtWR lexicons compiled as `` `\b(${entries.join('|')})\b` ``. A trailing `\b`
after an entry whose match ends in `.` can **never** hold — `.` is already a
non-word character, so there is no word/non-word transition to assert. Six
entries were unreachable dead code:

- R9: `etc\.` — the canonical INCOSE GtWR R9 exemplar, named in R9's own finding
  description. The rule advertised a check it could not perform.
- R38: `approx\.`, `temp\.`, `ref\.`, `std\.`, `alt\.`

The identical bug had already been found and fixed for R6 in the *same file*
(`%` and `°C` are not `\b`-terminable) and the fix was never propagated. A green
test suite hid all of it, because every fixture happened to use a bare-word entry.

**The trap when fixing it.** The obvious classifier — "entry ends in a non-word
character ⇒ drop the trailing `\b`" — is wrong. `min(?!imum)` ends with `)` in its
regex *source*, but the text it *matches* ends at the word character `n`. Dropping
its `\b` makes `min` fire inside `minute`, `mining`, `minor`. That trades 6 dead
entries for 3 live false positives, and `minimum`/`maximum` fixtures do **not**
catch it because the lookahead still suppresses those. Classify on the escaped
`\.` suffix (i.e. on what the entry matches), not on the last source character.

Branch order matters too: emit the non-`\b`-terminable branch **first** so a
lexicon holding both `spec` and `spec.` prefers the longer match, rather than
matching `spec` inside `spec.` and reporting a span one character short.

**How to apply:** compile lexicons through one helper that splits terminable from
non-terminable entries, and add a **table-driven test that asserts every entry of
every lexicon fires on a fixture**. Verify the test actually catches regressions
by breaking an entry and observing the failure — the agent that fixed this found
its first test version passed a "fix" that introduced the `min` false positives,
and only caught it because it ran that experiment.

Pair the reachability table with a clean-input canary (a well-formed sentence must
produce zero findings) — that canary is the first thing a broadened pattern breaks.
