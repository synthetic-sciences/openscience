/**
 * Atlas-owned credentials use the canonical `thk_` prefix. Reserved
 * integration sentinels use `thk-` (for example the Codex OAuth availability
 * marker). Neither form is a user-owned provider API key, and neither may be
 * sent to a public model-provider endpoint.
 */
export function isAtlasManagedKey(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith("thk_") || value.startsWith("thk-"))
}
