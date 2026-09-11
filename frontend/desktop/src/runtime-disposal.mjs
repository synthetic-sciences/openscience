/** Wait for the runtime's durable shutdown acknowledgement before the desktop
 * signals it. Project disposal can outlast a single process reaper's timeout. */
export async function disposeRuntime(address, token, options = {}) {
  const response = await fetch(`${address}/settings/updates/dispose`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 35_000),
  })
  if (response.status === 204) return
  const failure = await response.json().catch(() => undefined)
  throw new Error(
    typeof failure?.error === "string" ? failure.error : `Runtime disposal failed (HTTP ${response.status})`,
  )
}
