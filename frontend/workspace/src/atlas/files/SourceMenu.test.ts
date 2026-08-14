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
// Load Solid sequentially through Vite so the signal driving the refresh and
// the component renderer share one owner/runtime.
const core = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const subject = (await server.ssrLoadModule("/src/atlas/files/SourceMenu.tsx")) as typeof import("./SourceMenu")
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
  {
    id: "artifacts",
    group: "Results" as const,
    name: "Results",
    detail: "Durable, versioned deliverables",
    root: "",
    kind: "artifacts" as const,
  },
  {
    id: "project",
    group: "Working files" as const,
    name: "openscience-demoo",
    sub: "/home/keertan/codes/openscience-demoo",
    root: "/p",
    kind: "project" as const,
  },
  {
    id: "ro",
    group: "Working files" as const,
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
    expect(button?.querySelector(".files-source__glyph svg")).not.toBeNull()
    expect(host.querySelector("[data-source-menu]")).toBeNull()

    button?.click()

    expect(host.querySelector("[data-source-menu]")).not.toBeNull()
    expect([...host.querySelectorAll("[data-source-group]")].map((n) => n.textContent)).toEqual([
      "Results",
      "Working files",
    ])
  })

  test("reports the chosen source, closes, and restores focus", async () => {
    const picked: string[] = []
    const host = mount(() =>
      subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: (s) => picked.push(s.id) }),
    )
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    host.querySelector<HTMLButtonElement>('[data-source-item="ro"]')?.click()
    await Promise.resolve()

    expect(picked).toEqual(["ro"])
    expect(host.querySelector("[data-source-menu]")).toBeNull()
    expect(document.activeElement).toBe(host.querySelector("[data-source-button]"))
  })

  test("marks the active source and badges a read-only grant", () => {
    const host = mount(() => subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: () => {} }))
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()

    expect(host.querySelector('[data-source-item="project"]')?.getAttribute("aria-checked")).toBe("true")
    expect(host.querySelector('[data-source-item="ro"]')?.getAttribute("aria-checked")).toBe("false")
    expect(host.querySelector('[data-source-item="ro"]')?.textContent).toContain("Read only")
  })

  test("describes a writable grant consistently with sandboxed runtime access", () => {
    const writable = {
      ...SOURCES[2]!,
      id: "rw",
      name: "analysis-output",
      readonly: false,
    }
    const host = mount(() =>
      subject.SourceMenu({ sources: [...SOURCES, writable], active: writable, onPick: () => {} }),
    )
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()

    const item = host.querySelector<HTMLElement>('[data-source-item="rw"]')
    expect(item?.textContent).toContain("Read & write")
    expect(item?.querySelector(".files-menu__badge")?.getAttribute("title")).toContain("sandboxed runtimes")
  })

  test("explains saved artifacts without pretending they are a filesystem path", () => {
    const host = mount(() => subject.SourceMenu({ sources: SOURCES, active: SOURCES[0]!, onPick: () => {} }))
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()

    expect(host.querySelector('[data-source-item="artifacts"] .files-menu__context')?.textContent).toBe(
      "Durable, versioned deliverables",
    )
    expect(host.querySelector('[data-source-item="project"] .files-menu__sub')?.textContent).toContain(
      "/home/keertan/codes",
    )
  })

  test("offers revoke on a connected grant only, and revoking does not also pick it", async () => {
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
    await Promise.resolve()

    expect(revoked).toEqual(["ro"])
    expect(picked).toEqual([])
    expect(host.querySelector("[data-source-menu]")).toBeNull()
    expect(document.activeElement).toBe(host.querySelector("[data-source-button]"))
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
    // Each control is a real button with a distinct accessible name. The menu
    // owns one roving tab stop and Arrow-key traversal.
    expect(item.tagName).toBe("BUTTON")
    expect(revoke.tagName).toBe("BUTTON")
    expect(revoke.getAttribute("aria-label")).toBe("Revoke access to pdebench")
    expect(revoke.getAttribute("tabindex")).toBe("-1")
  })

  test("hides the revoke control when no handler can act on it", () => {
    const host = mount(() => subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: () => {} }))
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()

    expect(host.querySelector('[data-source-revoke="ro"]')).toBeNull()
  })

  test("constrains the menu and its paths so a long path cannot force a scrollbar", () => {
    const css = readFileSync(fileURLToPath(new URL("./FilesPane.css", import.meta.url)), "utf8")

    expect(css).toMatch(/\.files-menu\s*\{[^}]*overflow-x: hidden/s)
    expect(css).toMatch(/\.files-menu\s*\{[^}]*width: min\([^}]*100cqi/s)
    expect(css).toMatch(/\.files-browser\s*\{[^}]*overflow: visible/s)
    // A 1fr grid track will not shrink below its content without this.
    expect(css).toMatch(/\.files-menu__item\s*>\s*span:nth-child\(2\)\s*\{[^}]*min-width: 0/s)
  })

  test("moves focus into the menu and Escape returns it to the trigger", async () => {
    const host = mount(() => subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: () => {} }))
    const trigger = host.querySelector<HTMLButtonElement>("[data-source-button]")!

    trigger.click()
    await Promise.resolve()

    expect(document.activeElement).toBe(host.querySelector('[role="menuitemradio"]'))
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await Promise.resolve()

    expect(host.querySelector("[data-source-menu]")).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  test("keeps the menu open and restores semantic focus when an async source refresh replaces its rows", async () => {
    const [sources, setSources] = core.createSignal(SOURCES)
    const host = mount(() =>
      subject.SourceMenu({
        get sources() {
          return sources()
        },
        get active() {
          return sources()[0]!
        },
        onPick: () => {},
      }),
    )
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    await Promise.resolve()

    const focused = document.activeElement as HTMLElement
    expect(focused.getAttribute("data-source-item")).toBe("artifacts")

    // A filesystem snapshot refresh rebuilds PaneSource objects. Browsers
    // report the focused row's removal as focusout with no related target.
    focused.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }))
    setSources(SOURCES.map((source) => ({ ...source })))
    await Promise.resolve()

    expect(host.querySelector("[data-source-menu]")).not.toBeNull()
    expect(document.activeElement?.getAttribute("data-source-item")).toBe("artifacts")
  })

  test("uses roving arrow navigation and keeps the invisible scrim out of the tab order", async () => {
    const host = mount(() => subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: () => {} }))
    const trigger = host.querySelector<HTMLButtonElement>("[data-source-button]")!

    trigger.click()
    await Promise.resolve()
    const options = [...host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    const last = options.at(-1)!
    expect(document.activeElement).toBe(options[0])
    expect(host.querySelector(".files-menu__scrim")?.getAttribute("tabindex")).toBe("-1")
    expect(host.querySelector(".files-menu__scrim")?.getAttribute("aria-hidden")).toBe("true")

    options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    expect(document.activeElement).toBe(options[1])
    options[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
    expect(document.activeElement).toBe(last)
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
    expect(document.activeElement).toBe(options[0])

    options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }))
    await Promise.resolve()
    expect(host.querySelector("[data-source-menu]")).toBeNull()
    expect(document.activeElement).toBe(trigger)
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
    expect(host.querySelector(".files-source__caret svg")).not.toBeNull()
  })
})
