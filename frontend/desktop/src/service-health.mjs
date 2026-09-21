/** The version the sidecar must report before startup counts as healthy, or
 * undefined when any version will do.
 *
 * A packaged shell ships with exactly one runtime, and a supervised update is
 * proved by relaunching into it, so both pin the shell's own version. A shell
 * run from source, or pointed at a sidecar through OPENSCIENCE_DESKTOP_SIDECAR,
 * was handed a runtime built separately: a from-source build reports its build
 * stamp (`0.0.0-main-<timestamp>`), which can never equal the shell's package
 * version. */
export function pinnedVersion(shell) {
  if (shell.supervised) return shell.version
  if (!shell.packaged || shell.sidecar) return
  return shell.version
}

/** Whether a `/global/health` body proves a live runtime, at `version` when one
 * is pinned. */
export function healthyRuntime(health, version) {
  if (health?.healthy !== true) return false
  if (typeof health.runId !== "string" || !health.runId) return false
  return version === undefined || health.version === version
}
