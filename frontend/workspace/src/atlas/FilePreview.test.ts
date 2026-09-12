import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { FileData } from "./file-viewer"
import type { FileView } from "./FilePreview"

const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const solidjs = (await server.ssrLoadModule("solid-js")) as typeof import("solid-js")
const web = (await server.ssrLoadModule("solid-js/web")) as typeof import("solid-js/web")
const marked = (await server.ssrLoadModule("@synsci/ui/context/marked")) as typeof import("@synsci/ui/context/marked")
const subject = (await server.ssrLoadModule("/src/atlas/FilePreview.tsx")) as typeof import("./FilePreview")
const drafts = (await server.ssrLoadModule("/src/atlas/file-drafts.ts")) as typeof import("./file-drafts")
const codemirror = (await server.ssrLoadModule("@codemirror/view")) as typeof import("@codemirror/view")
const cleanups: Array<() => void> = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const file = (content: string, revision?: string): FileData => ({ content, revision, mimeType: "text/html" })
const pending = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => (resolve = complete))
  return { promise, resolve }
}
type Services = NonNullable<Parameters<typeof FileView>[0]["services"]>
const services = (
  read: (path: string) => FileData | Promise<FileData>,
  write: (path: string, init?: RequestInit) => Promise<Response> = async () => json({}),
): Services => ({
  url: "http://server-a.test",
  projectID: "project-a",
  client: { file: { read: async ({ path }: { path: string }) => ({ data: await read(path) }) } } as Services["client"],
  request: Object.assign(write, { url: (path: string) => `http://server-a.test${path}` }) as Services["request"],
})
const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = web.render(
    () =>
      marked.MarkedProvider({
        get children() {
          return view()
        },
      }),
    host,
  )
  cleanups.push(dispose)
  return { host, dispose }
}
const button = (host: HTMLElement, label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
const editor = async (host: HTMLElement) => {
  if (!host.querySelector(".cm-editor")) button(host, "Edit")?.click()
  for (let i = 0; i < 30 && !host.querySelector(".cm-editor"); i++) await settle()
  const node = host.querySelector<HTMLElement>(".cm-editor")
  expect(node).not.toBeNull()
  return codemirror.EditorView.findFromDOM(node!)!
}
const edit = async (host: HTMLElement, content: string) => {
  const view = await editor(host)
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
  await settle()
  return view
}

afterAll(() => server.close())
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  drafts.discardAllFileDrafts()
  document.body.replaceChildren()
})

