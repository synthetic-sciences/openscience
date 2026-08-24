import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const cleanups: Array<() => void> = []
const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/pages/session-tabs.tsx") as Promise<typeof import("./session-tabs")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const SessionTabStrip = subject.SessionTabStrip
const sessionTabEditorBounds = subject.sessionTabEditorBounds

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const tabs = [
  {
    id: "session-a",
    title: "Protein screen",
    working: true,
    dirty: false,
    unread: false,
    editable: true,
    closable: true,
  },
  {
    id: "session-b",
    title: "Replication notes",
    working: false,
    dirty: true,
    unread: true,
    editable: true,
    closable: true,
  },
]

describe("SessionTabStrip", () => {
  test("keeps the rename editor fully inside narrow and right-scrolled strips", () => {
    expect(sessionTabEditorBounds(260, 180, 320)).toEqual({ left: 140, width: 180 })
    expect(sessionTabEditorBounds(-48, 180, 320)).toEqual({ left: 0, width: 180 })
    expect(sessionTabEditorBounds(80, 180, 120)).toEqual({ left: 0, width: 120 })
  })

  test("renders truthful state with roving horizontal keyboard navigation", async () => {
    const selected: string[] = []
    const reordered: Array<[string, number]> = []
    const [active, setActive] = (await server.ssrLoadModule("solid-js")).createSignal("session-a")
    const host = mount(() =>
      SessionTabStrip({
        tabs,
        get active() {
          return active()
        },
        onSelect: (id) => {
          selected.push(id)
          setActive(id)
        },
        onClose: () => {},
        onReorder: (id, to) => reordered.push([id, to]),
        onRename: async () => true,
      }),
    )

    const list = host.querySelector('[role="tablist"]')
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(list?.getAttribute("aria-orientation")).toBe("horizontal")
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1])
    expect(buttons[0].getAttribute("aria-controls")).toBe("session-conversation-panel")
    expect(buttons[0].getAttribute("aria-label")).toContain("working")
    expect(buttons[1].getAttribute("aria-label")).toContain("unread")
    expect(buttons[1].getAttribute("aria-label")).toContain("draft saved")

    buttons[0].focus()
    buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    await settle()
    expect(selected).toEqual(["session-b"])
    expect(document.activeElement).toBe(buttons[1])

    buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }))
    expect(reordered).toEqual([["session-a", 1]])
  })

  test("closes independently and renames the active tab with F2", async () => {
    const closed: string[] = []
    const renamed: Array<[string, string]> = []
    const host = mount(() =>
      SessionTabStrip({
        tabs,
        active: "session-a",
        onSelect: () => {},
        onClose: (id) => {
          closed.push(id)
        },
        onReorder: () => {},
        onRename: async (id, title) => {
          renamed.push([id, title])
          return true
        },
      }),
    )

    const close = host.querySelectorAll<HTMLButtonElement>(".workspace-tab__close")[1]
    close.focus()
    close.click()
    await settle()
    expect(closed).toEqual(["session-b"])
    expect(document.activeElement).toBe(host.querySelector('[data-session-tab="session-a"]'))

    const active = host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
    active?.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }))
    await settle()
    const input = host.querySelector<HTMLInputElement>(".workspace-tab-editor input")
    expect(input?.value).toBe("Protein screen")
    expect(host.querySelector(`label[for="${input?.id}"]`)?.textContent).toContain("Session name")

    if (input) {
      input.value = "  Protein validation  "
      input.dispatchEvent(new InputEvent("input", { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    }
    await settle()
    expect(renamed).toEqual([["session-a", "Protein validation"]])
    expect(host.querySelector(".workspace-tab-editor input")).toBeNull()
  })

  test("keeps a failed rename editable and exposes the error", async () => {
    const host = mount(() =>
      SessionTabStrip({
        tabs,
        active: "session-a",
        onSelect: () => {},
        onClose: () => {},
        onReorder: () => {},
        onRename: async () => false,
      }),
    )

    host
      .querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }))
    const input = host.querySelector<HTMLInputElement>(".workspace-tab-editor input")
    if (input) {
      input.value = "Unavailable rename"
      input.dispatchEvent(new InputEvent("input", { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    }
    await settle()

    expect(host.querySelector(".workspace-tab-editor input")).toBe(input)
    expect(input?.getAttribute("aria-invalid")).toBe("true")
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Could not save")
  })
})
