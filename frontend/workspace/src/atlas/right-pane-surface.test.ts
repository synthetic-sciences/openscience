import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

test("closed right pane renders no collapsed launcher and retains open file editors without showing the pane", () => {
  const source = read("./RightPane.tsx")
  const styles = read("./right-pane-tabs.css")

  expect(source).toContain("<Show when={uiStore.rightPaneOpen() || retained()}>")
  expect(source).toContain('data-open={uiStore.rightPaneOpen() ? "true" : "false"}')
  expect(styles).toContain('.right-pane-gate[data-open="false"]')
  expect(styles).toContain("display: none")
  expect(source).not.toContain("CollapsedRail")
  expect(source).toContain('when={context() === "terminal"}')
  expect(source).toContain("<TerminalSurface />")
  expect(source).not.toContain("<TerminalTab")
  expect(source).not.toContain("panel settings")
})

test("lives in a project-owned sibling frame instead of the session route", () => {
  const frame = read("./ProjectWorkspaceFrame.tsx")
  const frameStyles = read("./ProjectWorkspaceFrame.css")
  const directory = read("../pages/directory-layout.tsx")
  const session = read("../pages/session.tsx")
  const styles = read("./right-pane-tabs.css")

  expect(frame).toContain('class="project-workspace-frame"')
  expect(frame).toContain('class="project-workspace-frame__route"')
  expect(directory).toContain('lazy(() => import("@/atlas/ProjectRightPane"))')
  expect(directory).toContain("<ProjectRightPane")
  expect(session).not.toContain("<RightPane")
  expect(frameStyles).toContain(".project-workspace-frame")
  expect(frameStyles).toContain(".project-workspace-frame__route")
  expect(styles).not.toContain(".project-workspace-frame")
})

test("artifact context keeps the pane header as its only close or back action", () => {
  const source = read("./RightPane.tsx")

  expect(source).toContain('aria-label={narrow() ? "Back to conversation" : "Close context"}')
  expect(source).toContain("<ArtifactInspector context={current()} />")
  expect(source).not.toContain("<ArtifactInspector context={current()} onClose=")
})

test("keeps modal focus inside visible content and moves focus with roving tabs", () => {
  const source = read("./RightPane.tsx")

  expect(source).toContain(`!item.closest('[hidden], [aria-hidden="true"], [inert]')`)
  expect(source).toContain("data-work-tab={tab.id}")
  expect(source).toContain('event.currentTarget.closest(".inspector-tabs")')
  expect(source).toContain(".find((item) => item.dataset.workTab === target.id)")
  expect(source).toContain("?.focus()")
})

test("resize separator exposes keyboard and range semantics", () => {
  const source = read("./RightPane.tsx")

  expect(source).toContain("tabindex={narrow() ? -1 : 0}")
  expect(source).toContain("onKeyDown={onHandleKeyDown}")
  expect(source).toContain('event.key === "ArrowLeft"')
  expect(source).toContain('event.key === "ArrowRight"')
  expect(source).toContain("aria-valuemin={MIN_PANE_WIDTH}")
  expect(source).toContain("aria-valuemax={limit()}")
  expect(source).toContain("aria-valuenow={paneWidth()}")
  expect(source).toContain("onDblClick={splitEvenly}")
  expect(source).toContain('aria-label="Split workspace evenly"')
  expect(source).toContain("new ResizeObserver(measure)")
})

test("uses an inline desktop pane and a full-width narrow overlay, never a pane stacked below chat", () => {
  const source = read("./RightPane.tsx")
  const styles = read("../styles/atlas.css")
  const paneStyles = read("./right-pane-tabs.css")

  expect(source).toContain("window.innerWidth < INLINE_PANE_BREAKPOINT")
  expect(source).toContain("modal={uiStore.rightPaneOpen() && (narrow() || expanded())}")
  expect(source).toContain("mobile={uiStore.rightPaneOpen() && narrow()}")
  expect(source).toContain("stacked={false}")
  expect(source).toContain("refs.prior = active instanceof HTMLElement ? active : undefined")
  expect(source).toContain("const prior = refs.modal ? refs.prior : undefined")
  expect(source).toContain("if (prior?.isConnected) queueMicrotask(() => prior.focus())")
  expect(styles).not.toContain('.session-right-pane[data-stacked="true"]')
  expect(styles).not.toContain("grid-template-rows: minmax(0, 45fr) minmax(0, 55fr)")
  expect(styles).not.toContain(".session-right-pane")
  expect(styles).not.toContain(".research-inspector__header")
  expect(styles).not.toContain(".inspector-tabs")
  expect(paneStyles).toContain("border-left: 1px solid var(--color-border)")
  expect(paneStyles).toContain("border-bottom: 1px solid var(--color-border)")
  expect(paneStyles).toContain("border-radius: var(--atlas-radius-xs)")
  expect(paneStyles).not.toContain("linear-gradient")
  expect(paneStyles).not.toContain("color-mix")
})

test("keeps the Compute tab while mounting the unified execution inventory", () => {
  const source = read("./RightPane.tsx")

  expect(source).toContain('import { ComputeSurface } from "@/atlas/ComputeSurface"')
  expect(source).toContain('kernels: "Compute"')
  expect(source).toContain('when={context() === "kernels"}')
  expect(source).toContain("<ComputeSurface />")
  expect(source).not.toContain("<KernelPanel />")
})

test("mounts the local observable trace for the active session", () => {
  const source = read("./RightPane.tsx")

  expect(source).toContain('import { SessionTraceSurface } from "@/atlas/SessionTraceSurface"')
  expect(source).toContain('when={context() === "trace"}')
  expect(source).toContain("<SessionTraceSurface session={session()} />")
})
