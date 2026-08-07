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
  {
    id: "project",
    group: "This computer" as const,
    name: "openscience-demoo",
    sub: "/home/keertan/codes/openscience-demoo",
    root: "/p",
    kind: "project" as const,
  },
  {
    id: "ro",
    group: "This computer" as const,
    name: "pdebench",
    sub: "/home/keertan/data/pdebench",
    root: "/d",
    kind: "connected" as const,
    readonly: true,
  },
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

  test("offers revoke on a connected grant only, and revoking does not also pick it", () => {
    const picked: string[] = []
    const revoked: string[] = []
    const host = mount(() =>
      subject.SourceMenu({
        sources: SOURCES,
        active: SOURCES[1]!,
        onPick: (s) => picked.push(s.id),
        onRevoke: (s) => revoked.push(s.id),
      }),
    )
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()

    expect(host.querySelector('[data-source-revoke="project"]')).toBeNull()
    expect(host.querySelector('[data-source-revoke="artifacts"]')).toBeNull()

    host.querySelector<HTMLElement>('[data-source-revoke="ro"]')?.click()

    expect(revoked).toEqual(["ro"])
    expect(picked).toEqual([])
    expect(host.querySelector("[data-source-menu]")).toBeNull()
  })

  test("keeps revoke a sibling of the source it revokes, not a control inside it", () => {
    // Nested interactive content is invalid, and a nested label folds into the
    // parent's accessible name: a screen reader would announce the whole row as
    // "pdebench … Revoke access to pdebench", one control with two purposes.
    const host = mount(() =>
      subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: () => {}, onRevoke: () => {} }),
    )
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()

    const item = host.querySelector<HTMLElement>('[data-source-item="ro"]')!
    const revoke = host.querySelector<HTMLElement>('[data-source-revoke="ro"]')!

    expect(item.contains(revoke)).toBe(false)
    expect(item.querySelector("button, [role='button']")).toBeNull()
    expect(item.textContent).not.toContain("Revoke")
    // Each control is a real button, so each is keyboard reachable and carries
    // its own accessible name with no tabindex or key handler of its own.
    expect(item.tagName).toBe("BUTTON")
    expect(revoke.tagName).toBe("BUTTON")
    expect(revoke.getAttribute("aria-label")).toBe("Revoke access to pdebench")
    expect(revoke.getAttribute("tabindex")).toBeNull()
  })

  test("hides the revoke control when no handler can act on it", () => {
    const host = mount(() => subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: () => {} }))
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()

    expect(host.querySelector('[data-source-revoke="ro"]')).toBeNull()
  })

  test("constrains the menu and its paths so a long path cannot force a scrollbar", () => {
    const css = readFileSync(fileURLToPath(new URL("./FilesPane.css", import.meta.url)), "utf8")

    expect(css).toMatch(/\.files-menu\s*\{[^}]*overflow-x: hidden/s)
    expect(css).toMatch(/\.files-menu\s*\{[^}]*width: min\(/s)
    // A 1fr grid track will not shrink below its content without this.
    expect(css).toMatch(/\.files-menu__item\s*>\s*span:nth-child\(2\)\s*\{[^}]*min-width: 0/s)
  })

  // The kinds were text glyphs (a square for anything with a root), so a
  // connected folder, the project and a cloud provider all drew identically.
  test("renders an icon per source kind rather than one square for all of them", () => {
    const host = mount(() =>
      subject.SourceMenu({
        sources: SOURCES,
        active: SOURCES[0]!,
        onPick: () => {},
        onAdd: () => {},
      }),
    )
    host.querySelector<HTMLButtonElement>("[data-source-button]")!.click()

    const glyphs = [...host.querySelectorAll(".files-menu__glyph svg")]

    expect(glyphs.length).toBe(host.querySelectorAll("[data-source-item]").length + 1)
    expect(host.querySelector(".files-menu__glyph")?.textContent?.trim()).toBe("")
  })
})
