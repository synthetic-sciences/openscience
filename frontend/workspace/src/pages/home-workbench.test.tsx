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
      name: "Gateway",
      worktree: "/Users/aayam/Research/gateway",
      time: { created: Date.now() - 172_800_000, activity: Date.now() - 86_400_000 },
      updatedAt: Date.now() - 86_400_000,
      pinned: false,
      sessions: 4,
    },
  ],
  archivedProjects: [],
  totalProjects: 1,
  query: "",
  serverName: "Local server",
  serverStatus: "healthy" as const,
  onQuery: (_value: string) => {},
  onOpen: (_project: { id: string }) => {},
  onPin: (_project: { id: string }) => {},
  onArchive: (_project: { id: string }) => {},
  onRestore: (_project: { id: string }) => {},
  onCreate: () => {},
  onRetry: () => {},
  onSettings: () => {},
  onServer: () => {},
}

describe("ProjectsWorkbench", () => {
  test("refreshes activity labels when returning to the app without changing project data", async () => {
    const original = Date.now
    const now = original()
    Date.now = () => now
    try {
      const host = mount(() =>
        subject.ProjectsWorkbench({
          ...props,
          projects: [
            {
              ...props.projects[0],
              time: { created: now - 172_800_000, activity: now - 86_400_000 },
              updatedAt: now - 86_400_000,
            },
          ],
        }),
      )
      await Promise.resolve()
      expect(host.querySelector("time")?.textContent).toContain("1 day")
      Date.now = () => now + 172_800_000
      document.dispatchEvent(new Event("visibilitychange"))
      expect(host.querySelector("time")?.textContent).toContain("3 days")
    } finally {
      Date.now = original
    }
  })

  test("uses creation rather than edit language when no research activity is recorded", () => {
    const host = mount(() =>
      subject.ProjectsWorkbench({
        ...props,
        projects: [{ ...props.projects[0], time: { created: props.projects[0].updatedAt } }],
      }),
    )
    expect(host.querySelector("time")?.textContent).toContain("Created")
    expect(host.querySelector("time")?.textContent).not.toContain("Edited")
  })

  test("renders a useful project row and opens the selected project", async () => {
    const opened: string[] = []
    const host = mount(() => subject.ProjectsWorkbench({ ...props, onOpen: (project) => opened.push(project.id) }))
    const row = host.querySelector<HTMLButtonElement>('[data-project="prj_atlas"]')

    expect(host.querySelector("h1")?.textContent).toBe("Projects")
    expect(host.textContent).toContain("Research workspaces, sessions, and files in one place.")
    expect(row?.textContent).toContain("Gateway")
    expect(row?.textContent).not.toContain("Local project")
    expect(row?.textContent).toContain("4 sessions")
    expect(row?.textContent).toContain("Active")
    expect(row?.textContent).not.toContain("Edited")
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
      search.value = "gateway"
      search.dispatchEvent(new InputEvent("input", { bubbles: true }))
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    }

    expect(queries).toEqual(["gateway", ""])
    expect(search?.closest(".science-home__toolbar")).toBeTruthy()
    expect(host.querySelector(".science-home__bar input")).toBeNull()
    expect(host.querySelector('button[aria-label="New project"]')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Import existing folder"]')).toBeNull()
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

    const filtered = mount(() => subject.ProjectsWorkbench({ ...props, totalProjects: 43, query: "gateway" }))
    expect(filtered.querySelector(".science-home__results-summary")?.textContent).toBe("1 of 43 projects")
  })

  test("exposes independent pin and archive controls without opening the project", async () => {
    const calls: string[] = []
    const host = mount(() =>
      subject.ProjectsWorkbench({
        ...props,
        projects: [{ ...props.projects[0], pinned: true }],
        onOpen: (project) => calls.push(`open:${project.id}`),
        onPin: (project) => calls.push(`pin:${project.id}`),
        onArchive: (project) => calls.push(`archive:${project.id}`),
      }),
    )

    host.querySelector<HTMLButtonElement>('button[aria-label="Unpin Gateway"]')?.click()
    host.querySelector<HTMLButtonElement>('button[aria-label="Archive Gateway"]')?.click()

    expect(host.querySelector('[data-pinned="true"]')).toBeTruthy()
    expect(calls).toEqual(["pin:prj_atlas", "archive:prj_atlas"])
  })

  test("discloses archived projects and restores them without exposing their path", async () => {
    const restored: string[] = []
    const host = mount(() =>
      subject.ProjectsWorkbench({
        ...props,
        archivedProjects: [
          {
            ...props.projects[0],
            id: "prj_archived",
            name: "Archived study",
            worktree: "/Users/aayam/Research/private-path",
            time: { created: 1, archived: 2 },
          },
        ],
        onRestore: (project) => restored.push(project.id),
      }),
    )

    expect(host.querySelector(".science-home__archived")?.textContent).toContain("Archived")
    expect(host.textContent).toContain("Archived study")
    expect(host.textContent).not.toContain("/Users/aayam")
    host.querySelector<HTMLButtonElement>(".science-home__archived button")?.click()
    expect(restored).toEqual(["prj_archived"])
  })

  test("keeps an archived-only home recoverable instead of calling it a search miss", async () => {
    const host = mount(() =>
      subject.ProjectsWorkbench({
        ...props,
        projects: [],
        totalProjects: 0,
        archivedProjects: [{ ...props.projects[0], time: { created: 1, archived: 2 } }],
      }),
    )

    expect(host.textContent).toContain("No active projects")
    expect(host.textContent).not.toContain("No matching projects")
    expect(host.querySelector(".science-home__archived")).toBeTruthy()
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
      }),
    )
    empty.querySelector<HTMLButtonElement>('button[aria-label="New project"]')?.click()
    expect(empty.querySelector(".science-home__state")?.textContent).toContain("No projects yet")
    expect(empty.querySelector('[aria-label="Import existing folder"]')).toBeNull()
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

    expect(calls).toEqual(["create", "query:"])
  })
})
