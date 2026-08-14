import { describe, expect, test } from "bun:test"

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

describe("project-ID navigation wiring", () => {
  test("configures the project SDK with the opaque capability", async () => {
    const [layout, sdk, global, request] = await Promise.all([
      read("./directory-layout.tsx"),
      read("../context/sdk.tsx"),
      read("../context/global-sync.tsx"),
      read("../utils/openscience-fetch.ts"),
    ])

    expect(layout).toContain("<SDKProvider directory={directory()} projectID={projectID()} scope={scope()}>")
    expect(layout).toContain("global.project.resolveID(projectID)")
    expect(sdk).toContain("projectID: projectID()")
    expect(sdk).toContain("createProjectRequest")
    expect(global).toContain('sdkFor("", projectID).project.current()')
    expect(request).toContain('headers.set("x-openscience-project"')
    expect(request).toContain('headers.set("x-openscience-directory"')
  })

  test("initializes the global model catalog without requiring a project SDK provider", async () => {
    const [providers, directory] = await Promise.all([read("../hooks/use-providers.ts"), read("../utils/base64.ts")])

    expect(providers).not.toContain("useSDK")
    expect(providers).toContain("if (!directory) return globalSync.data.provider")
    expect(providers).toContain("globalSync.child(directory, { projectID: currentProjectID() })")
    expect(directory).toContain("export function currentProjectID()")
    expect(directory).toContain("setActive({ directory, projectID })")
  })

  test("keeps chat drafts session-scoped and the mounted inspector project-scoped", async () => {
    const [session, tabs, prompt, comments, file, terminal, directory, app] = await Promise.all([
      read("./session.tsx"),
      read("../atlas/store/sessionTabs.ts"),
      read("../context/prompt.tsx"),
      read("../context/comments.tsx"),
      read("../context/file.tsx"),
      read("../context/terminal.tsx"),
      read("./directory-layout.tsx"),
      read("../app.tsx"),
    ])

    expect(session).toContain('const sessionKey = createMemo(() => `${sdk.scope}/${params.id ?? "new"}`)')
    expect(session).toContain("uiStore.activateScope(sdk.scope, id)")
    expect(session).toContain("const sessionTabs = createSessionTabs()")
    expect(session).toContain("sessionTabs.activateProject(scope)")
    expect(tabs).toContain('workspaceScope(project, "sessions")')
    expect(tabs).toContain('const STORAGE_KEY = "openscience-session-tabs-v1"')
    expect(prompt).toContain("load(sdk.scope, params.id)")
    expect(comments).toContain("load(sdk.scope, params.id)")
    expect(file).toContain('Persist.workspace(dir, "file-view"')
    expect(file).toContain("loadView(storage())")
    expect(file).not.toContain("loadView(storage(), params.id)")
    expect(terminal).toContain('Persist.workspace(dir, "terminal"')
    expect(terminal).toContain("createMemo(() => load(sdk.scope))")
    expect(terminal).not.toContain("load(sdk.scope, params.id)")
    expect(terminal).toContain("const session = currentSession()")
    expect(terminal).toContain("const client = sdk.client")
    expect(terminal).not.toContain("sdk.client.pty")
    expect(terminal).toContain("const owner = (id: string)")
    expect(await read("../components/terminal.tsx")).toContain("sdk.request.url(`/pty/${local.pty.id}/connect`)")
    expect(directory).toContain("<TerminalProvider>")
    expect(directory).toContain("<FileProvider>")
    expect(directory).toContain("<ProjectWorkspaceFrame")
    expect(directory).toContain('lazy(() => import("@/atlas/ProjectRightPane"))')
    expect(directory).toContain("<ProjectRightPane")
    expect(session).not.toContain("<RightPane")
    expect(app).not.toContain("<TerminalProvider>")
    expect(app).not.toContain("<FileProvider>")
  })

  test("does not create new base64-directory navigation links", async () => {
    const [home, palette, prompt, notification] = await Promise.all([
      read("./home.tsx"),
      read("../atlas/CommandPalette.tsx"),
      read("../components/prompt-input.tsx"),
      read("../context/notification.tsx"),
    ])

    for (const source of [home, palette, prompt, notification]) {
      expect(source).not.toContain("base64Encode(directory)")
    }
  })

  test("starts ordinary E2E sessions on canonical routes and keeps one legacy redirect check", async () => {
    const [fixtures, navigation] = await Promise.all([
      read("../../e2e/fixtures.ts"),
      read("../../e2e/navigation.spec.ts"),
    ])

    expect(fixtures).toContain("await use(projectSegment(project, directory))")
    expect(fixtures).toContain("await page.goto(projectPathname(slug, sessionID))")
    expect(fixtures).not.toContain("await page.goto(sessionPath(directory, sessionID))")
    expect(navigation).toContain("await page.goto(dirPath(directory))")
  })

  test("keeps linked-worktree sessions and file surfaces on the selected directory", async () => {
    const [explorer, tree, preview] = await Promise.all([
      read("../atlas/FileExplorer.tsx"),
      read("../atlas/OpenScienceFileTree.tsx"),
      read("../atlas/FilePreview.tsx"),
    ])

    expect(explorer).toContain(
      'const projectRoot = () => sdk.directory || sync.data.path.directory || sync.project?.worktree || ""',
    )
    expect(tree).toContain(
      'const directory = () => sdk.directory || sync.data.path.directory || sync.project?.worktree || ""',
    )
    expect(preview).toContain(
      'props.directory || sdk.directory || sync.data.path.directory || sync.project?.worktree || ""',
    )
  })
})
