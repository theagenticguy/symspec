/**
 * `StreamSource` — where an operation reads TEXT from, as a contract.
 *
 * Three operations read a text stream that is not a requirements document:
 * `import` (an op stream), `parse` (requirement prose), and `apply` (an op
 * stream). All three want the same "a path, or stdin" behavior, and stdin is
 * exactly the dependency that would otherwise force every one of their tests
 * to spawn a process. The real reader lives in `adapters/stdin/stream.ts`;
 * tests supply an in-memory one.
 */

import { Context, type Effect } from 'effect'
import type { ErrIo } from './errors.ts'

export class StreamSource extends Context.Service<
  StreamSource,
  {
    /** Read the stream from `path`, or from stdin when `path` is null/undefined/empty. */
    readonly read: (path: string | null | undefined) => Effect.Effect<string, ErrIo>
  }
>()('symspec/StreamSource') {}
