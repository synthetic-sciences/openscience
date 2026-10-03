// A launcher the person started (the CLI's `web` command or the desktop app)
// opens the workspace with a one-time `#terminal-code=` fragment. Trading it
// at the server sets an HttpOnly cookie that lets this browser open the
// person's own shell in the Terminal tab; without it terminals stay
// sandboxed. See backend/cli/src/pty/key.ts.

const PARAM = "terminal-code"

/** Read the launch code and remove it from the address bar and history. */
export function takeTerminalCode(location: Pick<Location, "hash" | "pathname" | "search">, history?: History) {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""))
  const code = fragment.get(PARAM) ?? undefined
  if (!code) return
  fragment.delete(PARAM)
  const rest = fragment.toString()
  history?.replaceState(history.state, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`)
  return code
}

/** Spend the code once. Resolves either way: a refused or failed exchange
 *  only means this browser's terminals stay sandboxed. */
export async function exchangeTerminalCode(input: {
  code: string
  url: string
  fetch: typeof fetch
  timeoutMs?: number
}): Promise<boolean> {
  return input
    .fetch(input.url, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code: input.code }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 3_000),
    })
    .then(async (response) => response.ok && (await response.json()) === true)
    .catch(() => false)
}
