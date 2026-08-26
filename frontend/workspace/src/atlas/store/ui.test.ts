import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createContextState, type ContextStorage, uiStore } from "./ui"
import { workspaceScope } from "./scope"
import type { StoredArtifact } from "@/artifacts/store"

function memoryStorage(initial: Record<string, string> = {}): ContextStorage {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      values.set(key, value)
    },
  }
}

function saved(id = "art_test"): StoredArtifact {
  return {
    schemaVersion: 1,
    id,
    projectID: "project-a",
    title: "results.csv",
    kind: "dataset",
    currentVersionID: `ver_${id}`,
    createdAt: 1,
    updatedAt: 2,
    state: "active",
    versionCount: 1,
    current: {
      id: `ver_${id}`,
      artifactID: id,
      version: 1,
      filename: "results.csv",
      mimeType: "text/csv",
      size: 12,
      sha256: "a".repeat(64),
      sessionID: "session-a",
      sourcePath: "results.csv",
      captureQuality: "declared",
      createdAt: 2,
    },
  }
}

describe("context pane state", () => {
  test("starts closed even when the retired persistence key says open", () => {
    const storage = memoryStorage({ "openscience-rightpane-open-v2": "1" })
    const state = createContextState({ storage })

    expect(state.open()).toBe(false)
  })

  test("keeps pane, tabs, and files stable while the active session changes", () => {
    const storage = memoryStorage()
    const first = createContextState({ storage })

    first.activateScope("project-a", "session-a")
    first.openFile("/work/a", "results/a.csv")
    first.setArtifactPaneTab("history")
    const workTabs = first.workTabs()
    const openFile = first.file()

    first.activateScope("project-a", "session-b")
    expect(first.open()).toBe(true)
    expect(first.workTabs()).toBe(workTabs)
    expect(first.file()).toBe(openFile)
    expect(first.file()?.path).toBe("results/a.csv")
    expect(first.artifactPaneTab()).toBe("history")
    first.openContext("kernels")

    first.activateScope("project-b", "session-a")
    expect(first.open()).toBe(false)
    expect(first.file()).toBeUndefined()

    const restored = createContextState({ storage })
    restored.activateScope("project-a", "session-a")
    expect(restored.context()).toBe("kernels")
    expect(restored.files().map((file) => file.path)).toEqual(["results/a.csv"])
    expect(restored.artifactPaneTab()).toBe("history")
    expect(restored.open()).toBe(true)

    restored.activateScope("project-a", "session-b")
    expect(restored.context()).toBe("kernels")
    expect(restored.open()).toBe(true)
  })

  test("keeps working in memory when storage reads and writes fail", () => {
    const state = createContextState({
      storage: {
        getItem() {
          throw new Error("blocked")
        },
        setItem() {
          throw new Error("blocked")
        },
      },
    })

    state.activateScope("project", "session")
    state.openFile("/work/project", "notes.md")

    expect(state.open()).toBe(true)
    expect(state.file()?.path).toBe("notes.md")
  })

  test("migrates the active legacy session pane into one project pane", () => {
    const legacy = workspaceScope("project-a", "session-a")
    const storage = memoryStorage({
      "openscience-context-state-v2": JSON.stringify({
        version: 2,
        scopes: { [legacy]: { tab: "kernels", mode: "tools", open: true } },
      }),
    })
    const state = createContextState({ storage })

    state.activateScope("project-a", "session-a")
    expect(state.context()).toBe("kernels")
    expect(state.open()).toBe(true)

    state.activateScope("project-a", "session-b")
    expect(state.context()).toBe("kernels")
    expect(state.open()).toBe(true)
  })

  test("keeps prompt prefills session-scoped while the inspector is project-scoped", () => {
    const state = createContextState({ storage: memoryStorage() })

    state.activateScope("project-a", "session-a")
    state.setPrefill("alpha")
    state.activateScope("project-a", "session-b")
    expect(state.prefill()).toBeUndefined()

    state.setPrefill("beta")
    state.activateScope("project-a", "session-a")
    expect(state.prefill()).toBe("alpha")
  })

  test("keeps chat-linked files ambiguous until the preview resolves their real workspace", () => {
    const state = createContextState({ storage: memoryStorage() })
    state.activateScope("project-a", "session-a")
    state.openFile("/work/alpha", "results/curve.csv", { scope: "auto" })

    expect(state.file()).toEqual({
      directory: "/work/alpha",
      path: "results/curve.csv",
      name: "curve.csv",
      scope: "auto",
    })
  })

  test("active context remains selected and a different context switches directly", () => {
    const state = createContextState()

    state.openContext("files")
    expect(state.context()).toBe("files")
    expect(state.open()).toBe(true)

    state.openContext("files")
    expect(state.open()).toBe(true)
    expect(state.activeWorkTab()).toBe("view:files")

    state.openContext("kernels")
    expect(state.context()).toBe("kernels")
    expect(state.open()).toBe(true)
  })

  test("Files returns from a selected preview to the project source browser without implicitly closing", () => {
    const state = createContextState()

    state.openFile("/work/alpha", "results/curve.csv")
    expect(state.file()?.path).toBe("results/curve.csv")

    state.openContext("files")
    expect(state.context()).toBe("files")
    expect(state.open()).toBe(true)
    expect(state.file()).toBeUndefined()

    state.openContext("files")
    expect(state.open()).toBe(true)
    expect(state.activeWorkTab()).toBe("view:files")
  })

  test("persists the terminal as a project context", () => {
    const storage = memoryStorage()
    const state = createContextState({ storage })

    state.activateScope("project-a", "session-a")
    state.openContext("terminal")

    const restored = createContextState({ storage })
    restored.activateScope("project-a", "session-a")
    expect(restored.context()).toBe("terminal")
    expect(restored.open()).toBe(true)

    restored.activateScope("project-a", "session-b")
    expect(restored.context()).toBe("terminal")
    expect(restored.open()).toBe(true)
  })

  test("persists the local trace in the project work strip", () => {
    const storage = memoryStorage()
    const state = createContextState({ storage })

    state.activateScope("project-a", "session-a")
    state.openContext("trace")

    const restored = createContextState({ storage })
    restored.activateScope("project-a", "session-a")
    expect(restored.context()).toBe("trace")
    expect(restored.activeWorkTab()).toBe("view:trace")
    expect(restored.open()).toBe(true)
  })

  test("closeContext closes without discarding the selected context", () => {
    const state = createContextState()

    state.openContext("artifact")
    state.closeContext()

    expect(state.open()).toBe(false)
    expect(state.context()).toBe("artifact")
  })

  test("keeps the active file selected while its Details view is open and after restore", () => {
    const storage = memoryStorage()
    const state = createContextState({ storage })
    state.activateScope("project-a", "session-a")
    state.openFile("/work/project", "results/curve.csv")

    state.openContext("artifact")

    expect(state.context()).toBe("artifact")
    expect(state.file()?.path).toBe("results/curve.csv")
    expect(state.activeWorkTab()).toBe("view:artifact")

    const restored = createContextState({ storage })
    restored.activateScope("project-a", "session-a")
    expect(restored.context()).toBe("artifact")
    expect(restored.file()?.path).toBe("results/curve.csv")
    expect(restored.activeWorkTab()).toBe("view:artifact")
  })

  test("opens project files in the contextual Files pane", () => {
    const state = createContextState()

    state.openContext("canvas")
    state.openFile("/work/alpha", "./results//curve.csv")

    expect(state.context()).toBe("files")
    expect(state.open()).toBe(true)
    expect(state.file()).toEqual({
      directory: "/work/alpha",
      path: "results/curve.csv",
      name: "curve.csv",
    })
  })

  test("keeps session scratch distinct from a project file with the same relative path", () => {
    const state = createContextState({ storage: memoryStorage() })

    state.openFile("/work/alpha", "results/curve.csv")
    state.openFile("/work/alpha", "results/curve.csv", { scope: "session" })

    expect(state.files()).toEqual([
      { directory: "/work/alpha", path: "results/curve.csv", name: "curve.csv" },
      { directory: "/work/alpha", path: "results/curve.csv", name: "curve.csv", scope: "session" },
    ])
    expect(state.file()?.scope).toBe("session")
  })

  test("marks external absolute files for permission without changing the project root", () => {
    const state = createContextState({ storage: memoryStorage() })

    state.openFile("/work/alpha", "/shared/results.csv")
    expect(state.file()).toEqual({
      directory: "/work/alpha",
      path: "/shared/results.csv",
      name: "results.csv",
      external: true,
    })

    state.closeFile()
    expect(state.file()).toBeUndefined()
    expect(state.files()).toHaveLength(0)
    expect(state.context()).toBe("files")
    expect(state.open()).toBe(true)
  })

  test("does not confuse a sibling prefix for a project file", () => {
    const state = createContextState({ storage: memoryStorage() })

    state.openFile("/work/CERBench", "/work/CERBench-old/results.csv")

    expect(state.file()).toMatchObject({
      directory: "/work/CERBench",
      path: "/work/CERBench-old/results.csv",
      external: true,
    })
  })

  test("treats Windows project paths case-insensitively", () => {
    const state = createContextState({ storage: memoryStorage() })

    state.openFile("C:\\Research\\CERBench", "c:\\research\\cerbench\\results\\scores.csv")

    expect(state.file()).toEqual({
      directory: "C:/Research/CERBench",
      path: "results/scores.csv",
      name: "scores.csv",
    })
  })

  test("closes artifact context when its active artifact disappears", () => {
    const state = createContextState({ storage: memoryStorage() })

    state.openContext("artifact")
    expect(state.open()).toBe(true)

    state.syncArtifact(true)
    expect(state.open()).toBe(true)

    state.syncArtifact(false)

    expect(state.context()).toBe("artifact")
    expect(state.open()).toBe(false)
  })

  test("returns to an existing tool tab when artifact ownership disappears", () => {
    const state = createContextState({ storage: memoryStorage() })

    state.openContext("files")
    state.openContext("artifact")
    state.syncArtifact(false)

    expect(state.workTabs().map((tab) => tab.id)).toEqual(["view:files"])
    expect(state.activeWorkTab()).toBe("view:files")
    expect(state.context()).toBe("files")
    expect(state.open()).toBe(true)
  })

  test("exposes contextual visibility alongside the legacy pane accessor", () => {
    const store = uiStore as typeof uiStore & { open?: () => boolean }

    expect(store.open).toBeFunction()
    expect(store.open?.()).toBe(store.rightPaneOpen())
  })
})

