import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const server = await createServer({
  root: new URL("../..", import.meta.url).pathname,
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
const [pane, artifacts, state, dialogs, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/RightPane.tsx") as Promise<typeof import("./RightPane")>,
  server.ssrLoadModule("/src/artifacts/context.ts") as Promise<typeof import("@/artifacts/context")>,
  server.ssrLoadModule("/src/atlas/store/ui.ts") as Promise<typeof import("@/atlas/store/ui")>,
  server.ssrLoadModule("@synsci/ui/context/dialog") as Promise<typeof import("@synsci/ui/context/dialog")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])
const cleanups: Array<() => void> = []

afterAll(() => server.close())

// The ui store is a module singleton, so it is shared with every other test
// file that loads it in this process — session-shell.test.ts opens the pane
// and does not put it back. Resetting before as well as after means this file
// asserts against a state it actually established, rather than against
// whatever the previous file happened to leave behind.
const reset = () => {
  state.uiStore.workTabs().forEach((tab) => state.uiStore.closeWorkTab(tab.id))
  state.uiStore.closeContext()
  state.uiStore.setRightPaneMode("tools")
  state.uiStore.setRightPaneTab("canvas")
}

beforeEach(reset)

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
  const active = artifacts.artifactContext.active()
  if (active) artifacts.artifactContext.clear(active.id)
  reset()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

const mountGate = () => {
  expect(pane.RightPaneGate).toBeFunction()
  const inspector = document.createElement("aside")
  inspector.setAttribute("aria-label", "Research inspector")
  return mount(() => pane.RightPaneGate({ children: inspector }))
}

test("keeps the Files pane absent until it is opened, then mounts it contextually", async () => {
  const host = mountGate()

  expect(state.uiStore.open()).toBe(false)
  expect(host.querySelector('[aria-label="Research inspector"]')).toBeNull()

  state.uiStore.openContext("files")
  await Promise.resolve()

  expect(state.uiStore.context()).toBe("files")
  expect(state.uiStore.open()).toBe(true)
  expect(host.querySelector('[aria-label="Research inspector"]')).not.toBeNull()
})

test("parks a previously opened terminal when its parent tab closes", async () => {
  const host = mountGate()

  state.uiStore.openContext("terminal")
  await Promise.resolve()
  const inspector = host.querySelector('[aria-label="Research inspector"]')
  expect(inspector).not.toBeNull()

  state.uiStore.closeWorkTab("view:terminal")
  await Promise.resolve()

  expect(state.uiStore.open()).toBe(false)
  expect(host.querySelector('[aria-label="Research inspector"]')).toBe(inspector)
  expect(inspector?.parentElement?.dataset.open).toBe("false")
})

test("closes the mounted Details pane when its artifact ownership clears", async () => {
  const current = artifacts.createArtifactContext({ directory: "/project", path: "results.csv" })
  const host = mountGate()

  artifacts.artifactContext.activate(current)
  state.uiStore.openContext("artifact")
  await Promise.resolve()
  expect(artifacts.artifactContext.active()).toEqual(current)
  expect(state.uiStore.open()).toBe(true)
  expect(host.querySelector('[aria-label="Research inspector"]')).not.toBeNull()

  artifacts.artifactContext.clear(current.id)
  await Promise.resolve()

  expect(artifacts.artifactContext.active()).toBeUndefined()
  expect(state.uiStore.open()).toBe(false)
  expect(host.querySelector('[aria-label="Research inspector"]')).toBeNull()
})

test("wires the reactive artifact gate into RightPane", async () => {
  const current = artifacts.createArtifactContext({ directory: "/project", path: "report.pdf" })

  artifacts.artifactContext.activate(current)
  state.uiStore.openContext("artifact")
  artifacts.artifactContext.clear(current.id)
  expect(state.uiStore.open()).toBe(true)

  // RightPane now owns dirty-editor confirmation, so mounting the real pane
  // must honor its DialogProvider contract even though this gate closes before
  // any dialog is shown.
  const host = mount(() =>
    dialogs.DialogProvider({
      get children() {
        return pane.RightPane()
      },
    }),
  )
  await Promise.resolve()

  expect(state.uiStore.open()).toBe(false)
  expect(host.querySelector('[aria-label="Research inspector"]')).toBeNull()
})

test.each(["files", "terminal", "canvas", "kernels"] as const)(
  "does not close the open %s context when artifact ownership clears",
  async (context) => {
    const host = mountGate()
    const current = artifacts.createArtifactContext({ directory: "/project", path: `${context}.csv` })

    artifacts.artifactContext.activate(current)
    state.uiStore.openContext(context)
    artifacts.artifactContext.clear(current.id)
    await Promise.resolve()

    expect(artifacts.artifactContext.active()).toBeUndefined()
    expect(state.uiStore.context()).toBe(context)
    expect(state.uiStore.open()).toBe(true)
    expect(host.querySelector('[aria-label="Research inspector"]')).not.toBeNull()
  },
)

test("treats the mobile pane as a focus-contained modal and restores its opener", async () => {
  expect(pane.RightPaneFrame).toBeFunction()

  const opener = document.createElement("button")
  opener.textContent = "Open inspector"
  document.body.append(opener)
  opener.focus()

  const initial = document.createElement("button")
  initial.dataset.modalInitialFocus = "true"
  initial.textContent = "Close"
  const last = document.createElement("button")
  last.textContent = "Last action"
  const host = document.createElement("div")
  const control: { dispose?: () => void } = {}
  document.body.append(host)
  control.dispose = web.render(
    () =>
      pane.RightPaneFrame({
        modal: true,
        mobile: true,
        stacked: false,
        width: 420,
        onClose: () => control.dispose?.(),
        children: [initial, last],
      }),
    host,
  )
  cleanups.push(() => control.dispose?.())

  await Promise.resolve()
  await Promise.resolve()
  const inspector = host.querySelector<HTMLElement>('[aria-label="Research inspector"]')
  expect(inspector?.getAttribute("role")).toBe("dialog")
  expect(inspector?.getAttribute("aria-modal")).toBe("true")
  expect(document.activeElement).toBe(initial)

  initial.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }))
  expect(document.activeElement).toBe(last)
  last.focus()
  last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
  expect(document.activeElement).toBe(initial)

  initial.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await Promise.resolve()
  expect(host.querySelector('[aria-label="Research inspector"]')).toBeNull()
  expect(document.activeElement).toBe(opener)
})

test("keeps the desktop pane non-modal and leaves focus where it was", async () => {
  expect(pane.RightPaneFrame).toBeFunction()

  const opener = document.createElement("button")
  document.body.append(opener)
  opener.focus()
  const host = mount(() =>
    pane.RightPaneFrame({
      modal: false,
      mobile: false,
      stacked: false,
      width: 420,
      onClose: () => {},
      children: document.createElement("button"),
    }),
  )

  await Promise.resolve()
  const inspector = host.querySelector<HTMLElement>('[aria-label="Research inspector"]')
  expect(inspector?.hasAttribute("role")).toBe(false)
  expect(inspector?.hasAttribute("aria-modal")).toBe(false)
  expect(document.activeElement).toBe(opener)
})
