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

test("live shell commands share the compact activity ledger", () => {
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
      stopping: false,
      onStop: () => undefined,
    }),
  )

  expect(host.querySelector(".kernel-card__copy")?.textContent).toContain("Preparing Titanic dataset")
  expect(host.querySelector(".activity-card__kind")?.textContent).toBe("Shell")
  expect(host.querySelector(".activity-card__status")?.textContent).toBe("Running")
  expect(host.querySelectorAll<HTMLDetailsElement>("details").length).toBe(2)
  expect(Array.from(host.querySelectorAll<HTMLDetailsElement>("details")).every((item) => !item.open)).toBe(true)
  expect(host.querySelector("code")?.textContent).toBe("python prepare.py")
  expect(host.textContent).toContain("12 MB")
  expect(host.textContent).toContain("0.8 cores")
  expect(host.textContent).toContain("42")
  expect(host.querySelector('button[aria-label="Stop Preparing Titanic dataset"]')).not.toBeNull()
})
