export namespace Reason {
  /** A rejection is not always an `Error` instance: any `throw` or reject path,
   *  and some runtime internals, surface strings, plain objects, or `undefined`.
   *  A bare `${error.message}` on those renders the literal word "undefined" in
   *  the one message the user reads, hiding the detail at exactly the moment it
   *  matters. Render whatever arrived instead. */
  export function of(error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}
