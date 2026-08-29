/**
 * Atlas-owned Personal credentials use the canonical `thk_` prefix, while
 * immutable organization-workspace credentials use `osk_`. The distinct
 * organization prefix is a rollback boundary: an older gateway that only
 * understands `thk_` cannot accept an organization request as Personal.
 * Reserved
 * integration sentinels use `thk-` (for example the Codex OAuth availability
 * marker). Neither form is a user-owned provider API key, and neither may be
 * sent to a public model-provider endpoint.
 */
export function isAtlasManagedKey(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith("thk_") || value.startsWith("osk_") || value.startsWith("thk-"))
}

export function isOrganizationWorkspaceKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("osk_")
}
