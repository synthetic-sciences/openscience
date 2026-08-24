import { afterAll, afterEach, expect, test } from "bun:test"
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
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/CommandCard.tsx") as Promise<typeof import("./CommandCard")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []

afterAll(() => server.close())
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

test("live shell commands use the same passive tracker grammar", () => {
  const host = mount(() =>
    subject.CommandCard({
      command: {
        id: "command-test",
        projectID: "project",
        sessionID: "session",
        messageID: "message",
        description: "Preparing Titanic dataset",
        command: "python prepare.py",
        state: "running",
        process_id: 42,
        started_at: Date.now() - 5_000,
        resources: { memory_bytes: 12_000_000, cpu_percent: 75 },
      },
    }),
  )

  expect(host.querySelector(".compute-row__copy")?.textContent).toContain("Preparing Titanic dataset")
  expect(host.querySelector('.compute-row__kind [data-icon="console"]')).not.toBeNull()
  expect(host.querySelector(".compute-row__copy")?.textContent).toContain("Running · 5s")
  expect(host.querySelector('[data-metric="memory"]')?.textContent).toContain("12 MB RSS")
  expect(host.querySelector('[data-metric="cpu"]')?.textContent).toContain("0.8 cores")
  expect(host.textContent).not.toContain("python prepare.py")
  expect(host.textContent).not.toContain("42")
  expect(host.querySelector("button, details, summary, pre, code")).toBeNull()
})
