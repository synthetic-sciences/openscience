import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import { Hono } from "hono"
import { createOpenScienceClient } from "@synsci/sdk/v2"
import { GlobalRoutes } from "../../src/server/routes/global"
import { ProjectRoutes } from "../../src/server/routes/project"
import { ManagedProject } from "../../src/project/managed"
import { Project } from "../../src/project/project"
import { Storage } from "../../src/storage/storage"
import { createCampaignProject } from "../../../../evals/cadence-harness/run"

test("new evaluation projects start archived while their evidence and identity remain recoverable", async () => {
  const app = new Hono().route("/global", GlobalRoutes()).route("/project", ProjectRoutes())
  const client = createOpenScienceClient({
    baseUrl: "http://evaluation.test",
    fetch: ((input, init) => app.request(input, init)) as typeof fetch,
  })
  const project = await createCampaignProject(client, "Cadence harness · TEST · isolated fixture")
  try {
    expect(project.origin).toBe("openscience")
    expect(project.time.archived).toBeGreaterThan(0)
    expect((await fs.stat(project.worktree)).isDirectory()).toBe(true)
    expect((await Project.resolve(project.id)).project.id).toBe(project.id)
    expect((await ManagedProject.list()).find((item) => item.id === project.id)?.time.archived).toBeGreaterThan(0)
  } finally {
    await Storage.remove(["managed_project", project.id])
    await Storage.remove(["project", project.id])
    await Storage.remove(["project_filesystem", project.id]).catch(() => undefined)
    await fs.rm(project.worktree, { recursive: true, force: true })
  }
})
