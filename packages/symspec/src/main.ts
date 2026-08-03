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
 *
 * ## THE COMPOSITION ROOT
 *
 * This file is the only place that decides where a document lives and where an op
 * stream comes from. Every document operation declares those as REQUIREMENTS in
 * its type (`DocStore`, `DocPath`, `StreamSource`), so:
 *
 * - a handler cannot reach for a filesystem singleton, because it has none;
 * - a test provides an in-memory store instead and exercises the real handler;
 * - and adding an operation that needs a new service is a TYPE ERROR here until
 *   the layer is supplied — the failure lands at the composition root, at compile
 *   time, rather than as a missing-service crash in production.
 *
 * `Layer.provideMerge(appLayer, NodeServices.layer)` rather than two separate
 * `provide`s: the app layers CONSUME `FileSystem` / `Path` / `Stdio` from
 * `NodeServices` and also need those services to remain in the final context (the
 * CLI runtime itself requires the `Environment`). `provideMerge` composes top-down
 * and keeps both, which a bare `provide` would not.
 *
 * ## The two EXPENSIVE Layers are merged, and cost nothing until `check` runs
 *
 * `solverServiceLayer` boots the Z3 WASM module, which is the single most expensive
 * thing this process can do (~200–1000ms measured). Merging it here does NOT pay
 * that cost on `symspec version`: a Layer's construction effect runs when a
 * consumer first REACHES the service, and only `check`'s handler does. So
 * `manifest`, `list`, `show`, and `import` boot no WASM at all, while `check` gets
 * a scoped, disposable module whose release fires when the runtime tears down —
 * which is what lets the process exit cleanly instead of hanging on a pending
 * query. `cli.test.ts` pins the laziness so a future eager reference is a failure
 * rather than a quiet regression in every command's latency.
 */

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Logger } from 'effect'
import { cli } from './cli.ts'
import { storeLayer } from './core/store.ts'
import { embedderServiceLayer } from './formal/embedder.ts'
import { solverServiceLayer } from './formal/solver-service.ts'
import { streamSourceLayer } from './operations/index.ts'

/** Everything the operations require, over the platform services. */
const appLayer = Layer.provideMerge(
  Layer.mergeAll(storeLayer, streamSourceLayer, solverServiceLayer, embedderServiceLayer),
  NodeServices.layer,
)

cli.pipe(
  // Stdout is the envelope contract; diagnostics belong on stderr. Provided as a
  // service VALUE because LogToStderr is a Context.Reference, not a Layer.
  Effect.provideService(Logger.LogToStderr, true),
  Effect.provide(appLayer),
  NodeRuntime.runMain(),
)
