import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ComputeJobs } from "../../src/compute/jobs"

function isolatedEnv(root: string) {
  return {
    ...process.env,
    OPENSCIENCE_DATA_DIR: path.join(root, "data"),
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config-xdg"),
    XDG_DATA_HOME: path.join(root, "data-xdg"),
    XDG_STATE_HOME: path.join(root, "state-xdg"),
  }
}

// Six real servers each perform native ownership registration, durable store
// arbitration, and verified process-tree teardown. Under concurrent suite load
// this has measured 28s, so keep a meaningful margin above the old 30s edge.
test("independent servers preserve every concurrent compute lifecycle update", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-compute-race-"))
  const workspace = path.join(root, "workspace")
  const state = path.join(root, "jobs")
  const runner = path.join(root, "run.ts")
  const jobs = new URL("../../src/compute/jobs.ts", import.meta.url).href
  const instance = new URL("../../src/project/instance.ts", import.meta.url).href
  const trust = new URL("../../src/project/trust.ts", import.meta.url).href
  const session = new URL("../../src/session/index.ts", import.meta.url).href
  const total = 6
  await fs.mkdir(workspace)
  await Bun.write(
    runner,
    `
import { ComputeJobs } from ${JSON.stringify(jobs)}
import { Instance } from ${JSON.stringify(instance)}
import { ProjectTrust } from ${JSON.stringify(trust)}
import { Session } from ${JSON.stringify(session)}
await Instance.provide({
  directory: process.argv[2],
  fn: async () => {
    const status = await ProjectTrust.status(Instance.project)
    if (!status.canExecuteProjectCode) {
      await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
    }
    const session = await Session.create({})
    const job = await ComputeJobs.start({
      name: process.argv[4],
      command: "sleep 0.15",
      target: { kind: "local" },
      sessionID: session.id,
    }, { root: process.argv[3], workspace: process.argv[2] })
    const done = await ComputeJobs.wait(job.id, { root: process.argv[3], workspace: process.argv[2], timeout: 10_000 })
    console.log(JSON.stringify({
      id: done.id,
      status: done.status,
      trustRevision: done.authority?.trustRevision,
      projectID: done.authority?.projectID,
      sessionID: session.id,
    }))
  },
})
`,
  )

  try {
    const processes = Array.from({ length: total }, (_, index) =>
      Bun.spawn([process.execPath, runner, workspace, state, `job-${index}`], {
        env: isolatedEnv(root),
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const results = await Promise.all(
      processes.map(async (proc) => ({
        exit: await proc.exited,
        output: await new Response(proc.stdout).text(),
        error: await new Response(proc.stderr).text(),
      })),
    )
    expect(results.filter((item) => item.exit !== 0)).toEqual([])
    const outputs = results.map(
      (item) =>
        JSON.parse(item.output.trim()) as {
          id: string
          status: string
          trustRevision: number
          projectID: string
          sessionID: string
        },
    )
    expect(new Set(outputs.map((item) => item.id)).size).toBe(total)
    expect(new Set(outputs.map((item) => item.status))).toEqual(new Set(["succeeded"]))
    expect(new Set(outputs.map((item) => item.trustRevision)).size).toBe(1)
    expect(new Set(outputs.map((item) => item.projectID)).size).toBe(1)

    const storage = path.join(root, "data", "storage")
    const projectID = outputs[0]!.projectID
    const projects = (await fs.readdir(path.join(storage, "project"))).filter((item) => item.endsWith(".json"))
    expect(projects).toEqual([`${projectID}.json`])
    for (const output of outputs) {
      expect(await Bun.file(path.join(storage, "session", projectID, `${output.sessionID}.json`)).exists()).toBe(true)
      expect(
        await Bun.file(path.join(storage, "session_workspace", projectID, `${output.sessionID}.json`)).exists(),
      ).toBe(true)
    }

    const persisted = ComputeJobs.Job.array().parse(JSON.parse(await Bun.file(path.join(state, "jobs.json")).text()))
    expect(persisted).toHaveLength(total)
    expect(new Set(persisted.map((item) => item.id)).size).toBe(total)
    expect(new Set(persisted.map((item) => item.name)).size).toBe(total)
    expect(new Set(persisted.map((item) => item.status))).toEqual(new Set(["succeeded"]))
    expect(await Bun.file(path.join(state, "jobs.json.lock")).exists()).toBe(false)
    expect(await fs.readdir(path.join(state, "local-leases"))).toEqual([])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 60_000)

test("independent servers share one durable Modal concurrency admission", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-modal-admission-"))
  const workspace = path.join(root, "workspace")
  const state = path.join(root, "jobs")
  const runner = path.join(root, "modal.ts")
  const gate = path.join(root, "release")
  const launches = path.join(root, "launches.log")
  const jobs = new URL("../../src/compute/jobs.ts", import.meta.url).href
  const instance = new URL("../../src/project/instance.ts", import.meta.url).href
  const trust = new URL("../../src/project/trust.ts", import.meta.url).href
  const session = new URL("../../src/session/index.ts", import.meta.url).href
  await fs.mkdir(workspace)
  await Bun.write(
    runner,
    `
import fs from "node:fs/promises"
import { ComputeJobs } from ${JSON.stringify(jobs)}
import { Instance } from ${JSON.stringify(instance)}
import { ProjectTrust } from ${JSON.stringify(trust)}
import { Session } from ${JSON.stringify(session)}
const workspace = process.argv[2]
const root = process.argv[3]
const gate = process.argv[4]
const launches = process.argv[5]
const modal = { app: "openscience-test", image: "python:3.12-slim", network: "none", timeoutMinutes: 10, concurrency: 1 }
const credentials = { ...modal, tokenId: "ak-test", tokenSecret: "as-test" }
const provider = {
  volume: (_project, id) => \`test-\${id}\`,
  run: async (_context, spec, hooks) => {
    await hooks.created(\`sandbox-\${spec.id}\`)
    await fs.appendFile(launches, \`\${process.pid}\\n\`)
    while (!(await Bun.file(gate).exists())) await Bun.sleep(20)
    return { code: 0, outputs: [] }
  },
  recover: async () => ({ code: 0, outputs: [] }),
  find: async () => undefined,
  close: async () => undefined,
  release: async () => undefined,
}
await Instance.provide({
  directory: workspace,
  fn: async () => {
    const status = await ProjectTrust.status(Instance.project)
    if (!status.canExecuteProjectCode) await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
    const session = await Session.create({})
    const request = { name: \`modal-\${process.pid}\`, command: "true", target: { kind: "modal" }, gpu: "none", sessionID: session.id }
    const plan = await ComputeJobs.plan(request, { root, workspace, modal })
    try {
      const job = await ComputeJobs.start({ ...request, approval: plan.digest }, { root, workspace, modal, credentials, provider })
      const done = await ComputeJobs.wait(job.id, { root, workspace, timeout: 10_000 })
      console.log(JSON.stringify({ ok: true, id: done.id, status: done.status }))
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    }
  },
})
`,
  )

  try {
    const processes = Array.from({ length: 2 }, () =>
      Bun.spawn([process.execPath, runner, workspace, state, gate, launches], {
        env: isolatedEnv(root),
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const deadline = Date.now() + 10_000
    while (!(await Bun.file(launches).exists()) && Date.now() < deadline) await Bun.sleep(20)
    expect(await Bun.file(launches).exists()).toBe(true)
    await Bun.sleep(300)
    await Bun.write(gate, "release")
    const results = await Promise.all(
      processes.map(async (proc) => ({
        exit: await proc.exited,
        output: await new Response(proc.stdout).text(),
        error: await new Response(proc.stderr).text(),
      })),
    )
    expect(results.filter((item) => item.exit !== 0)).toEqual([])
    const outputs = results.map(
      (item) => JSON.parse(item.output.trim()) as { ok: boolean; id?: string; status?: string; error?: string },
    )
    expect(outputs.filter((item) => item.ok)).toHaveLength(1)
    expect(outputs.filter((item) => !item.ok)).toHaveLength(1)
    expect(outputs.find((item) => !item.ok)?.error).toContain("Modal concurrency limit reached")
    expect((await Bun.file(launches).text()).trim().split("\n")).toHaveLength(1)
    const persisted = ComputeJobs.Job.array().parse(JSON.parse(await Bun.file(path.join(state, "jobs.json")).text()))
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.status).toBe("succeeded")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("independent servers serialize Modal cancel and release operations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-modal-operations-"))
  const workspace = path.join(root, "workspace")
  const state = path.join(root, "jobs")
  const runner = path.join(root, "operate.ts")
  const operations = path.join(root, "operations.log")
  const jobsUrl = new URL("../../src/compute/jobs.ts", import.meta.url).href
  await fs.mkdir(workspace)
  await fs.mkdir(state)

  const modalSpec = {
    app: "openscience-test",
    image: "python:3.12-slim",
    packages: [],
    gpu: "none",
    network: "none" as const,
    timeout_minutes: 10,
    uploads: [],
    upload_bytes: 0,
    approval: "a".repeat(64),
    sdk: "test",
    volume: "test-volume",
  }
  const common = {
    command: "true",
    cwd: workspace,
    target: { kind: "modal" as const },
    target_label: "Modal",
    scheduler: "none" as const,
    created_at: new Date(Date.now() - 10_000).toISOString(),
    modal: modalSpec,
  }
  const cancelJob = ComputeJobs.Job.parse({
    ...common,
    id: "cancel-job",
    name: "cancel once",
    status: "running",
    started_at: new Date(Date.now() - 9_000).toISOString(),
    remote_id: "sandbox-cancel",
    lifecycle: { execution: "running", delivery: "none", resource: "active", recoverable: false },
  })
  const releaseJob = ComputeJobs.Job.parse({
    ...common,
    id: "release-job",
    name: "release once",
    status: "succeeded",
    started_at: new Date(Date.now() - 9_000).toISOString(),
    completed_at: new Date(Date.now() - 1_000).toISOString(),
    exit_code: 0,
    remote_id: "sandbox-release",
    lifecycle: { execution: "succeeded", delivery: "complete", resource: "unknown", recoverable: false },
  })
  await Bun.write(path.join(state, "jobs.json"), JSON.stringify([cancelJob, releaseJob]))
  await Bun.write(
    runner,
    `
import fs from "node:fs/promises"
import { ComputeJobs } from ${JSON.stringify(jobsUrl)}
const workspace = process.argv[2]
const root = process.argv[3]
const operation = process.argv[4]
const id = process.argv[5]
const log = process.argv[6]
const credentials = {
  app: "openscience-test", image: "python:3.12-slim", network: "none", timeoutMinutes: 10,
  concurrency: 1, tokenId: "ak-test", tokenSecret: "as-test",
}
const provider = {
  volume: () => "test-volume",
  run: async () => ({ code: 0, outputs: [] }),
  recover: async () => ({ code: 0, outputs: [] }),
  find: async () => undefined,
  close: async () => {
    await fs.appendFile(log, \`cancel\\n\`)
    await Bun.sleep(150)
  },
  release: async () => {
    await fs.appendFile(log, \`\${operation}\\n\`)
    await Bun.sleep(150)
  },
}
const job = operation === "cancel"
  ? await ComputeJobs.cancel(id, { root, workspace, credentials, provider })
  : await ComputeJobs.release(id, { root, workspace, credentials, provider })
console.log(JSON.stringify({ id: job.id, status: job.status, resource: job.lifecycle?.resource }))
`,
  )

  try {
    const specs = [
      ["cancel", cancelJob.id],
      ["cancel", cancelJob.id],
      ["release", releaseJob.id],
      ["release", releaseJob.id],
    ] as const
    const processes = specs.map(([operation, id]) =>
      Bun.spawn([process.execPath, runner, workspace, state, operation, id, operations], {
        env: isolatedEnv(root),
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const results = await Promise.all(
      processes.map(async (proc) => ({
        exit: await proc.exited,
        output: await new Response(proc.stdout).text(),
        error: await new Response(proc.stderr).text(),
      })),
    )
    expect(results.filter((item) => item.exit !== 0)).toEqual([])
    expect((await Bun.file(operations).text()).trim().split("\n").toSorted()).toEqual(["cancel", "cancel", "release"])
    const persisted = ComputeJobs.Job.array().parse(JSON.parse(await Bun.file(path.join(state, "jobs.json")).text()))
    expect(persisted.find((item) => item.id === cancelJob.id)).toMatchObject({
      status: "cancelled",
      lifecycle: { resource: "unknown" },
      modal: { retained_volume: true },
    })
    expect(persisted.find((item) => item.id === releaseJob.id)).toMatchObject({
      status: "succeeded",
      lifecycle: { resource: "closed" },
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
