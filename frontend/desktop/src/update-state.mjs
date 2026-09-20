/** A supervised launch is not complete until this process proves its health.
 * A result left by an earlier update must not stop the workspace's polling. */
export function startupUpdateState(value, currentVersion, pendingVersion) {
  if (pendingVersion) return { phase: "restarting", version: pendingVersion }
  if (!value || (value.status !== "succeeded" && value.status !== "failed")) return
  if (!/^\d+\.\d+\.\d+$/.test(value.version ?? "")) return
  if (typeof value.completed_at !== "string" || !Number.isFinite(Date.parse(value.completed_at))) return
  if (value.status === "succeeded" && value.version !== currentVersion) return
  // "Updated to X" belongs to the launch that proved the update healthy: that
  // launch publishes the result from memory and the installer stamps the
  // receipt it leaves behind, so no later launch replays it. `health` is the
  // same evidence from an installer written before that stamp existed — it is
  // recorded only once a live launch has reported itself healthy.
  if (value.status === "succeeded" && (value.acknowledged_at || value.health)) return
  return {
    phase: value.status,
    version: value.version,
    completed_at: value.completed_at,
    error: value.status === "failed" && typeof value.error === "string" ? value.error.slice(0, 4_096) : undefined,
  }
}

/** The stored result to write back once `state` has been served at launch, or
 * undefined when the stored result must stay exactly as it is. A failed result
 * keeps its once-per-launch behaviour until the next update attempt replaces it. */
export function acknowledgedStartupResult(value, state) {
  if (!value || state?.phase !== "succeeded" || value.acknowledged_at) return
  return { ...value, acknowledged_at: new Date().toISOString() }
}
