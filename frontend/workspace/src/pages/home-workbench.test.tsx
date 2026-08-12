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
  totalProjects: 1,
  query: "",
  serverName: "Local server",
  serverStatus: "healthy" as const,
  onQuery: (_value: string) => {},
  onOpen: (_project: { id: string }) => {},
  onPin: (_project: { id: string }) => {},
  onRemove: (_project: { id: string }) => {},
  onCreate: () => {},
  onImport: () => {},
  onRetry: () => {},
  onSettings: () => {},
  onServer: () => {},
}

describe("ProjectsWorkbench", () => {
  test("renders a useful project row and opens the selected project", async () => {
    const opened: string[] = []
    const host = mount(() => subject.ProjectsWorkbench({ ...props, onOpen: (project) => opened.push(project.id) }))
    const row = host.querySelector<HTMLButtonElement>('[data-project="prj_atlas"]')

    expect(host.querySelector("h1")?.textContent).toBe("Projects")
    expect(host.textContent).toContain("Research workspaces, sessions, and files in one place.")
    expect(row?.textContent).toContain("Atlas")
    expect(row?.textContent).not.toContain("Local project")
    expect(row?.textContent).toContain("4 sessions")
    expect(row?.textContent).toContain("Edited")
    expect(row?.querySelector("time")?.dateTime).toBeTruthy()
    row?.click()
    expect(host.textContent).not.toContain("/Users/aayam")
    expect(opened).toEqual(["prj_atlas"])
  })

  test("keeps in-page search keyboard-accessible and separates global from project actions", async () => {
    const queries: string[] = []
    const host = mount(() => subject.ProjectsWorkbench({ ...props, onQuery: (query) => queries.push(query) }))
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search projects"]')

    if (search) {
      search.value = "atlas"
      search.dispatchEvent(new InputEvent("input", { bubbles: true }))
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    }

    expect(queries).toEqual(["atlas", ""])
    expect(search?.closest(".science-home__toolbar")).toBeTruthy()
    expect(host.querySelector(".science-home__bar input")).toBeNull()
    expect(host.querySelector('button[aria-label="New project"]')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Import existing folder"]')).toBeTruthy()
    expect(host.querySelector('button[aria-label*="Switch to"]')).toBeNull()
    expect(host.querySelector('button[aria-label="Settings"]')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Local server"]')).toBeTruthy()
    expect(host.querySelector("button.atlas-wordmark")).toBeNull()
    expect(host.querySelector('[role="img"][aria-label="OpenScience"]')).toBeTruthy()
    const wordmark = host.querySelector<HTMLElement>(".atlas-wordmark > span")
    expect(wordmark?.style.fontSize).toBe("14.5px")
    expect(wordmark?.style.fontWeight).toBe("var(--font-weight-emphasis)")
  })

  test("announces dynamic result counts without leaving a visual count badge", async () => {
    const total = mount(() => subject.ProjectsWorkbench({ ...props, totalProjects: 43 }))
    expect(total.querySelector(".science-home__results-summary")?.textContent).toBe("43 projects")
    expect(total.querySelector(".science-home__results-summary")?.classList.contains("sr-only")).toBe(true)
    expect(total.querySelector(".science-home__count")).toBeNull()
    cleanups.pop()?.()
    total.remove()

    const filtered = mount(() => subject.ProjectsWorkbench({ ...props, totalProjects: 43, query: "atlas" }))
    expect(filtered.querySelector(".science-home__results-summary")?.textContent).toBe("1 of 43 projects")
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
    empty.querySelector<HTMLButtonElement>('button[aria-label="New project"]')?.click()
    empty.querySelector<HTMLButtonElement>('button[aria-label="Import existing folder"]')?.click()
    expect(empty.querySelector(".science-home__state")?.textContent).toContain("No projects yet")
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

  test("keeps the widened, readable, responsive sizing contract", async () => {
    const css = await Bun.file(style).text()

    expect(css).toContain("width: min(100%, 1100px)")
    expect(css).toContain("font-size: 29px")
    expect(css).toContain("min-height: 66px")
    expect(css).toContain("font-size: 14.5px")
    expect(css).toContain("@media (max-width: 760px)")
    expect(css).toContain("@media (max-width: 520px)")
    expect(css).toContain("@media (pointer: coarse)")
    expect(css).toContain("@media (prefers-contrast: more)")
    expect(css).not.toContain(".science-home__count")
    expect(css).toContain(":focus-visible")
    expect(css).toContain(".science-home__project-action:active")
    expect(css).toContain("transform: scale(0.97)")
  })
})
