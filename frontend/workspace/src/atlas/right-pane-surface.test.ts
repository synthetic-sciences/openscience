import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

test("closed right pane renders no collapsed launcher and retains stateful surfaces without showing the pane", () => {
  const source = read("./RightPane.tsx")
  const styles = read("./right-pane-tabs.css")

  expect(source).toContain("<Show when={uiStore.rightPaneOpen() || retained()}>")
  expect(source).toContain('data-open={uiStore.rightPaneOpen() ? "true" : "false"}')
  expect(styles).toContain('.right-pane-gate[data-open="false"]')
  expect(styles).toContain("display: none")
  expect(source).not.toContain("CollapsedRail")
  expect(source).toContain("const retained = () => terminal() ||")
  expect(source).toContain("<Show when={terminalSeen()}>")
  expect(source).toContain("<TerminalSurface active={terminalVisible()} />")
  expect(source).not.toContain('<Match when={context() === "terminal"}>')
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
  expect(frameStyles).toMatch(/\.project-workspace-frame\s*\{[^}]*height: 100%;/s)
  expect(frameStyles).not.toContain("height: 100dvh")
  expect(session).toContain('height: "100%"')
  expect(session).not.toContain('height: "100dvh"')
  expect(styles).not.toContain(".project-workspace-frame")
})

test("keeps artifact details and provenance out of the right pane", () => {
  const source = read("./RightPane.tsx")

  expect(source).toContain('aria-label={narrow() ? "Back to conversation" : "Close context"}')
  expect(source).not.toContain("ArtifactInspector")
  expect(source).not.toContain("Artifact details")
  expect(source).not.toContain("onDirtyChange={(dirty) => markDirty(tab.id, dirty)}\n                      onClose=")
})

test("keeps modal focus inside visible content and moves focus with roving tabs", () => {
  const source = read("./RightPane.tsx")

  expect(source).toContain(`!item.closest('[hidden], [aria-hidden="true"], [inert]')`)
  expect(source).toContain("data-work-tab={tab.id}")
  expect(source).toContain('event.currentTarget.closest(".inspector-tabs")')
  expect(source).toContain(".find((item) => item.dataset.workTab === target.id)")
  expect(source).toContain("?.focus()")
  expect(source).toContain("let strip: HTMLElement | undefined")
  expect(source).toContain('?.scrollIntoView({ block: "nearest", inline: "nearest" })')
})

test("gives contextual work tabs recognizable icons without collapsing the horizontal strip", () => {
  const source = read("./RightPane.tsx")
  const styles = read("./right-pane-tabs.css")

  expect(source).toContain("function workTabIcon(tab: WorkTab)")
  expect(source).toContain('class="inspector-tab__icon"')
  expect(source).toContain("<FileIcon")
  expect(source).toContain("<IconArchive")
  expect(source).toContain("<IconCpu")
  expect(source).toContain('canvas: "Synthetic Sciences"')
  expect(styles).toContain(".inspector-tab__icon")
  expect(styles).toMatch(/\.inspector-tab-pair \.inspector-tab\s*\{[^}]*gap: 6px;/s)
  expect(styles).toMatch(/\.inspector-tab__icon\s*\{[^}]*width: 16px;[^}]*height: 16px;[^}]*flex: 0 0 16px;/s)
  expect(styles).toMatch(/\.inspector-tabs\s*\{[^}]*overflow-x: auto/s)
  expect(styles).toMatch(/\.inspector-tab-pair\s*\{[^}]*flex: 0 0 auto/s)
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
  expect(source).toContain('title="Drag to resize. Double-click to split evenly."')
  expect(source).not.toContain('class="research-inspector__resize-grip"')
  expect(source).toContain('aria-label="Split workspace evenly"')
  expect(source).toContain("new ResizeObserver(measure)")
  expect(source).toContain('element.closest<HTMLElement>(".project-workspace-frame")')
  expect(source).toContain('querySelector<HTMLElement>(".project-workspace-frame__route .session-sidebar")')
  expect(source).toContain("setPersistentSidebar(frame.sidebar?.getBoundingClientRect().width")
  expect(source).toContain("frame.observer.observe(boundary)")
  expect(source).toContain("frame.observer?.observe(frame.sidebar)")
  expect(source).toContain("new MutationObserver(attachSidebar)")
  expect(source).not.toContain("main.clientWidth + element.clientWidth")
})

test("uses a compact tab strip that reveals close controls only when relevant", () => {
  const styles = read("./right-pane-tabs.css")

  expect(styles).toMatch(/\.research-inspector__header\s*\{[^}]*height: 44px/s)
  expect(styles).toMatch(/\.inspector-tab-pair\s*\{[^}]*max-width: 180px;[^}]*min-height: 32px/s)
  expect(styles).toMatch(/\.inspector-tab-pair \.inspector-tab__close\s*\{[^}]*width: 0;[^}]*min-width: 0/s)
  expect(styles).toMatch(
    /\.inspector-tab-pair\[data-active="true"\] \.inspector-tab__close\s*\{[^}]*width: 28px;[^}]*min-width: 28px/s,
  )
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

test("does not mount the retired trace surface", () => {
  const source = read("./RightPane.tsx")

  expect(source).not.toContain("SessionTraceSurface")
  expect(source).not.toContain('when={context() === "trace"}')
})
