// When a pty socket dies, WebKit dispatches a bare `error` Event (no detail)
// before the close event, while Blink goes straight to close. Stringifying
// that Event put "[object Event]" in the disconnect toast — normalize anything
// non-Error into a readable fallback instead.
export const connectionError = (cause: unknown, msg?: string) =>
  cause instanceof Error ? cause : new Error(msg ?? "connection to the server was lost")
