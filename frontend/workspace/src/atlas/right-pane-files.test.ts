import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

test("keeps the explorer and selected file preview inside the contextual pane", () => {
  const pane = read("./RightPane.tsx")
  const session = read("../pages/session.tsx")
  const directory = read("../pages/directory-layout.tsx")

  expect(pane).toContain('import { ExternalFileAccess } from "@/atlas/FileExplorer"')
  expect(pane).toContain('import { FilesPane } from "@/atlas/FilesPane"')
  expect(pane).toContain('import { FileView } from "@/atlas/FilePreview"')
  expect(pane).toContain('when={context() === "files" && !uiStore.file() && !uiStore.saved()}')
  expect(pane).toContain("<StoredArtifactView")
  expect(pane).toContain("<FilesPane />")
  expect(pane).toContain("<FileView")
  expect(pane).toContain("directory={file.directory}")
  expect(pane).toContain("path={file.path}")
  expect(pane).toContain("onClose={() => uiStore.closeFile()}")
  expect(pane).toContain("when={!file.external}")
  expect(pane).toContain("<ExternalFileAccess")
  // Collection surfaces and individual files share one reorderable,
  // closable, project/session-scoped work strip.
  expect(pane).toContain("<WorkTabStrip")
  expect(pane).toContain("onSelect={uiStore.activateWorkTab}")
  expect(pane).toContain("onReorder={uiStore.moveWorkTab}")
  expect(pane).toContain("<Show when={uiStore.file()} keyed>")
  expect(pane).toContain('subtitle="Session files"')
  expect(pane).toContain("<RightPaneGate>")
  expect(directory).toContain("uiStore.openFile(dir, path)")
  expect(session).not.toContain('import { FileExplorer } from "@/atlas/FileExplorer"')
  expect(session).not.toContain('import { FileView } from "@/atlas/FilePreview"')
  expect(session).not.toContain("centerTabs")
})

test("preserves the center conversation for markdown links while opening Files on the right", () => {
  const session = read("../pages/session.tsx")

  expect(session).toContain('data-component="conversation-center"')
  expect(session).toContain('aria-label="Conversation"')
  expect(session).toContain("uiStore.openFile(projectPath(), path)")
  expect(session).not.toContain("uiStore.closeFile()")
  expect(session).toContain(
    '<RightPane project={sdk.scope} session={params.id ?? "new"} onEnsureSession={ensureSession} />',
  )
  expect(session).toContain('document.addEventListener("openscience:open-file", onOpenFile)')
  expect(session).not.toContain('role="tabpanel"')
  expect(session).not.toContain("<CenterTabStrip")
  expect(session).not.toContain("centerTabs.docs()")
})