describe("local notebook documents", () => {
  test("runs only the selected chunk with session ownership, shows failures, and ignores late results after navigation", async () => {
    const response = pending<Response>()
    const calls: unknown[] = []
    const [path, setPath] = solidjs.createSignal("first.qmd")
    const sdk = services(
      () => file("```{python}\nvalue + 1\n```", "rev-1"),
      async (route, init) => {
        calls.push({ route, body: JSON.parse(String(init?.body)) })
        return calls.length === 1 ? json({ message: "Project must be trusted" }, 403) : response.promise
      },
    )
    const { host } = mount(() =>
      subject.FileView({
        get path() {
          return path()
        },
        directory: "/project",
        sessionID: "session-a",
        services: sdk,
      }),
    )
    await settle()
    button(host, "Run cell 1 in Python")!.click()
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Project must be trusted")
    expect(calls).toEqual([
      {
        route: "/kernels/execute",
        body: {
          sessionID: "session-a",
          language: "python",
          code: "value + 1",
          source: "/project/first.qmd#cell-1",
          timeout: 60000,
        },
      },
    ])
    button(host, "Run cell 1 in Python")!.click()
    expect(button(host, "Run cell 1 in Python")?.disabled).toBe(true)
    setPath("second.qmd")
    await settle()
    response.resolve(json({ ok: true, execution_count: 2, outputs: [{ output_type: "stream", text: "OLD RESULT" }] }))
    await settle()
    expect(host.textContent).not.toContain("OLD RESULT")
    expect(host.textContent).not.toContain("Project must be trusted")
    expect(button(host, "Run cell 1 in Python")?.disabled).toBe(false)
  })

  test("renders a completed R chunk result without writing the source file", async () => {
    const calls: string[] = []
    const { host } = mount(() =>
      subject.FileView({
        path: "report.Rmd",
        directory: "/project",
        sessionID: "session-a",
        services: services(
          () => file("```{r}\nmean(c(1, 2, 3))\n```", "rev-1"),
          async (route, init) => {
            calls.push(route)
            expect(JSON.parse(String(init?.body)).language).toBe("r")
            if (calls.length === 1) return json({ message: "Interpreter unavailable" }, 400)
            return json({ ok: true, execution_count: 1, outputs: [{ output_type: "stream", text: "[1] 2" }] })
          },
        ),
      }),
    )
    await settle()
    button(host, "Run cell 1 in R")!.click()
    await settle()
    expect(host.textContent).toContain("Interpreter unavailable")
    button(host, "Run cell 1 in R")!.click()
    await settle()
    expect(host.textContent).not.toContain("Interpreter unavailable")
    expect(host.textContent).toContain("[1] 2")
    expect(host.textContent).toContain("Run output · not saved")
    expect(calls).toEqual(["/kernels/execute", "/kernels/execute"])
    expect(button(host, "Save changes")).toBeNull()
  })

  test("keeps invalid JSON editable and disables execution without a session", async () => {
    const { host } = mount(() =>
      subject.FileView({ path: "broken.ipynb", directory: "/project", services: services(() => file("{", "rev-1")) }),
    )
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not be previewed")
    expect((await editor(host)).state.doc.toString()).toBe("{")
    await edit(host, JSON.stringify({ nbformat: 4, cells: [{ cell_type: "code", source: "1 + 1" }] }))
    button(host, "Preview")!.click()
    await settle()
    expect(button(host, "Run cell 1 in Python")?.disabled).toBe(true)
  })

  test("opens Jupyter cells and saved outputs as a document without executing them", async () => {
    const calls: string[] = []
    const content = JSON.stringify({
      nbformat: 4,
      metadata: { kernelspec: { language: "python" } },
      cells: [
        { cell_type: "markdown", source: ["# Experiment\n", "A **rendered** notebook."] },
        {
          cell_type: "code",
          source: ["print(42)"],
          execution_count: 7,
          outputs: [{ output_type: "stream", name: "stdout", text: ["42\n"] }],
        },
      ],
    })
    const { host } = mount(() =>
      subject.FileView({
        path: "analysis.ipynb",
        directory: "/project",
        sessionID: "session-a",
        services: services(
          () => file(content, "rev-1"),
          async (path) => {
            calls.push(path)
            return json({})
          },
        ),
      }),
    )
    await settle()
    expect(host.querySelector('[data-cell-type="markdown"] [data-component="markdown"]')).not.toBeNull()
    expect(host.querySelector('[data-cell-type="code"]')?.textContent).toContain("print(42)")
    expect(host.querySelector('[data-cell-type="code"]')?.textContent).toContain("42")
    expect(button(host, "Run cell 2 in Python")?.disabled).toBe(false)
    expect(calls).toEqual([])
  })

  test.each(["Rmd", "qmd"])("opens %s prose and R chunks as a document", async (extension) => {
    const content = "# Report\n\nA **rendered** document.\n\n```{r summary}\nmean(c(1, 2, 3))\n```\n"
    const { host } = mount(() =>
      subject.FileView({
        path: `analysis.${extension}`,
        directory: "/project",
        sessionID: "session-a",
        services: services(() => file(content, "rev-1")),
      }),
    )
    await settle()
    expect(host.querySelector('[data-cell-type="markdown"] [data-component="markdown"]')).not.toBeNull()
    expect(host.querySelector('[data-cell-type="code"]')?.textContent).toContain("mean(c(1, 2, 3))")
    expect(button(host, "Run cell 2 in R")?.disabled).toBe(false)
  })
})

