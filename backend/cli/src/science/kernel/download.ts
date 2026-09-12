import { Log } from "@/util/log"

const log = Log.create({ service: "science.environment.download" })

export async function download(url: string, timeout: number): Promise<ArrayBuffer> {
  const source = new URL(url)
  const label = `${source.origin}${source.pathname}`
  const deadline = Date.now() + timeout
  for (let attempt = 1; ; attempt++) {
    const delay = 250 * 2 ** (attempt - 1)
    const result = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    })
      .then(async (response) => {
        if (response.ok) return { ok: true as const, bytes: await response.arrayBuffer() }
        await response.body?.cancel().catch(() => undefined)
        const after = response.headers.get("retry-after")
        const seconds = after === null ? Number.NaN : Number(after)
        const wait = after === null ? 0 : Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(after) - Date.now()
        return {
          ok: false as const,
          error: new Error(`HTTP ${response.status}`),
          retry: response.status === 408 || response.status === 429 || response.status >= 500,
          delay: Number.isFinite(wait) ? Math.max(delay, wait) : delay,
        }
      })
      .catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error : new Error(String(error)),
        retry: true,
        delay,
      }))
    if (result.ok) return result.bytes
    const reason = result.error.message.replaceAll(url, label)
    if (!result.retry || attempt === 3 || Date.now() + result.delay >= deadline) {
      throw new Error(`Download ${label} failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${reason}`)
    }
    log.warn("retrying archive download", { source: label, attempt, error: reason })
    await Bun.sleep(result.delay)
  }
}
