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
  expect(pane).toContain('const browser = () => context() === "files" && !uiStore.file() && !uiStore.saved()')
  expect(pane).toContain("<StoredArtifactView")
  expect(pane).toContain("<FilesPane />")
  expect(pane).toContain('data-component="files-context"')
  expect(pane).toContain('display: browser() ? "flex" : "none"')
  expect(pane).toContain('if (context() === "files") setSeen(true)')
  expect(pane).toContain("<FileView")
  expect(pane).toContain("directory={tab.file.directory}")
  expect(pane).toContain("path={tab.file.path}")
  expect(pane).toContain("onClose={() => void closeWorkTab(tab.id)}")
  expect(pane).toContain("when={!tab.file.external}")
  expect(pane).toContain("<ExternalFileAccess")
  // Collection surfaces and individual files share one reorderable,
  // closable, project-scoped work strip that survives chat changes.
  expect(pane).toContain("<WorkTabStrip")
  expect(pane.match(/<WorkTabStrip/g)).toHaveLength(1)
  expect(pane.indexOf("<WorkTabStrip")).toBeLessThan(pane.indexOf('class="research-inspector__controls"'))
  expect(pane).toContain("onSelect={uiStore.activateWorkTab}")
  expect(pane).toContain("onReorder={uiStore.moveWorkTab}")
  expect(pane).toContain("<For each={fileTabs()}>")
  expect(pane).toContain("hidden={!visibleFile(tab)}")
  expect(pane).toContain("onDirtyChange={(dirty) => markDirty(tab.id, dirty)}")
  expect(pane).toContain('title: "Discard unsaved changes?"')
  expect(pane).toContain('subtitle={tab.file.external ? "Session files" : "Project files"}')
  expect(pane).toContain('sessionID={session() === "new" ? undefined : session()}')
  expect(pane).toContain("<RightPaneGate>")
  expect(directory).toContain("uiStore.openFile(dir, path)")
  expect(session).not.toContain('import { FileExplorer } from "@/atlas/FileExplorer"')
  expect(session).not.toContain('import { FileView } from "@/atlas/FilePreview"')
  expect(session).not.toContain("centerTabs")
})

test("preserves the center conversation for markdown links while opening Files on the right", () => {
  const session = read("../pages/session.tsx")
  const directory = read("../pages/directory-layout.tsx")
  const projectPane = read("./ProjectRightPane.tsx")

  expect(session).toContain('data-component="conversation-center"')
  expect(session).toContain('aria-label="Conversation"')
  expect(session).toContain("uiStore.openFile(projectPath(), path)")
  expect(session).not.toContain("uiStore.closeFile()")
  expect(session).not.toContain("<RightPane")
  expect(directory).toContain('<ProjectRightPane project={sdk.scope} session={params.id ?? "new"} />')
  expect(projectPane).toContain("<RightPane project={props.project} session={props.session} />")
  expect(session).toContain('document.addEventListener("openscience:open-file", onOpenFile)')
  expect(session).toContain('id="session-conversation-panel"')
  expect(session.match(/role="tabpanel"/g)).toHaveLength(1)
  expect(session).not.toContain("<CenterTabStrip")
  expect(session).not.toContain("centerTabs.docs()")
})
