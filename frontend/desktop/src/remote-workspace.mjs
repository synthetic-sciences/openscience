/** Remote workspaces are whole, isolated windows served by the selected runtime.
 * Their assets, API, events and terminals share one origin, so the local
 * workspace never needs a wider connect-src policy or a privileged fetch proxy. */
export function workspaceOrigin(value) {
  if (typeof value !== "string" || !URL.canParse(value)) throw new Error("Enter an OpenScience server URL")
  const url = new URL(value)
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Use HTTPS, or an HTTP loopback address for an SSH tunnel")
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use the server origin without credentials, a path, query, or fragment")
  }
  return url.origin
}

export function workspaceNavigation(value, origin) {
  return URL.canParse(value) && new URL(value).origin === origin
}

export async function workspaceHealth(value) {
  const origin = workspaceOrigin(value)
  const response = await fetch(`${origin}/global/health`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: { Accept: "application/json" },
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`OpenScience health check returned HTTP ${response.status}`)
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel()
    throw new Error("This address did not return OpenScience health information")
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Empty OpenScience health response")
  const chunks = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 65536) throw new Error("OpenScience health response is too large")
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel()
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (data?.healthy !== true || typeof data.version !== "string" || !data.version) {
    throw new Error("The selected OpenScience runtime is not healthy")
  }
  return { origin, version: data.version }
}