describe("file preview save ownership", () => {
  test("sends the read revision and preserves typing during the save", async () => {
    const save = pending<Response>()
    const writes: unknown[] = []
    const sdk = services(
      () => file("<h1>disk</h1>", "rev-1"),
      async (_path, init) => {
        writes.push(JSON.parse(String(init?.body)))
        return save.promise
      },
    )
    const { host } = mount(() =>
      subject.FileView({ path: "note.html", directory: "/project", sessionID: "session-a", services: sdk }),
    )
    await settle()
    await edit(host, "<h1>first edit</h1>")
    button(host, "Save changes")!.click()
    await edit(host, "<h1>typed while saving</h1>")
    expect(writes).toEqual([
      { path: "/project/note.html", content: "<h1>first edit</h1>", sessionID: "session-a", expectedRevision: "rev-1" },
    ])
    save.resolve(json(file("<h1>first edit</h1>", "rev-2")))
    await settle()
    expect((await editor(host)).state.doc.toString()).toBe("<h1>typed while saving</h1>")
    expect(button(host, "Save changes")?.disabled).toBe(false)
    expect(
      drafts.recoverFileDraftState("/project", "note.html", "", undefined, "session-a", undefined, sdk.url),
    ).toEqual({ draft: "<h1>typed while saving</h1>", saved: "<h1>first edit</h1>", revision: "rev-2" })
  })

  test("preserves a conflicting draft and original revision across remount until explicit discard", async () => {
    let disk = file("<h1>disk</h1>", "rev-1")
    const writes: unknown[] = []
    const sdk = services(
      () => disk,
      async (_path, init) => {
        writes.push(JSON.parse(String(init?.body)))
        disk = file("<h1>changed on disk</h1>", "rev-2")
        return json({ message: "File changed on disk" }, 409)
      },
    )
    const props = { path: "note.html", directory: "/project", sessionID: "session-a", services: sdk }
    const first = mount(() => subject.FileView(props))
    await settle()
    await edit(first.host, "<h1>my unsaved edit</h1>")
    button(first.host, "Save changes")!.click()
    await settle()
    expect(first.host.textContent).toContain("Your edits are preserved")
    expect(button(first.host, "Save changes")?.disabled).toBe(true)
    first.dispose()
    first.host.remove()
    const second = mount(() => subject.FileView(props))
    await settle()
    expect((await editor(second.host)).state.doc.toString()).toBe("<h1>my unsaved edit</h1>")
    expect(button(second.host, "Save changes")?.disabled).toBe(true)
    expect(
      drafts.recoverFileDraftState("/project", "note.html", "", undefined, "session-a", undefined, sdk.url).revision,
    ).toBe("rev-1")
    await edit(second.host, "<h1>still editing</h1>")
    expect(second.host.textContent).toContain("Your edits are preserved")
    expect(writes).toHaveLength(1)
    const discard = [...second.host.querySelectorAll("button")].find(
      (item) => item.textContent === "Discard changes and reload",
    )!
    discard.click()
    await settle()
    expect((await editor(second.host)).state.doc.toString()).toBe("<h1>changed on disk</h1>")
    expect(second.host.querySelector('[role="alert"]')).toBeNull()
  })

  test("does not send an unversioned overwrite and explains the disabled save", async () => {
    const writes: string[] = []
    const sdk = services(
      () => file("<h1>disk</h1>"),
      async (path) => {
        writes.push(path)
        return json({})
      },
    )
    const { host } = mount(() =>
      subject.FileView({ path: "note.html", directory: "/project", sessionID: "session-a", services: sdk }),
    )
    await settle()
    await edit(host, "<h1>my edit</h1>")
    expect(button(host, "Save changes")?.disabled).toBe(true)
    expect(host.textContent).toContain("server did not provide a file revision")
    expect(writes).toEqual([])
  })

  test("late save completion only settles its original file draft after navigation", async () => {
    const save = pending<Response>()
    const [path, setPath] = solidjs.createSignal("first.html")
    const sdk = services(
      (path) =>
        file(
          path.includes("first") ? "<h1>first</h1>" : "<h1>second</h1>",
          path.includes("first") ? "first-1" : "second-1",
        ),
      async () => save.promise,
    )
    const { host } = mount(() =>
      subject.FileView({
        get path() {
          return path()
        },
        directory: "/project",
        sessionID: "session-a",
        services: sdk,
      }),
    )
    await settle()
    await edit(host, "<h1>first edit</h1>")
    button(host, "Save changes")!.click()
    setPath("second.html")
    await settle()
    await edit(host, "<h1>second edit</h1>")
    save.resolve(json(file("<h1>first edit</h1>", "first-2")))
    await settle()
    expect((await editor(host)).state.doc.toString()).toBe("<h1>second edit</h1>")
    expect(
      drafts.recoverFileDraftState("/project", "second.html", "", undefined, "session-a", undefined, sdk.url),
    ).toEqual({ draft: "<h1>second edit</h1>", saved: "<h1>second</h1>", revision: "second-1" })
    expect(
      drafts.recoverFileDraftState(
        "/project",
        "first.html",
        "<h1>first edit</h1>",
        undefined,
        "session-a",
        "first-2",
        sdk.url,
      ).draft,
    ).toBe("<h1>first edit</h1>")
  })

  test("late reads and identical paths on another server cannot inherit the old draft", async () => {
    const late = pending<FileData>()
    const [url, setUrl] = solidjs.createSignal("http://server-a.test")
    let reads = 0
    const sdk = services(() => {
      reads++
      return url().includes("server-a") ? late.promise : file("<h1>server B</h1>", "b-1")
    })
    Object.defineProperty(sdk, "url", { get: url })
    const { host } = mount(() =>
      subject.FileView({ path: "note.html", directory: "/project", sessionID: "session-a", services: sdk }),
    )
    await settle()
    setUrl("http://server-b.test")
    await settle()
    await edit(host, "<h1>B edit</h1>")
    late.resolve(file("<h1>server A</h1>", "a-1"))
    await settle()
    expect(reads).toBe(2)
    expect((await editor(host)).state.doc.toString()).toBe("<h1>B edit</h1>")
    expect(
      drafts.recoverFileDraftState(
        "/project",
        "note.html",
        "<h1>server A</h1>",
        undefined,
        "session-a",
        "a-1",
        "http://server-a.test",
      ).draft,
    ).toBe("<h1>server A</h1>")
    expect(
      drafts.recoverFileDraftState(
        "/project",
        "note.html",
        "",
        undefined,
        "session-a",
        undefined,
        "http://server-b.test",
      ).revision,
    ).toBe("b-1")
  })
})

