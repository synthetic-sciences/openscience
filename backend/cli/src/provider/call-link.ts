/** Identity that ties one HTTP attempt to the Atlas hold that reserved it.
 * The client mints the call id so failed or unanswered calls stay findable. */
export namespace CallLink {
  const HOLD = /^(hold|orgh)_[A-Za-z0-9_]{1,80}$/

  export function hold(headers: Headers) {
    const value = headers.get("x-openscience-hold-id")
    return value && HOLD.test(value) ? value : undefined
  }

  export function headers(
    base: HeadersInit | undefined,
    input: { call: string; sessionID: string; messageID: string; attempt: number },
  ) {
    const result = new Headers(base)
    result.set("x-openscience-call", input.call)
    result.set("x-openscience-message", input.messageID)
    result.set("x-openscience-attempt", String(input.attempt))
    if (!result.has("x-openscience-session")) result.set("x-openscience-session", input.sessionID)
    return result
  }
}
