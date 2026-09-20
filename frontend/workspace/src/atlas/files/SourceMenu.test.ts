import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createTestServer as createServer } from "../../../test/vite"
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

/**
 * happy-dom lays nothing out, so the geometry the menu measures is supplied
 * here: a selector per box, and the window width the pane sits in.
 */
type Boxes = Array<{ match: string; left: number; right: number }>
const layout = (boxes: Boxes, viewport: number) => {
  const current = { boxes }
  const rect = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")!
  const width = Object.getOwnPropertyDescriptor(globalThis, "innerWidth")
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const box = current.boxes.find((candidate) => this.matches(candidate.match)) ?? { left: 0, right: 0 }
    const size = { ...box, width: box.right - box.left, height: 0, top: 0, bottom: 0, x: box.left, y: 0 }
    return { ...size, toJSON: () => size } as DOMRect
  }
  Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: viewport })
  cleanups.push(() => {
    Object.defineProperty(Element.prototype, "getBoundingClientRect", rect)
    if (width) Object.defineProperty(globalThis, "innerWidth", width)
  })
  /** The same boxes after the pane was dragged to another width. */
  return (next: Boxes) => (current.boxes = next)
}

/**
 * happy-dom has a ResizeObserver, but nothing it could observe: no layout
 * engine means no box ever changes size. This one records what the menu asked
 * to watch and hands back the trigger for it.
 */
const observeResizes = () => {
  const watched: Array<{ target: Element; resize: () => void }> = []
  const original = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver")
  class Recorder {
    constructor(private readonly callback: () => void) {}
    observe(target: Element) {
      watched.push({ target, resize: () => this.callback() })
    }
    disconnect() {
      watched.length = 0
    }
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: Recorder as unknown as typeof ResizeObserver,
  })
  cleanups.push(() => {
    if (original) Object.defineProperty(globalThis, "ResizeObserver", original)
  })
  return watched
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
      "Working files",
      "Results",
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

  // A delegated conversation works in the folder its lead granted it. The row
  // is there to browse from; ending that access is the lead's decision.
  test("offers no revoke on a folder inherited from the session that delegated this one", () => {
    const lead = { ...SOURCES[2]!, id: "lead", name: "RINR", readonly: false, inherited: true }
    const host = mount(() =>
      subject.SourceMenu({
        sources: [...SOURCES, lead],
        active: SOURCES[1]!,
        onPick: () => {},
        onRevoke: () => {},
      }),
    )
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()

    expect(host.querySelector('[data-source-item="lead"]')).not.toBeNull()
    expect(host.querySelector('[data-source-revoke="lead"]')).toBeNull()
    expect(host.querySelector('[data-source-revoke="ro"]')).not.toBeNull()
  })

  test("hides the revoke control when no handler can act on it", () => {
    const host = mount(() => subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: () => {} }))
    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()

    expect(host.querySelector('[data-source-revoke="ro"]')).toBeNull()
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
    expect(focused.getAttribute("data-source-item")).toBe("project")

    // A filesystem snapshot refresh rebuilds PaneSource objects. Browsers
    // report the focused row's removal as focusout with no related target.
    focused.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }))
    setSources(SOURCES.map((source) => ({ ...source })))
    await Promise.resolve()

    expect(host.querySelector("[data-source-menu]")).not.toBeNull()
    expect(document.activeElement?.getAttribute("data-source-item")).toBe("project")
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

  // #646: the trigger sits at the right end of the toolbar, so a menu hung
  // from its left edge ran 93px past the window at 1440x900 and truncated
  // every path and badge.
  test("hangs the menu from the trigger's right edge when the left edge would put it outside the pane", async () => {
    const host = mount(() => subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: () => {} }))
    host.className = "files-pane"
    layout(
      [
        { match: ".files-pane", left: 900, right: 1440 },
        { match: ".files-source__button", left: 1180, right: 1268 },
        { match: ".files-menu", left: 1180, right: 1480 },
      ],
      1440,
    )

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    await Promise.resolve()

    expect(host.querySelector("[data-source-menu]")?.getAttribute("data-align")).toBe("end")
  })

  // The pane is a draggable column. The alignment was measured once per open,
  // so narrowing the pane under an open menu left it hanging outside until the
  // next time someone opened it.
  test("re-measures the alignment when the pane is resized under an open menu", async () => {
    const watched = observeResizes()
    const host = mount(() => subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: () => {} }))
    host.className = "files-pane"
    const resize = layout(
      [
        { match: ".files-pane", left: 0, right: 1440 },
        { match: ".files-source__button", left: 240, right: 328 },
        { match: ".files-menu", left: 240, right: 540 },
      ],
      1440,
    )

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    await Promise.resolve()
    expect(host.querySelector("[data-source-menu]")?.getAttribute("data-align")).toBe("start")

    // The divider is dragged left: the pane keeps the menu's trigger near its
    // right edge, and the menu no longer fits hanging rightwards.
    resize([
      { match: ".files-pane", left: 900, right: 1440 },
      { match: ".files-source__button", left: 1180, right: 1268 },
      { match: ".files-menu", left: 1180, right: 1480 },
    ])
    expect(watched.map((entry) => entry.target)).toEqual([host])
    watched.forEach((entry) => entry.resize())
    await Promise.resolve()

    expect(host.querySelector("[data-source-menu]")?.getAttribute("data-align")).toBe("end")
  })

  test("watches nothing once the menu is closed", async () => {
    const watched = observeResizes()
    const host = mount(() => subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: () => {} }))
    host.className = "files-pane"

    const trigger = host.querySelector<HTMLButtonElement>("[data-source-button]")!
    trigger.click()
    await Promise.resolve()
    expect(watched).toHaveLength(1)

    trigger.click()
    await Promise.resolve()

    expect(watched).toHaveLength(0)
  })

  test("keeps the menu on the trigger's left edge when it already fits", async () => {
    const host = mount(() => subject.SourceMenu({ sources: SOURCES, active: SOURCES[1]!, onPick: () => {} }))
    host.className = "files-pane"
    layout(
      [
        { match: ".files-pane", left: 0, right: 1440 },
        { match: ".files-source__button", left: 240, right: 328 },
        { match: ".files-menu", left: 240, right: 540 },
      ],
      1440,
    )

    host.querySelector<HTMLButtonElement>("[data-source-button]")?.click()
    await Promise.resolve()

    expect(host.querySelector("[data-source-menu]")?.getAttribute("data-align")).toBe("start")
  })

  // The pane is a column of a much wider window: fitting inside the viewport
  // is not the same as fitting inside the pane, and the second is what the
  // reader sees.
  test("measures the pane, not the window", () => {
    const menu = { width: 300, trigger: { left: 1000, right: 1088 } }

    expect(subject.menuAlignment({ ...menu, bounds: { left: 0, right: 1440 } })).toBe("start")
    expect(subject.menuAlignment({ ...menu, bounds: { left: 760, right: 1100 } })).toBe("end")
  })

  test("keeps the alignment that leaves less of the menu outside a container narrower than it", () => {
    expect(
      subject.menuAlignment({ width: 300, trigger: { left: 20, right: 108 }, bounds: { left: 0, right: 260 } }),
    ).toBe("start")
    expect(
      subject.menuAlignment({ width: 300, trigger: { left: 160, right: 248 }, bounds: { left: 0, right: 260 } }),
    ).toBe("end")
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
