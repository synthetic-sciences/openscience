import { test as base, expect } from "@playwright/test"
import { projectPathname, projectSegment } from "../src/utils/project-route"
import { createSdk, getWorktree, promptSelector, serverUrl } from "./utils"

type TestFixtures = {
  sdk: ReturnType<typeof createSdk>
  gotoSession: (sessionID?: string) => Promise<void>
  openSession: (title?: string) => Promise<string>
}

type WorkerFixtures = {
  directory: string
  slug: string
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  directory: [
    async ({}, use) => {
      const directory = await getWorktree()
      await use(directory)
    },
    { scope: "worker" },
  ],
  // Session URLs carry the canonical project segment: the project id, plus a
  // `~<checksum>` suffix when the route points at a secondary worktree rather
  // than the primary one. Legacy base64 directory slugs are reserved for the
  // explicit redirect-compatibility spec.
  slug: [
    async ({ directory }, use) => {
      const sdk = createSdk(directory)
      const project = await sdk.project.current().then((result) => result.data)
      if (!project?.id) throw new Error(`Failed to resolve the current project from ${serverUrl}/project/current`)
      await use(projectSegment(project, directory))
    },
    { scope: "worker" },
  ],
  sdk: async ({ directory }, use) => {
    await use(createSdk(directory))
  },
  // Creates a real session and navigates to it. The Files, Compute, and
  // artifact surfaces are session-scoped, so specs exercising them need an
  // actual session id rather than the blank new-session canvas.
  openSession: async ({ sdk, gotoSession }, use) => {
    const created: string[] = []
    await use(async (title = `e2e session ${Date.now()}`) => {
      const session = await sdk.session.create({ title }).then((result) => result.data)
      if (!session?.id) throw new Error("Session create did not return an id")
      created.push(session.id)
      await gotoSession(session.id)
      return session.id
    })
    for (const id of created) await sdk.session.delete({ sessionID: id }).catch(() => undefined)
  },
  gotoSession: async ({ page, directory, slug }, use) => {
    await page.addInitScript(
      (input: { directory: string; serverUrl: string }) => {
        const key = "openscience.global.dat:server"
        const raw = localStorage.getItem(key)
        const parsed = (() => {
          if (!raw) return undefined
          try {
            return JSON.parse(raw) as unknown
          } catch {
            return undefined
          }
        })()

        const store = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
        const list = Array.isArray(store.list) ? store.list : []
        const lastProject = store.lastProject && typeof store.lastProject === "object" ? store.lastProject : {}
        const projects = store.projects && typeof store.projects === "object" ? store.projects : {}
        const nextProjects = { ...(projects as Record<string, unknown>) }

        const add = (origin: string) => {
          const current = nextProjects[origin]
          const items = Array.isArray(current) ? current : []
          const existing = items.filter(
            (p): p is { worktree: string; expanded?: boolean } =>
              !!p &&
              typeof p === "object" &&
              "worktree" in p &&
              typeof (p as { worktree?: unknown }).worktree === "string",
          )

          if (existing.some((p) => p.worktree === input.directory)) return
          nextProjects[origin] = [{ worktree: input.directory, expanded: true }, ...existing]
        }

        add("local")
        add(input.serverUrl)

        localStorage.setItem(
          key,
          JSON.stringify({
            list,
            projects: nextProjects,
            lastProject,
          }),
        )
      },
      { directory, serverUrl },
    )

    const gotoSession = async (sessionID?: string) => {
      await page.goto(projectPathname(slug, sessionID))
      await expect(page.locator(promptSelector)).toBeVisible()
    }
    await use(gotoSession)
  },
})

export { expect }
