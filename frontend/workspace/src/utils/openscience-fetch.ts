// The local openscience server is loopback-only and unauthenticated (its single
// security control is a Host-header check on the server). The web app therefore
// makes plain fetch/WebSocket calls with no Authorization header.
export const openscienceFetch: typeof fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init),
  { preconnect: typeof fetch.preconnect === "function" ? fetch.preconnect.bind(fetch) : () => undefined },
)
