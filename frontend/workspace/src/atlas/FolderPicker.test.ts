import { afterAll, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createTestServer as createServer } from "../../test/vite"
import solid from "vite-plugin-solid"

const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const reactive = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const subject = (await server.ssrLoadModule("/src/atlas/FolderPicker.tsx")) as typeof import("./FolderPicker")

afterAll(() => server.close())

test("a delayed validation cannot replace newer navigation", async () => {
  const owner = reactive.createRoot((dispose) => {
    const requests = subject.createRequestGeneration()
    return { requests, dispose }
  })

  let resolve!: (path: string) => void
  const validation = new Promise<string>((accept) => {
    resolve = accept
  })
  let current = "/initial"
  const older = owner.requests.next()
  const pending = validation.then((path) => {
    if (owner.requests.isCurrent(older)) current = path
  })

  current = "/newer"
  owner.requests.invalidate()
  resolve("/stale")
  await pending
  expect(current).toBe("/newer")

  const disposed = owner.requests.next()
  owner.dispose()
  expect(owner.requests.isCurrent(disposed)).toBe(false)
})
