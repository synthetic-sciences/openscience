import { expect, test } from "bun:test"
import { DataRootBarrier } from "../../src/global/data-root-barrier"
import { Server } from "../../src/server/server"

const request = async (path: string) =>
  Server.App().fetch(new Request(`http://127.0.0.1${path}`, { headers: { host: "127.0.0.1" } }))

const settled = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)])

// The health route reads nothing from the data root, so a data-root switch
// (or a slow per-request marker write on Windows) must never delay it: the
// workspace counts a slow health answer as a failed check (#1042).
test("health answers while a data-root switch holds every other request", async () => {
  const lease = await DataRootBarrier.exclusive()
  try {
    const health = request("/global/health")
    expect(await settled(health, 2_000)).toBe(true)
    const response = await health
    expect(response.status).toBe(200)
    expect(((await response.json()) as { healthy: boolean }).healthy).toBe(true)

    const other = request("/global/config")
    expect(await settled(other, 300)).toBe(false)
  } finally {
    await lease[Symbol.asyncDispose]()
  }
})
