import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { JSX } from "solid-js"
import { createContextState } from "@/atlas/store/ui"

const cleanups: Array<() => void> = []
const server = fileURLToPath(import.meta.resolve("solid-js/web"))
const browser = server.replace(/server\.js$/, "web.js")
const hyper = fileURLToPath(import.meta.resolve("solid-js/h"))
const source = (await Bun.file(hyper).text()).replace("from 'solid-js/web';", `from '${pathToFileURL(browser).href}';`)
const temp = await mkdtemp(join(tmpdir(), "openscience-sidebar-actions-"))
const module = join(temp, "h.mjs")
await Bun.write(module, source)
const h = (await import(pathToFileURL(module).href)).default
const render = (await import(browser)).render
Object.assign(globalThis, { React: { createElement: h, Fragment: h.Fragment } })

afterAll(() => rm(temp, { recursive: true, force: true }))

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(render(view, host))
  return host
}

const button = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

describe("SessionSidebarActions", () => {
  test("keeps Files, Terminal, and Compute reachable in the compact menu and gates Atlas", async () => {
    const subject = await import("./session-sidebar-action")
    const state = createContextState()
    const compact = mount(() => (
      <subject.CompactContextActions
        context={state.context()}
        contextOpen={state.open()}
        atlas={false}
        onContext={state.openContext}
      />
    ))
    const menu = (label: string) =>
      Array.from(compact.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')).find(
        (item) => item.textContent?.trim() === label,
      )

    menu("Files")?.click()
    await Promise.resolve()
    expect(state.context()).toBe("files")
    expect(state.open()).toBe(true)

    menu("Terminal")?.click()
    await Promise.resolve()
    expect(state.context()).toBe("terminal")
    expect(state.open()).toBe(true)

    menu("Compute")?.click()
    await Promise.resolve()
    expect(state.context()).toBe("kernels")
    expect(menu("Atlas")).toBeUndefined()
    expect(menu("Evidence")).toBeUndefined()
    expect(menu("Trace")).toBeUndefined()

    const connected = mount(() => (
      <subject.CompactContextActions context="kernels" contextOpen={true} atlas={true} onContext={() => {}} />
    ))
    expect(
      Array.from(connected.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
        .find((item) => item.textContent?.trim() === "Compute")
        ?.getAttribute("aria-pressed"),
    ).toBe("true")
    expect(connected.textContent).toContain("Atlas")
  })

  test("keeps Trace hidden until the General preference is enabled", async () => {
    const subject = await import("./session-sidebar-action")
    const hidden = mount(() => (
      <subject.SessionSidebarActions
        context="trace"
        contextOpen={true}
        artifact={false}
        atlas={false}
        onContext={() => {}}
      />
    ))
    const visible = mount(() => (
      <subject.SessionSidebarActions
        context="trace"
        contextOpen={true}
        artifact={false}
        atlas={false}
        trace={true}
        onContext={() => {}}
      />
    ))

    expect(button(hidden, "Open session trace")).toBeNull()
    expect(button(visible, "Open session trace")?.getAttribute("aria-pressed")).toBe("true")
  })

  test("keeps rail labels semantic while visual density stays in the shell CSS", async () => {
    const subject = await import("./session-sidebar-action")
    const action = mount(() => (
      <subject.SidebarAction
        label="New research"
        detail="Start a session"
        ariaLabel="New research"
        shortcut="⌘N"
        onClick={() => {}}
      >
        <span />
      </subject.SidebarAction>
    ))
    const actions = mount(() => (
      <subject.SessionSidebarActions
        context="canvas"
        contextOpen={false}
        artifact={false}
        atlas={false}
        onContext={() => {}}
      />
    ))

    expect(action.querySelector(".session-sidebar__action-copy strong")?.textContent).toBe("New research")
    expect(action.querySelector(".session-sidebar__action-copy > span")?.textContent).toBe("Start a session")
    expect(action.querySelector("kbd")?.textContent).toBe("⌘N")
    expect(actions.querySelector(".session-sidebar__group-label")).toBeNull()
  })

  test("opens and toggles contextual surfaces from the left rail", async () => {
    const subject = (await import("./session-sidebar-action")) as typeof import("./session-sidebar-action") & {
      SessionSidebarActions?: (props: {
        context: "files" | "terminal" | "canvas" | "kernels" | "artifact"
        contextOpen: boolean
        artifact: boolean
        atlas: boolean
        onContext: (context: "files" | "terminal" | "canvas" | "kernels" | "artifact") => void
      }) => JSX.Element
    }
    expect(subject.SessionSidebarActions).toBeDefined()
    if (!subject.SessionSidebarActions) return

    const state = createContextState()
    const host = mount(() => (
      <subject.SessionSidebarActions
        context={state.context()}
        contextOpen={state.open()}
        artifact={false}
        atlas={true}
        onContext={state.openContext}
      />
    ))

    button(host, "Open project files")?.click()
    await Promise.resolve()
    expect(state.context()).toBe("files")
    expect(state.open()).toBe(true)

    button(host, "Open project terminal")?.click()
    await Promise.resolve()
    expect(state.context()).toBe("terminal")
    expect(state.open()).toBe(true)

    button(host, "Open Atlas")?.click()
    await Promise.resolve()
    expect(state.context()).toBe("canvas")
    expect(state.open()).toBe(true)

    button(host, "Open Atlas")?.click()
    await Promise.resolve()
    expect(state.open()).toBe(false)

    button(host, "Open session compute")?.click()
    await Promise.resolve()
    expect(state.context()).toBe("kernels")

    const selected = mount(() => (
      <subject.SessionSidebarActions
        context="canvas"
        contextOpen={true}
        artifact={false}
        atlas={true}
        onContext={() => {}}
      />
    ))
    expect(button(selected, "Open Atlas")?.getAttribute("aria-pressed")).toBe("true")
    expect(button(selected, "Open project terminal")).not.toBeNull()
    expect(button(selected, "Open Evidence")).toBeNull()

    const files = mount(() => (
      <subject.SessionSidebarActions
        context="files"
        contextOpen={true}
        artifact={false}
        atlas={false}
        onContext={() => {}}
      />
    ))
    expect(button(files, "Open project files")?.getAttribute("aria-pressed")).toBe("true")
    expect(button(files, "Open Atlas")).toBeNull()
  })

  test("offers Details only when an artifact is active", async () => {
    const subject = (await import("./session-sidebar-action")) as typeof import("./session-sidebar-action") & {
      SessionSidebarActions?: (props: {
        context: "files" | "terminal" | "canvas" | "kernels" | "artifact"
        contextOpen: boolean
        artifact: boolean
        atlas: boolean
        onContext: (context: "files" | "terminal" | "canvas" | "kernels" | "artifact") => void
      }) => JSX.Element
    }
    expect(subject.SessionSidebarActions).toBeDefined()
    if (!subject.SessionSidebarActions) return

    const empty = mount(() => (
      <subject.SessionSidebarActions
        context="artifact"
        contextOpen={true}
        artifact={false}
        atlas={false}
        onContext={() => {}}
      />
    ))
    const active = mount(() => (
      <subject.SessionSidebarActions
        context="artifact"
        contextOpen={true}
        artifact={true}
        atlas={false}
        onContext={() => {}}
      />
    ))

    expect(button(empty, "Open file details")).toBeNull()
    expect(button(active, "Open file details")).not.toBeNull()
    expect(button(active, "Open file details")?.getAttribute("aria-pressed")).toBe("true")
  })
})
