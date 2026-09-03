import { expect, test } from "bun:test"
import { invalidateCredentials, loadCredentials } from "./credential-loader"

test("credential panels share one read and refetch only after a write invalidates it", async () => {
  const url = "http://credential-loader-test"
  let finish!: (response: Response) => void
  let calls = 0
  const fetcher = (async () => {
    calls++
    if (calls === 1)
      return new Promise<Response>((resolve) => {
        finish = resolve
      })
    return Response.json({ services: [{ id: "github", connected: true }] })
  }) as unknown as typeof fetch

  const first = loadCredentials(url, fetcher)
  const second = loadCredentials(url, fetcher)
  finish(Response.json({ services: [] }))
  expect((await first).services).toEqual([])
  expect(await second).toBe(await first)
  expect(await loadCredentials(url, fetcher)).toBe(await first)
  expect(calls).toBe(1)

  invalidateCredentials(url)
  expect((await loadCredentials(url, fetcher)).services).toHaveLength(1)
  expect(calls).toBe(2)

  await loadCredentials(url, fetcher, true)
  expect(calls).toBe(3)
})
