import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ComputeJobs } from "../../src/compute/jobs"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function setup() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-compute-events-workspace-"))
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-compute-events-data-"))
  roots.push(workspace, root)
  const job = ComputeJobs.Job.parse({
    id: "modal-events",
    name: "Modal events",
    command: "python analysis.py",
    cwd: workspace,
    target: { kind: "modal" },
    target_label: "Modal",
    scheduler: "none",
    status: "succeeded",
    created_at: new Date().toISOString(),
  })
  await fs.mkdir(path.join(root, "jobs"), { recursive: true })
  await fs.writeFile(path.join(root, "jobs.json"), JSON.stringify([job]))
  return { workspace, root }
}

describe("ComputeJobs provider events", () => {
  test("reads and clears durable lifecycle logs separately from command output", async () => {
    const tmp = await setup()
    const events = "[2026-08-05T00:00:00.000Z] Sandbox ready: sb-123\n"
    await fs.writeFile(path.join(tmp.root, "jobs", "modal-events.events.log"), events)
    await fs.writeFile(path.join(tmp.root, "jobs", "modal-events.log"), "analysis result\n")

    expect(await ComputeJobs.events("modal-events", tmp)).toBe(events)
    expect(await ComputeJobs.log("modal-events", tmp)).toBe("analysis result\n")
    expect(await ComputeJobs.clear(tmp)).toBe(1)
    expect(await fs.stat(path.join(tmp.root, "jobs", "modal-events.events.log")).catch(() => undefined)).toBeUndefined()
  })
})
