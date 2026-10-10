/** Identity that ties one HTTP attempt to the Atlas hold that reserved it.
 * The client mints the call id so failed or unanswered calls stay findable.
 * The fetch wrapper stamps both onto the response it returns, so a step reads
 * the identity of its own response rather than shared request state. */
export namespace CallLink {
  export const CALL_HEADER = "x-openscience-call"
  export const HOLD_HEADER = "x-openscience-hold-id"
  export const PROVIDER_REQUEST_HEADER = "x-openscience-provider-request-id"
  const HOLD = /^(hold|orgh)_[A-Za-z0-9_]{1,80}$/
  const CALL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const PROVIDER_REQUEST = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$/
  const PROVIDER_HEADERS = [
    "x-generation-id",
    "x-request-id",
    "request-id",
    "openai-request-id",
    "x-goog-request-id",
    "x-amzn-requestid",
    "x-amzn-request-id",
  ]

  function validHold(value: string | null | undefined) {
    return value && HOLD.test(value) ? value : undefined
  }

  function validProviderRequest(value: string | null | undefined) {
    return value && PROVIDER_REQUEST.test(value) ? value : undefined
  }

  export function hold(headers: Headers) {
    return validHold(headers.get(HOLD_HEADER))
  }

  /** Provider-owned response identity. Body metadata wins because streaming
   * APIs often expose their durable generation id only after response headers. */
  export function providerRequest(headers: Headers, responseID?: string) {
    const body = validProviderRequest(responseID)
    if (body) return body
    for (const header of PROVIDER_HEADERS) {
      const value = validProviderRequest(headers.get(header))
      if (value) return value
    }
  }

  export function headers(
    base: HeadersInit | undefined,
    input: { call: string; sessionID: string; messageID: string; attempt: number },
  ) {
    const result = new Headers(base)
    result.set(CALL_HEADER, input.call)
    result.set("x-openscience-message", input.messageID)
    result.set("x-openscience-attempt", String(input.attempt))
    result.set("x-openscience-session", input.sessionID)
    return result
  }

  /** Response headers the wrapper returns: always this attempt's call id, and
   * the hold only when it came from the managed gateway in a valid shape. */
  export function responseHeaders(source: Headers, input: { call: string; hold?: string; providerRequest?: string }) {
    const result = new Headers(source)
    result.set(CALL_HEADER, input.call)
    if (input.hold) result.set(HOLD_HEADER, input.hold)
    else result.delete(HOLD_HEADER)
    if (input.providerRequest) result.set(PROVIDER_REQUEST_HEADER, input.providerRequest)
    else result.delete(PROVIDER_REQUEST_HEADER)
    return result
  }

  /** The call identity of one step, from the response headers the AI SDK
   * attaches to that step (a lowercase record). */
  export function fromResponse(headers: Record<string, string | undefined> | undefined, responseID?: string) {
    const id = headers?.[CALL_HEADER]
    if (!id || !CALL.test(id)) return undefined
    const hold = validHold(headers[HOLD_HEADER])
    const providerRequest = validProviderRequest(responseID) ?? validProviderRequest(headers[PROVIDER_REQUEST_HEADER])
    return {
      id,
      ...(hold && { hold }),
      ...(providerRequest && { providerRequest }),
    }
  }
}
