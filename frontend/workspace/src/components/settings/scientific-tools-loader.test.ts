import { expect, test } from "bun:test"
import { invalidateScientificTools, loadScientificTools } from "./scientific-tools-loader"

test("credential changes invalidate cached and in-flight science status", async () => {
  const url = "http://science-loader-test"
  let finish!: (response: Response) => void
  let calls = 0
  const fetcher = (async () => {
    calls++
    if (calls === 1)
      return new Promise<Response>((resolve) => {
        finish = resolve
      })
    return Response.json({ capabilities: [], revision: "connected" })
  }) as unknown as typeof fetch
  const old = loadScientificTools(url, fetcher)
  invalidateScientificTools(url)
  const fresh = await loadScientificTools(url, fetcher)
  finish(Response.json({ capabilities: [], revision: "setup_needed" }))
  await old
  expect(await loadScientificTools(url, fetcher)).toBe(fresh)
  expect(calls).toBe(2)
  invalidateScientificTools(url)
  await loadScientificTools(url, fetcher)
  expect(calls).toBe(3)
})
