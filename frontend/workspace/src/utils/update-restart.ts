export type UpdateHealth = {
  healthy: true
  version: string
  runId: string
}

export async function waitForUpdatedServer(input: {
  check: () => Promise<UpdateHealth | undefined>
  previous?: string
  version?: string
  attempts?: number
  delayMs?: number
  sleep?: (delay: number) => Promise<void>
}): Promise<UpdateHealth> {
  const attempts = input.attempts ?? 120
  const sleep =
    input.sleep ??
    ((delay: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delay)
      }))

  const poll = async (attempt: number): Promise<UpdateHealth> => {
    const health = await input.check().catch(() => undefined)
    const changed = !input.previous || health?.runId !== input.previous
    const current = !input.version || health?.version === input.version
    if (health?.healthy && changed && current) return health
    if (attempt >= attempts - 1) {
      throw new Error("The update installed, but OpenScience did not restart in time.")
    }
    await sleep(input.delayMs ?? 250)
    return poll(attempt + 1)
  }

  return poll(0)
}
