import { afterAll, afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web", "solid-js/store"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const core = (await vite.ssrLoadModule("solid-js")) as typeof import("solid-js")
const web = (await vite.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await vite.ssrLoadModule("/src/atlas/use-stable-list.ts")) as typeof import("./use-stable-list")
const cleanups: Array<() => void> = []

afterAll(() => vite.close())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

test("keeps an opened activity disclosure mounted while fresh poll objects patch its text", async () => {
  const [source, setSource] = core.createSignal([{ id: "run-1", label: "First result" }])
  const host = mount(() => {
    const items = subject.useStableList(source)
    return core.For({
      get each() {
        return items
      },
      children: (item: { id: string; label: string }) => {
        const details = document.createElement("details")
        const summary = document.createElement("summary")
        details.dataset.id = item.id
        details.append(summary)
        core.createEffect(() => (summary.textContent = item.label))
        return details
      },
    })
  })
  await Promise.resolve()

  const row = host.querySelector<HTMLDetailsElement>('[data-id="run-1"]')!
  row.open = true
  setSource([{ id: "run-1", label: "Updated result" }])
  await Promise.resolve()

  expect(host.querySelector('[data-id="run-1"]')).toBe(row)
  expect(row.open).toBe(true)
  expect(row.textContent).toContain("Updated result")
})