describe("evidence surface removal", () => {
  test("drops the retired evidence tab from persisted state and falls back to files", () => {
    const scope = workspaceScope("project-a", "session-a")
    const storage = memoryStorage({
      "openscience-context-state-v2": JSON.stringify({
        version: 2,
        scopes: { [scope]: { tab: "evidence", mode: "tools", open: true } },
      }),
    })
    const state = createContextState({ storage })
    state.activateScope("project-a", "session-a")

    expect(state.context()).toBe("files")
    expect(state.open()).toBe(true)
  })

  test("has deleted the Evidence pane component and its evidence-only helper module", async () => {
    const graph = fileURLToPath(new URL("../EvidenceGraph.tsx", import.meta.url))
    const helper = fileURLToPath(new URL("../../provenance/run.ts", import.meta.url))

    expect(await Bun.file(graph).exists()).toBe(false)
    expect(await Bun.file(helper).exists()).toBe(false)
  })
})

describe("open-file tabs", () => {
  test("keeps one collection and file tabs in one restorable work strip", () => {
    const storage = memoryStorage()
    const first = createContextState({ storage })
    first.activateScope("project-a", "session-a")

    first.openContext("terminal")
    first.openContext("kernels")
    first.openFile("/root", "results.csv")

    expect(first.workTabs().map((tab) => tab.id)).toEqual([
      "view:terminal",
      "view:kernels",
      "view:files",
      "file:%2Froot:results.csv",
    ])
    expect(first.activeWorkTab()).toBe("file:%2Froot:results.csv")

    const restored = createContextState({ storage })
    restored.activateScope("project-a", "session-a")
    expect(restored.workTabs().map((tab) => tab.id)).toEqual(first.workTabs().map((tab) => tab.id))
    expect(restored.activeWorkTab()).toBe("file:%2Froot:results.csv")
    expect(restored.file()?.path).toBe("results.csv")
  })

  test("keeps tool panels as tabs and returns to a neighbor when one closes", () => {
    const storage = memoryStorage()
    const state = createContextState({ storage })
    state.activateScope("project-a", "session-a")
    state.openContext("files")
    state.openContext("terminal")
    state.openContext("kernels")

    expect(state.workTabs().map((tab) => tab.id)).toEqual(["view:files", "view:terminal", "view:kernels"])
    state.closeWorkTab()
    expect(state.workTabs().map((tab) => tab.id)).toEqual(["view:files", "view:terminal"])
    expect(state.activeWorkTab()).toBe("view:terminal")
    expect(state.context()).toBe("terminal")
    expect(state.open()).toBe(true)

    const restored = createContextState({ storage })
    restored.activateScope("project-a", "session-a")
    expect(restored.workTabs().map((tab) => tab.id)).toEqual(["view:files", "view:terminal"])
    expect(restored.activeWorkTab()).toBe("view:terminal")
  })

  test("work tab activation and reordering are keyboard-strip primitives", () => {
    const state = createContextState({ storage: memoryStorage() })
    state.activateScope("project-a", "session-a")
    state.openFile("/root", "a.md")
    state.openFile("/root", "b.md")

    state.moveWorkTab("file:%2Froot:b.md", 1)
    expect(state.workTabs().map((tab) => tab.id)).toEqual(["view:files", "file:%2Froot:b.md", "file:%2Froot:a.md"])

    state.activateWorkTab("file:%2Froot:a.md")
    expect(state.context()).toBe("files")
    expect(state.activeWorkTab()).toBe("file:%2Froot:a.md")
  })

  test("opening files accumulates tabs, activates the newest, and dedupes", () => {
    const state = createContextState({ storage: memoryStorage() })
    state.activateScope("project-a", "session-a")

    state.openFile("/root", "a.md")
    state.openFile("/root", "b.csv")
    state.openFile("/root", "a.md")

    expect(state.files().map((file) => file.path)).toEqual(["a.md", "b.csv"])
    expect(state.file()?.path).toBe("a.md")
  })

  test("closing the active tab activates a neighbor; closing by path keeps the active file", () => {
    const state = createContextState({ storage: memoryStorage() })
    state.activateScope("project-a", "session-a")
    state.openFile("/root", "a.md")
    state.openFile("/root", "b.csv")
    state.openFile("/root", "c.txt")

    state.closeFile("a.md")
    expect(state.files().map((file) => file.path)).toEqual(["b.csv", "c.txt"])
    expect(state.file()?.path).toBe("c.txt")

    state.closeFile()
    expect(state.files().map((file) => file.path)).toEqual(["b.csv"])
    expect(state.file()?.path).toBe("b.csv")
  })

  test("activate and move operate on the strip; unknown paths are ignored", () => {
    const state = createContextState({ storage: memoryStorage() })
    state.activateScope("project-a", "session-a")
    state.openFile("/root", "a.md")
    state.openFile("/root", "b.csv")
    state.openFile("/root", "c.txt")

    state.activateFile("a.md")
    expect(state.file()?.path).toBe("a.md")

    state.moveFile("c.txt", 0)
    expect(state.files().map((file) => file.path)).toEqual(["c.txt", "a.md", "b.csv"])

    state.activateFile("missing.md")
    state.moveFile("missing.md", 0)
    expect(state.file()?.path).toBe("a.md")
    expect(state.files().map((file) => file.path)).toEqual(["c.txt", "a.md", "b.csv"])
  })

  test("opening a ninth file never silently evicts an existing editor", () => {
    const state = createContextState({ storage: memoryStorage() })
    state.activateScope("project-a", "session-a")
    for (let index = 0; index < 9; index++) state.openFile("/root", `file-${index}.md`)

    expect(state.files()).toHaveLength(9)
    expect(state.file()?.path).toBe("file-8.md")
    expect(state.files().some((file) => file.path === "file-0.md")).toBe(true)
    expect(state.workTabs().filter((tab) => tab.kind === "file")).toHaveLength(9)
  })

  test("tabs persist per scope and returning to Files keeps them with no active file", () => {
    const storage = memoryStorage()
    const first = createContextState({ storage })
    first.activateScope("project-a", "session-a")
    first.openFile("/root", "a.md")
    first.openFile("/root", "b.csv")
    first.openContext("files")
    expect(first.file()).toBeUndefined()
    expect(first.files().map((file) => file.path)).toEqual(["a.md", "b.csv"])

    const restored = createContextState({ storage })
    restored.activateScope("project-a", "session-a")
    expect(restored.files().map((file) => file.path)).toEqual(["a.md", "b.csv"])

    restored.activateScope("project-b", "session-b")
    expect(restored.files()).toHaveLength(0)
  })

  test("saved artifacts share the work strip and restore without depending on their source file", () => {
    const storage = memoryStorage()
    const first = createContextState({ storage })
    first.activateScope("project-a", "session-a")
    first.openFile("/root", "notes.md")
    first.openSaved(saved())

    expect(first.context()).toBe("files")
    expect(first.file()).toBeUndefined()
    expect(first.saved()?.id).toBe("art_test")
    expect(first.activeWorkTab()).toBe("saved:art_test")

    const restored = createContextState({ storage })
    restored.activateScope("project-a", "session-a")
    expect(restored.saved()?.current.sha256).toBe("a".repeat(64))
    expect(restored.workTabs().map((tab) => tab.id)).toContain("saved:art_test")

    restored.closeWorkTab()
    expect(restored.file()?.path).toBe("notes.md")
  })

  test("updates a renamed saved artifact in the active tab without duplicating it", () => {
    const state = createContextState({ storage: memoryStorage() })
    state.activateScope("project-a", "session-a")
    state.openSaved(saved())
    state.updateSaved({ ...saved(), title: "Renamed result", updatedAt: 3 })

    expect(state.workTabs().filter((tab) => tab.id === "saved:art_test")).toHaveLength(1)
    expect(state.saved()?.title).toBe("Renamed result")
  })
})