describe("chat project preview resolution", () => {
  type Read = { path: string; sessionID?: string; projectPreview?: string }
  const denied = (path: string) => ({
    name: "SessionFilesystemDeniedError",
    data: { path, sessionID: "session-a", access: "read" },
  })
  const setup = (
    read: (input: Read) => Promise<FileData>,
    resolve: (query: Record<string, unknown>) => Promise<Response>,
  ) => ({
    ...services(() => file("unused")),
    client: { file: { read: async (input: Read) => ({ data: await read(input) }) } } as Services["client"],
    request: Object.assign(
      async (path: string, _init: unknown, query: Record<string, unknown>) => {
        expect(path).toBe("/file/resolve")
        return resolve(query)
      },
      {
        url: (path: string, query: Record<string, string>) =>
          `http://server-a.test${path}?${new URLSearchParams(query)}`,
      },
    ) as Services["request"],
  })

  for (const absolute of [false, true]) {
    test(`recovers a ${absolute ? "absolute" : "relative"} project link only after broker verification`, async () => {
      const reads: Read[] = []
      const resolutions: Record<string, unknown>[] = []
      const path = "/project/COST_MODEL.md"
      const sdk = setup(
        async (input) => {
          reads.push(input)
          if (!input.path.startsWith("/")) throw new Error("File not found")
          if (!input.projectPreview) throw denied(input.path)
          return { content: "# Managed fixture", mimeType: "text/markdown" }
        },
        async (query) => {
          resolutions.push(query)
          return json({ path, writable: false, scope: "project" })
        },
      )
      const { host } = mount(() =>
        subject.FileView({
          path: absolute ? path : "COST_MODEL.md",
          directory: "/project",
          scope: "auto",
          sessionID: "session-a",
          writable: true,
          services: sdk,
        }),
      )
      await settle()
      await settle()
      expect(host.querySelector('[aria-label="COST_MODEL.md preview"]')).not.toBeNull()
      expect(host.textContent).toContain("Project files · /project")
      expect(host.textContent).not.toContain("outside the active workspace")
      expect(reads).toEqual([
        ...(!absolute ? [{ path: "COST_MODEL.md", sessionID: "session-a" }] : []),
        { path, sessionID: "session-a" },
        { path, sessionID: "session-a", projectPreview: "true" },
      ])
      expect(resolutions).toEqual([
        { path: absolute ? path : "COST_MODEL.md", sessionID: "session-a", projectPreview: "true" },
      ])
      expect(button(host, "Save changes")).toBeNull()
      expect(button(host, "Edit")).toBeNull()
      expect(button(host, "Save as Result")).toBeNull()
      expect(button(host, "Copy contents")?.disabled).toBe(false)
      expect(button(host, "Download file")).not.toBeNull()
    })
  }

  test("never retries generic 403 or outside-project denial under project authority", async () => {
    for (const [path, error] of [
      ["/project/note.html", new Error("HTTP 403 Forbidden")],
      ["/other/note.html", denied("/other/note.html")],
    ] as const) {
      let resolves = 0
      const reads: Read[] = []
      const sdk = setup(
        async (input) => {
          reads.push(input)
          throw error
        },
        async () => {
          resolves++
          return json({ path, scope: "project" })
        },
      )
      const { host, dispose } = mount(() =>
        subject.FileView({ path, directory: "/project", scope: "auto", sessionID: "session-a", services: sdk }),
      )
      await settle()
      expect(reads).toEqual([{ path, sessionID: "session-a" }])
      expect(resolves).toBe(0)
      expect(host.textContent).not.toContain("unused")
      dispose()
      host.remove()
    }
  })

  test("a denied broker result stays denied, and a late result cannot cross session ownership", async () => {
    const resolution = pending<Response>()
    const [session, setSession] = solidjs.createSignal("session-a")
    const reads: Read[] = []
    const sdk = setup(
      async (input) => {
        reads.push(input)
        throw denied(input.path)
      },
      async (query) => (query.sessionID === "session-a" ? resolution.promise : json({ path: null, scope: null })),
    )
    const { host } = mount(() =>
      subject.FileView({
        path: "/project/note.html",
        directory: "/project",
        scope: "auto",
        get sessionID() {
          return session()
        },
        services: sdk,
      }),
    )
    await settle()
    setSession("session-b")
    await settle()
    resolution.resolve(json({ path: "/project/note.html", writable: false, scope: "project" }))
    await settle()
    expect(reads.every((read) => !read.projectPreview)).toBe(true)
    expect(host.textContent).toContain("outside the active workspace")
  })

  test("resets verified project authority on navigation and labels scratch distinctly", async () => {
    const [session, setSession] = solidjs.createSignal("session-a")
    const reads: Read[] = []
    const sdk = setup(
      async (input) => {
        reads.push(input)
        if (input.sessionID === "session-b" || input.projectPreview) return file("<h1>fixture</h1>")
        if (!input.path.startsWith("/")) throw new Error("File not found")
        throw denied(input.path)
      },
      async () => json({ path: "/project/note.html", scope: "project", writable: false }),
    )
    const { host } = mount(() =>
      subject.FileView({
        path: "note.html",
        directory: "/project",
        scope: "auto",
        get sessionID() {
          return session()
        },
        services: sdk,
      }),
    )
    await settle()
    expect(host.textContent).toContain("Project files · /project")
    setSession("session-b")
    await settle()
    expect(reads.filter((read) => read.sessionID === "session-b")).toEqual([
      { path: "note.html", sessionID: "session-b" },
    ])
    expect(host.textContent).toContain("Session scratch")
  })

  test("labels a separately connected file without adding project preview authority", async () => {
    const reads: Read[] = []
    const sdk = setup(
      async (input) => {
        reads.push(input)
        if (input.path !== "/connected/note.html") throw new Error("File not found")
        return file("<h1>fixture</h1>")
      },
      async () => json({ path: "/connected/note.html", scope: "session", writable: false }),
    )
    const { host } = mount(() =>
      subject.FileView({
        path: "note.html",
        directory: "/project",
        scope: "auto",
        sessionID: "session-a",
        services: sdk,
      }),
    )
    await settle()
    expect(host.textContent).toContain("Connected file · /connected")
    expect(reads.at(-1)).toEqual({ path: "/connected/note.html", sessionID: "session-a" })
    expect(reads.every((read) => !read.projectPreview)).toBe(true)
  })
})
