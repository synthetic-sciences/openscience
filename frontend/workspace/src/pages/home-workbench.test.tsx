import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const style = fileURLToPath(new URL("./home-workbench.css", import.meta.url))
const cleanups: Array<() => void> = []
const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
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
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/pages/home-workbench.tsx") as Promise<typeof import("./home-workbench")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])

afterAll(() => server.close())

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

const props = {
  state: "recent" as const,
  projects: [
    {
      id: "prj_atlas",
      name: "Atlas",
      worktree: "/Users/aayam/Research/atlas",
      time: { created: Date.now() - 86_400_000 },
      updatedAt: Date.now() - 86_400_000,
      pinned: false,
      sessions: 4,
    },
  ],
  query: "",
  home: "/Users/aayam",
  dark: true,
  serverName: "Local server",
  serverStatus: "healthy" as const,
  onQuery: (_value: string) => {},
  onOpen: (_project: { id: string }) => {},
  onPin: (_project: { id: string }) => {},
  onRemove: (_project: { id: string }) => {},
  onCreate: () => {},
  onImport: () => {},
  onRetry: () => {},
  onTheme: () => {},
  onSettings: () => {},
  onServer: () => {},
}

describe("ProjectsWorkbench", () => {
  test("renders the compact project list and opens a selected project", async () => {
    const opened: string[] = []
    const host = mount(() => subject.ProjectsWorkbench({ ...props, onOpen: (project) => opened.push(project.id) }))
    const row = host.querySelector<HTMLButtonElement>('[data-project="prj_atlas"]')

    expect(host.querySelector("h1")?.textContent).toBe("Projects")
    expect(host.textContent).toContain("Recent research, files, and sessions.")
    expect(host.textContent).not.toContain("Continue your research")
    expect(row?.textContent).toContain("Atlas")
    expect(row?.textContent).toContain("Local project")
    expect(row?.textContent).toContain("4 sessions")
    expect(row?.querySelector("time")?.dateTime).toBeTruthy()
    row?.click()
    expect(host.textContent).not.toContain("/Users/aayam")
    expect(opened).toEqual(["prj_atlas"])
  })

  test("keeps search keyboard-accessible and wires the app-bar actions", async () => {
    const queries: string[] = []
    const host = mount(() => subject.ProjectsWorkbench({ ...props, onQuery: (query) => queries.push(query) }))
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search projects"]')
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-controls="science-home-project-search"]')

    toggle?.click()
    expect(toggle?.getAttribute("aria-controls")).toBe(search?.id)

    if (search) {
      search.value = "atlas"
      search.dispatchEvent(new InputEvent("input", { bubbles: true }))
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    }

    expect(queries).toEqual(["atlas", ""])
    expect(host.querySelector('button[aria-label="New project"]')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Import existing folder"]')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Toggle theme"]')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Settings"]')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Local server"]')).toBeTruthy()
  })

  test("exposes independent pin and remove controls without opening the project", async () => {
    const calls: string[] = []
    const host = mount(() =>
      subject.ProjectsWorkbench({
        ...props,
        projects: [{ ...props.projects[0], pinned: true }],
        onOpen: (project) => calls.push(`open:${project.id}`),
        onPin: (project) => calls.push(`pin:${project.id}`),
        onRemove: (project) => calls.push(`remove:${project.id}`),
      }),
    )

    host.querySelector<HTMLButtonElement>('button[aria-label="Unpin Atlas"]')?.click()
    host.querySelector<HTMLButtonElement>('button[aria-label="Remove Atlas from home"]')?.click()

    expect(host.querySelector('[data-pinned="true"]')).toBeTruthy()
    expect(calls).toEqual(["pin:prj_atlas", "remove:prj_atlas"])
  })

  test("keeps loading, error, empty, and no-match recovery explicit", async () => {
    const calls: string[] = []
    const loading = mount(() => subject.ProjectsWorkbench({ ...props, state: "loading", projects: [] }))
    expect(loading.querySelector('[role="status"]')?.textContent).toContain("Loading projects")
    cleanups.pop()?.()
    loading.remove()

    const error = mount(() =>
      subject.ProjectsWorkbench({
        ...props,
        state: "error",
        projects: [],
        onRetry: () => calls.push("retry"),
      }),
    )
    expect(error.querySelector('[role="alert"]')?.textContent).toContain("Try again")
    cleanups.pop()?.()
    error.remove()

    const empty = mount(() =>
      subject.ProjectsWorkbench({
        ...props,
        state: "empty",
        projects: [],
        onCreate: () => calls.push("create"),
        onImport: () => calls.push("import"),
      }),
    )
    const emptyActions = Array.from(empty.querySelectorAll<HTMLButtonElement>(".science-home__state button"))
    emptyActions.forEach((button) => button.click())
    expect(empty.querySelector(".science-home__state")?.textContent).toContain("Create project")
    expect(empty.querySelector(".science-home__state")?.textContent).toContain("Import existing folder")
    cleanups.pop()?.()
    empty.remove()

    const missing = mount(() =>
      subject.ProjectsWorkbench({
        ...props,
        projects: [],
        query: "missing",
        onQuery: (query) => calls.push(`query:${query}`),
      }),
    )
    expect(missing.textContent).toContain("No matching projects")
    Array.from(missing.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Clear search"))
      ?.click()

    expect(calls).toEqual(["create", "import", "query:"])
  })

  test("locks the screen to the compact sizing contract", async () => {
    const css = await Bun.file(style).text()

    expect(css).toContain("min-height: 48px")
    expect(css).toContain("font-size: 17px")
    expect(css).toContain("min-height: 46px")
    expect(css).toContain("font-size: 13px")
    expect(css).toContain("@media (max-width: 720px)")
    expect(css).toContain("@media (prefers-reduced-transparency: reduce)")
    expect(css).toContain("@media (prefers-contrast: more)")
  })
})
