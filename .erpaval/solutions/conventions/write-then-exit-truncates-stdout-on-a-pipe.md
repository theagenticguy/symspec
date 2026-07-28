---
name: write-then-exit-truncates-stdout-on-a-pipe
description: process.stdout.write + process.exit silently truncates at one pipe buffer (65536 bytes) in Node; use a synchronous fd-1 write loop when the function must return never
metadata:
  type: reference
---

# `process.stdout.write` + `process.exit` truncates stdout on a pipe

Node's `process.stdout` is **asynchronous when it is a pipe** and synchronous
when it is a file or TTY. So this loses data:

```ts
process.stdout.write(`${rendered}\n`)
process.exit(code)            // tears down with the tail still queued
```

Measured on symspec's `check --dense` over an 80-requirement document:

| destination | bytes | valid JSON? |
|---|---|---|
| pipe (`\| wc -c`) | **65536** — exactly one pipe buffer | **no** |
| file (`> out.json`) | 352036 | yes |

This is the worst possible failure shape for an agent-facing CLI: the whole point
of the typed JSON envelope is that an agent can switch on `type` and read
`data.verified`. Instead it got a `JSONDecodeError` — and only on documents large
enough to matter, so small-input testing never catches it.

**Why not just `await` the drain:** the emit function's return type was `never`,
and 76 call sites relied on that for control flow (`if (bad) emit(...)` then
falling through). Making it async would change every one of them.

**How to apply** — synchronous write to fd 1, handling the two wrinkles:

```ts
function writeStdoutAndExit(text: string, code: number): never {
  const buf = Buffer.from(text, 'utf8')       // BYTES, so offsets are correct
  let offset = 0                               // for multi-byte UTF-8
  while (offset < buf.length) {
    try {
      offset += writeSync(1, buf, offset, buf.length - offset)
    } catch (e) {
      const errno = (e as { code?: string }).code
      if (errno === 'EAGAIN') continue         // non-blocking pipe: retry
      if (errno === 'EPIPE') break             // reader hung up (`| head`)
      throw e
    }
  }
  process.exit(code)
}
```

- **Partial writes.** A pipe accepts at most its buffer per call, so `writeSync`
  returns a short count — loop from the new offset. Write *bytes*, not the string,
  or a character can be split across calls.
- **EAGAIN.** If fd 1 is a non-blocking pipe, `writeSync` throws instead of
  blocking; retry the same offset.
- **EPIPE.** `symspec check | head` closes the reader early. Not an error worth
  reporting.

Verify with a byte-for-byte comparison of piped vs redirected output, plus a
`json.load` on the piped bytes — size equality alone is a weaker check than
parseability. Also assert exit codes are unchanged through a pipe.
