import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ComputeJobs } from "../../src/compute/jobs"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { createComputeJobTool } from "../../src/tool/compute-job"
import { tmpdir, trustProject } from "../fixture/fixture"

const context = (sessionID: string, asked: Array<{ permission: string; patterns: string[] }>) => ({
  sessionID,
  messageID: "message",
  callID: "call",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async (input: { permission: string; patterns: string[] }) => {
    asked.push(input)
  },
})

async function start(
  directory: string,
  root: string,
  sessionID: string,
  input: Omit<ComputeJobs.Input, "target"> & { target?: ComputeJobs.Target },
) {
  return ComputeJobs.start(
    {
      ...input,
      target: input.target ?? { kind: "local" },
      sessionID,
    },
    { root, workspace: directory },
  )
}

test("inspects project jobs, logs, and delivered artifacts without approval", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const job = await start(tmp.path, root, session.id, {
        name: "broker inspection",
        command: "mkdir -p results && printf 'visible output\\n' && printf 'artifact data\\n' > results/value.txt",
        artifacts: ["results/value.txt"],
      })
      const finished = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })
      if (finished.status !== "succeeded") {
        throw new Error(await ComputeJobs.log(job.id, { root, workspace: tmp.path }))
      }
      const tool = await createComputeJobTool({ root, workspace: tmp.path }).init()
      const asked: Array<{ permission: string; patterns: string[] }> = []
      const ctx = context(session.id, asked)

      const listed = await tool.execute({ action: "list", limit: 20 }, ctx)
      const status = await tool.execute({ action: "status", job_id: job.id }, ctx)
      const logs = await tool.execute({ action: "logs", job_id: job.id, bytes: 64_000 }, ctx)
      const artifacts = await tool.execute({ action: "artifacts", job_id: job.id }, ctx)

      expect(listed.output).toContain(job.id)
      expect(status.output).toContain('"status": "succeeded"')
      expect(logs.output).toContain("visible output")
      expect(artifacts.output).toContain("results/value.txt")
      expect(asked).toEqual([])
    },
  })
})

test("surfaces delivery, cleanup, and recovery warnings during read-only inspection", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  const job = ComputeJobs.Job.parse({
    id: "warning-status",
    name: "warning status",
    command: "true",
    cwd: tmp.path,
    target: { kind: "local" },
    target_label: "This computer",
    scheduler: "none",
    status: "failed",
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    cleanup_error: "Remote resources may still be billing",
    capture_error: "Output delivery needs attention",
    recovery_attempts: 2,
    recovery_retry_at: "2026-08-05T12:00:00.000Z",
  })
  await fs.mkdir(root, { recursive: true })
  await Bun.write(path.join(root, "jobs.json"), JSON.stringify([job]))

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const tool = await createComputeJobTool({ root, workspace: tmp.path }).init()
      const status = await tool.execute({ action: "status", job_id: job.id }, context(session.id, []))

      expect(status.output).toContain('"cleanup_error": "Remote resources may still be billing"')
      expect(status.output).toContain('"capture_error": "Output delivery needs attention"')
      expect(status.output).toContain('"recovery_attempts": 2')
      expect(status.output).toContain('"recovery_retry_at": "2026-08-05T12:00:00.000Z"')
    },
  })
})

test("requires a dedicated approval before cancelling a job", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const job = await start(tmp.path, root, session.id, {
        name: "broker cancellation",
        command: "sleep 30",
      })
      const tool = await createComputeJobTool({ root, workspace: tmp.path }).init()
      const asked: Array<{ permission: string; patterns: string[] }> = []
      const result = await tool.execute({ action: "cancel", job_id: job.id }, context(session.id, asked))

      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ permission: "compute_job", patterns: [`cancel:${job.id}`] })
      expect(result.output).toContain('"status": "cancelled"')
    },
  })
})

test("releases retained Modal output only after approval", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  const calls = { run: 0, release: 0 }
  const provider = {
    volume: (project: string, id: string) => `test-${Bun.hash(`${project}\0${id}`)}`,
    run: async (
      _context: Parameters<ComputeJobs.ModalProvider["run"]>[0],
      spec: Parameters<ComputeJobs.ModalProvider["run"]>[1],
      hooks: Parameters<ComputeJobs.ModalProvider["run"]>[2],
    ) => {
      calls.run++
      await hooks.created(`sandbox-${spec.id}`)
      return { code: 0, outputs: [{ path: "../escape", staging: tmp.path, size: 0 }] }
    },
    recover: async () => ({ code: 0, outputs: [] }),
    find: async () => undefined,
    close: async () => undefined,
    release: async () => {
      calls.release++
    },
  } satisfies ComputeJobs.ModalProvider
  const modal = {
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none" as const,
    timeoutMinutes: 10,
    concurrency: 1,
  }
  const credentials = { ...modal, tokenId: "ak-test", tokenSecret: "as-test" }
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const request = {
        name: "retained output",
        command: "printf result > result.txt",
        target: { kind: "modal" as const },
        gpu: "none",
        artifacts: ["result.txt"],
        sessionID: session.id,
      }
      const plan = await ComputeJobs.plan(request, { root, workspace: tmp.path, modal })
      const job = await ComputeJobs.start(
        { ...request, approval: plan.digest },
        { root, workspace: tmp.path, modal, credentials, provider },
      )
      const retained = async (attempts = 100): Promise<ComputeJobs.Job> => {
        const current = await ComputeJobs.get(job.id, { root, workspace: tmp.path })
        if (current?.lifecycle?.recoverable) return current
        if (!attempts) throw new Error("Timed out waiting for retained Modal output")
        await Bun.sleep(20)
        return retained(attempts - 1)
      }
      await retained()
      const tool = await createComputeJobTool({
        root,
        workspace: tmp.path,
        modal,
        credentials,
        provider,
      }).init()
      const asked: Array<{ permission: string; patterns: string[] }> = []
      const result = await tool.execute({ action: "release", job_id: job.id }, context(session.id, asked))

      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ permission: "compute_job", patterns: [`release:${job.id}`] })
      expect(result.output).toContain('"resource": "closed"')
      expect(result.output).toContain('"recoverable": false')
      expect(calls).toEqual({ run: 1, release: 1 })
    },
  })
})
