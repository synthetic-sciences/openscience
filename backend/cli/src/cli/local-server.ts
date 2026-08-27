import { base64Encode } from "@synsci/util/encode"

export const DEFAULT_LOCAL_PORT = 4096
export const FALLBACK_LOCAL_PORT = 4097
export const LOCAL_WORKSPACE_PORTS = [DEFAULT_LOCAL_PORT, FALLBACK_LOCAL_PORT] as const

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

/**
 * A healthy API listener is not necessarily a browser workspace. Source/eval
 * servers deliberately expose `/global/health` without bundled web assets, and
 * an older packaged server can survive an upgrade. The launcher must only
 * reuse a server that proves it owns a matching workspace bundle.
 */
export async function probeWorkspaceServer(base: string, version: string, timeout = 1200) {
  const healthy = await probeLocalServer(base, timeout)
  if (!healthy) return false
  return fetch(`${base}/version.json`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeout),
  })
    .then(async (response) => {
      if (!response.ok) return false
      const body = await response.json().catch(() => undefined)
      if (!body || typeof body !== "object" || Array.isArray(body)) return false
      return "version" in body && body.version === version && "channel" in body && typeof body.channel === "string"
    })
    .catch(() => false)
}

export async function findWorkspaceServer(version: string, ports: readonly number[] = LOCAL_WORKSPACE_PORTS) {
  const matches = await Promise.all(
    ports.map(async (port) => ({ port, match: await probeWorkspaceServer(localServerBase(port), version) })),
  )
  return matches.find((candidate) => candidate.match)?.port
}
