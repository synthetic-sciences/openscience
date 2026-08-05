import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [subject, solidjs, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/FilesPane.tsx") as Promise<typeof import("./FilesPane")>,
  server.ssrLoadModule("solid-js") as Promise<typeof import("solid-js")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

const listing = (rows: unknown[]) =>
  new Response(JSON.stringify({ data: rows }), { status: 200, headers: { "Content-Type": "application/json" } })

describe("files pane", () => {
  test("renders the tab strip, the picker and a table", async () => {
    const host = mount(() =>
      subject.FilesPane({
        request: async () => listing([{ name: "train_lr.py", type: "file", size: 2534 }]),
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(host.querySelector('[data-tab="files"]')).not.toBeNull()
    expect(host.querySelector("[data-source-button]")).not.toBeNull()
    expect(host.querySelector(".files-table")).not.toBeNull()
  })

  test("a failed listing degrades in place instead of throwing to the boundary", async () => {
    // The pane must not reach the app-wide ErrorBoundary. Mount it inside a real
    // one and assert the fallback never renders — reading an errored resource
    // during render is what would trip it.
    const host = mount(() =>
      web.createComponent(solidjs.ErrorBoundary, {
        fallback: () => {
          const marker = document.createElement("p")
          marker.dataset.boundary = "caught"
          return marker
        },
        get children() {
          return subject.FilesPane({ request: async () => new Response("nope", { status: 503 }) })
        },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(host.querySelector("[data-boundary]")).toBeNull()
    expect(host.textContent).toContain("could not be read")
    expect(host.querySelector(".files-table")).not.toBeNull()
  })
})
