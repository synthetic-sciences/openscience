const SESSION_TIMEOUT_MS = 3_000

export async function fetchSetupSession(base: string, fetchFn: typeof fetch): Promise<boolean> {
  const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout?.(SESSION_TIMEOUT_MS)
  const response = await fetchFn(`${base.replace(/\/$/, "")}/account/session`, {
    headers: { accept: "application/json" },
    signal: timeout,
  })
  if (!response.ok) throw new Error(`Session check failed: ${response.status}`)
  const body = (await response.json()) as { session?: boolean }
  return body.session === true
}
