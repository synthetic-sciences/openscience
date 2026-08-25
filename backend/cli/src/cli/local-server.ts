import { base64Encode } from "@synsci/util/encode"

export const DEFAULT_LOCAL_PORT = 4096

export function localServerBase(port = DEFAULT_LOCAL_PORT) {
  return `http://localhost:${port}`
}

export function localWorkspaceUrl(base: string, directory?: string) {
  if (!directory) return base
  return `${base}/${base64Encode(directory)}/session`
}

export function probeLocalServer(base: string, timeout = 1200) {
  return fetch(`${base}/global/health`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeout),
  })
    .then(async (response) => {
      if (!response.ok) return false
      const body = await response.json().catch(() => undefined)
      if (!body || typeof body !== "object" || Array.isArray(body)) return false
      return "healthy" in body && body.healthy === true && "version" in body && typeof body.version === "string"
    })
    .catch(() => false)
}
