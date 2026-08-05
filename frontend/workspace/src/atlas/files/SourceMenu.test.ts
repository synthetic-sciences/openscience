import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const server = await createServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/files/SourceMenu.tsx") as Promise<typeof import("./SourceMenu")>,
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

const SOURCES = [
  { id: "artifacts", group: "Artifacts" as const, name: "All artifacts", root: "", kind: "artifacts" as const },
  { id: "project", group: "This computer" as const, name: "openscience-demoo", sub: "/home/keertan/codes/openscience-demoo", root: "/p", kind: "project" as const },
  { id: "ro", group: "This computer" as const, name: "pdebench", sub: "/home/keertan/data/pdebench", root: "/d", kind: "connected" as const, readonly: true },
]

describe("source menu", () => {
  test("shows the active source and opens a grouped menu", () => {
    const host = mount(() => subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: () => {} }))
    const button = host.querySelector<HTMLButtonElement>("[data-source-button]")

    expect(button?.textContent).toContain("openscience-demoo")
    expect(host.querySelector("[data-source-menu]")).toBeNull()

    button?.click()

    expect(host.querySelector("[data-source-menu]")).not.toBeNull()
    expect([...host.querySelectorAll("[data-source-group]")].map((n) => n.textContent)).toEqual([
      "Artifacts",
      "This computer",
    ])
  })

  test("reports the chosen source and closes", () => {
    const picked: string[] = []
    const host = mount(() =>
      subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: (s) => picked.push(s.id) }),
    )
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>('[data-source-item="ro"]')?.click()

    expect(picked).toEqual(["ro"])
    expect(host.querySelector("[data-source-menu]")).toBeNull()
  })

  test("marks the active source and badges a read-only grant", () => {
    const host = mount(() => subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: () => {} }))
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()

    expect(host.querySelector('[data-source-item="project"]')?.getAttribute("aria-checked")).toBe("true")
    expect(host.querySelector('[data-source-item="ro"]')?.getAttribute("aria-checked")).toBe("false")
    expect(host.querySelector('[data-source-item="ro"]')?.textContent).toContain("ro")
  })

  test("constrains the menu and its paths so a long path cannot force a scrollbar", () => {
    const css = readFileSync(fileURLToPath(new URL("./FilesPane.css", import.meta.url)), "utf8")

    expect(css).toMatch(/\.files-menu\s*\{[^}]*overflow-x: hidden/s)
    expect(css).toMatch(/\.files-menu\s*\{[^}]*width: min\(/s)
    // A 1fr grid track will not shrink below its content without this.
    expect(css).toMatch(/\.files-menu__item\s*>\s*span:nth-child\(2\)\s*\{[^}]*min-width: 0/s)
  })
})
