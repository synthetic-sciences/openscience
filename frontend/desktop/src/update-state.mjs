/** A supervised launch is not complete until this process proves its health.
 * A result left by an earlier update must not stop the workspace's polling. */
export function startupUpdateState(value, currentVersion, pendingVersion) {
  if (pendingVersion) return { phase: "restarting", version: pendingVersion }
  if (!value || (value.status !== "succeeded" && value.status !== "failed")) return
  if (!/^\d+\.\d+\.\d+$/.test(value.version ?? "")) return
  if (typeof value.completed_at !== "string" || !Number.isFinite(Date.parse(value.completed_at))) return
  if (value.status === "succeeded" && value.version !== currentVersion) return
  return {
    phase: value.status,
    version: value.version,
    completed_at: value.completed_at,
    error: value.status === "failed" && typeof value.error === "string" ? value.error.slice(0, 4_096) : undefined,
  }
}
