const API_ROOTS = new Set([
  "api",
  "agent",
  "auth",
  "command",
  "config",
  "event",
  "experimental",
  "file",
  "find",
  "global",
  "instance",
  "kernels",
  "log",
  "mcp",
  "notebook",
  "path",
  "permission",
  "project",
  "provider",
  "provenance",
  "pty",
  "question",
  "runtime",
  "search",
  "session",
  "settings",
  "skill",
  "vcs",
])

/** True for local API surfaces that may read data or start work. Static SPA
 * navigation and the small authentication/recovery surface remain reachable. */
export function requiresAccountForRequest(input: {
  method: string
  path: string
  accept?: string
  upgrade?: string
}): boolean {
  const method = input.method.toUpperCase()
  const updateRecovery =
    (method === "GET" &&
      ["/settings/updates", "/settings/updates/", "/settings/updates/state", "/settings/updates/releases"].includes(
        input.path,
      )) ||
    (method === "POST" &&
      ["/settings/updates/stage", "/settings/updates/apply", "/settings/updates/dispose"].includes(input.path)) ||
    (method === "DELETE" && input.path === "/settings/updates/stage")
  if (method === "OPTIONS" || method === "HEAD") return false
  if (input.path === "/global/health" || input.path === "/doc" || updateRecovery || input.path.startsWith("/account"))
    return false
  const root = input.path.split("/").filter(Boolean)[0]
  if (root && API_ROOTS.has(root)) return true
  if (method === "GET" && input.accept?.includes("text/html") && !input.upgrade) return false
  return method !== "GET"
}

export const accountRequiredResponse = {
  error: "A Synthetic Sciences account is required.",
  code: "openscience_account_required",
} as const
