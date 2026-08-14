/**
 * The ERR_* -> wire projection.
 *
 * The 21 error classes and their catalog readers live in `ports/errors.ts` —
 * they are contract vocabulary any ring may name. This file is the app-ring
 * half: the one function that turns an {@link OperationalError} into the wire
 * envelope, plus the exit code that family maps to.
 */

import type { OperationalError } from '../../ports/errors.ts'
import { EXIT_OPERATIONAL_ERROR } from '../../ports/exit.ts'
import { type ErrorEnvelope, failure } from './envelope.ts'
// ---------------------------------------------------------------------------
// The envelope projection
// ---------------------------------------------------------------------------

/**
 * Project an operational error onto the wire error envelope.
 *
 * NO STRUCTURAL SNIFFING: the parameter is the closed {@link OperationalError}
 * union, so `_tag` is statically known to be a real ERR_* code and the fields
 * are statically known to exist. There is no `in` test, no `instanceof` ladder,
 * and no default code — the compiler, not a runtime guess, guarantees the
 * envelope's `code` is one of the 21.
 */
export const toErrorEnvelope = (e: OperationalError): ErrorEnvelope =>
  failure({
    error: e.error,
    code: e._tag,
    suggestions: e.suggestions,
    ...(e.partial !== undefined ? { partial: e.partial } : {}),
    ...(e.repair !== undefined ? { repair: e.repair } : {}),
  })

/** The exit code every operational error maps to. Re-exported for call sites. */
export { EXIT_OPERATIONAL_ERROR }
