/**
 * New Atlas workspace credentials use `osk_`, including Personal. Existing
 * `thk_` credentials remain valid as legacy Personal credentials. Reserved
 * integration sentinels use `thk-` (for example the Codex OAuth availability
 * marker). None of these forms is a user-owned provider API key, and none may
 * be sent to a public model-provider endpoint.
 */
export function isAtlasManagedKey(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith("thk_") || value.startsWith("osk_") || value.startsWith("thk-"))
}

export function isWorkspaceKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("osk_")
}
