import { expect, test } from "bun:test"
import { disposeRuntime } from "../../../../frontend/desktop/src/runtime-disposal.mjs"

test("desktop waits for slow project disposal before accepting the shutdown acknowledgement", async () => {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      expect(request.headers.get("authorization")).toBe("Bearer fixture-token")
      await Bun.sleep(5_100)
      return new Response(null, { status: 204 })
    },
  })
  try {
    await disposeRuntime(server.url.origin, "fixture-token")
    expect(requests).toEqual(["POST /settings/updates/dispose"])
  } finally {
    await server.stop(true)
  }
}, 15_000)

test("desktop preserves the runtime's disposal error and can retry the same handoff", async () => {
  const state = { failed: true }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return state.failed
        ? Response.json({ error: "The kernel process is still stopping" }, { status: 503 })
        : new Response(null, { status: 204 })
    },
  })
  try {
    await expect(disposeRuntime(server.url.origin, "fixture-token")).rejects.toThrow("kernel process is still stopping")
    state.failed = false
    await disposeRuntime(server.url.origin, "fixture-token")
  } finally {
    await server.stop(true)
  }
})

test("desktop bounds a disposal request that never acknowledges shutdown", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  })
  try {
    await expect(disposeRuntime(server.url.origin, "fixture-token", { timeoutMs: 20 })).rejects.toThrow()
  } finally {
    await server.stop(true)
  }
})
