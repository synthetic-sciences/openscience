import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createOpenScienceClient } from "@synsci/sdk/v2/client"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const Response = (await Bun.fetch("data:text/plain,")).constructor as typeof globalThis.Response
const cleanups: Array<() => void> = []
const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const subject = (await vite.ssrLoadModule("/src/components/working-folder.tsx")) as typeof import("./working-folder")
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
afterAll(() => vite.close())
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await Bun.sleep(10)
  expect(check()).toBe(true)
}

test("a failed folder save remains visible and retry updates the actual working location", async () => {
  const state = { fail: true, current: "/research/RINR", writes: 0 }
  const snapshot = () => ({
    workspace: { scratchRoot: "/scratch" },
    toolDirectory: state.current,
    grants: [{ source: "api", scope: "project", access: "write", path: "/research/RINR", time: { created: 1 } }],
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET") return Response.json(snapshot())
      state.writes++
      if (state.fail) return Response.json({ error: "save failed" }, { status: 503 })
      expect(await request.json()).toEqual({ workingRoot: "scratch" })
      state.current = "/scratch"
      return Response.json(snapshot())
    },
  })
  cleanups.push(() => void server.stop(true))
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(
    web.render(
      () =>
        subject.WorkingFolderChip({
          client: createOpenScienceClient({ baseUrl: server.url.origin, fetch: Bun.fetch }),
          sessionID: "ses_fixture",
          pending: undefined,
          onPending() {},
        }),
      host,
    ),
  )
  await until(() => host.querySelector("summary")?.textContent?.includes("RINR") ?? false)
  const details = host.querySelector("details")!
  details.open = true
  const scratch = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Scratch"))!
  scratch.click()
  await until(() => host.querySelector('[role="alert"]') !== null)
  expect(details.open).toBe(true)
  expect(host.querySelector("summary")?.textContent).toContain("RINR")
  expect(state.current).toBe("/research/RINR")

  state.fail = false
  scratch.click()
  await until(() => host.querySelector("summary")?.textContent?.includes("Scratch") ?? false)
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(details.open).toBe(false)
  expect(state.writes).toBe(2)
})
