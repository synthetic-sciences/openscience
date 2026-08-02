import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

test("closed right pane renders no collapsed launcher and mounts terminal only as selected context", () => {
  const source = read("./RightPane.tsx")

  expect(source).toContain("<Show when={uiStore.rightPaneOpen()}>")
  expect(source).not.toContain("CollapsedRail")
  expect(source).toContain('when={context() === "terminal"}')
  expect(source).toContain("<TerminalSurface />")
  expect(source).not.toContain("<TerminalTab")
  expect(source).not.toContain("panel settings")
})

test("artifact context keeps the pane header as its only close or back action", () => {
  const source = read("./RightPane.tsx")

  expect(source).toContain('aria-label={narrow() ? "Back to conversation" : "Close context"}')
  expect(source).toContain("<ArtifactInspector context={current()} />")
  expect(source).not.toContain("<ArtifactInspector context={current()} onClose=")
})

test("resize separator exposes keyboard and range semantics", () => {
  const source = read("./RightPane.tsx")

  expect(source).toContain("tabindex={narrow() ? -1 : 0}")
  expect(source).toContain("onKeyDown={onHandleKeyDown}")
  expect(source).toContain('event.key === "ArrowLeft"')
  expect(source).toContain('event.key === "ArrowRight"')
  expect(source).toContain("aria-valuemin={MIN_PANE_WIDTH}")
  expect(source).toContain("aria-valuemax={MAX_PANE_WIDTH}")
  expect(source).toContain("aria-valuenow={paneWidth()}")
})

test("uses an inline desktop pane and a full-width narrow overlay, never a pane stacked below chat", () => {
  const source = read("./RightPane.tsx")
  const styles = read("../styles/atlas.css")

  expect(source).toContain("window.innerWidth < INLINE_PANE_BREAKPOINT")
  expect(source).toContain("modal={narrow() || expanded()}")
  expect(source).toContain("mobile={narrow()}")
  expect(source).toContain("stacked={false}")
  expect(source).toContain("refs.prior = active instanceof HTMLElement ? active : undefined")
  expect(source).toContain("const prior = refs.modal ? refs.prior : undefined")
  expect(source).toContain("if (prior?.isConnected) queueMicrotask(() => prior.focus())")
  expect(styles).not.toContain('.session-right-pane[data-stacked="true"]')
  expect(styles).not.toContain("grid-template-rows: minmax(0, 45fr) minmax(0, 55fr)")
})

test("mounts the unified compute surface for the kernels context", () => {
  const source = read("./RightPane.tsx")

  expect(source).toContain('import { ComputeSurface } from "@/atlas/ComputeSurface"')
  expect(source).toContain('when={context() === "kernels"}')
  expect(source).toContain("<ComputeSurface onEnsureSession={props.onEnsureSession} />")
  expect(source).not.toContain("<KernelPanel />")
})

test("mounts the local observable trace for the active session", () => {
  const source = read("./RightPane.tsx")

  expect(source).toContain('import { SessionTraceSurface } from "@/atlas/SessionTraceSurface"')
  expect(source).toContain('when={context() === "trace"}')
  expect(source).toContain("<SessionTraceSurface session={session()} />")
})
