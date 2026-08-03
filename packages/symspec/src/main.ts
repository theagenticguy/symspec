/**
 * The CLI entry point.
 *
 * Three hardening defaults, each of which was a LIVE BUG in spike S2 rather than
 * a precaution:
 *
 * 1. `Logger.LogToStderr` — the v4 default logger writes to STDOUT (verified by
 *    probe), so a single stray `Effect.log*` anywhere in the program would
 *    corrupt the JSON envelope an agent is parsing. Note it is a
 *    `Context.Reference`, i.e. a service VALUE provided with
 *    `Effect.provideService`, NOT a Layer.
 * 2. `Runtime.errorReported = false` on every error class (in `errors.ts`) — the
 *    marker is INVERTED relative to its name: `false` means "app code already
 *    reported this, do not log it again". Without it, runMain prints a pretty
 *    stack trace AFTER the JSON envelope.
 * 3. `NodeServices.layer` — supplies the whole CLI `Environment`
 *    (`FileSystem | Path | Terminal | ChildProcessSpawner | Stdio`) on its own.
 */

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Logger } from 'effect'
import { cli } from './cli.ts'

cli.pipe(
  // Stdout is the envelope contract; diagnostics belong on stderr. Provided as a
  // service VALUE because LogToStderr is a Context.Reference, not a Layer.
  Effect.provideService(Logger.LogToStderr, true),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain(),
)
