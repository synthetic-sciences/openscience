import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { ComputeJobs } from "../../src/compute/jobs"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { ComputeJobParameters, createComputeJobTool } from "../../src/tool/compute-job"
import { tmpdir, trustProject } from "../fixture/fixture"

type Asked = { permission: string; patterns: string[]; always?: string[]; metadata?: Record<string, unknown> }

const context = (sessionID: string, asked: Asked[]) => ({
  sessionID,
  messageID: "message",
  callID: "call",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async (input: Asked) => {
    asked.push(input)
  },
})

test("advertises the canonical action-discriminated compute schema", () => {
  const schema = z.toJSONSchema(ComputeJobParameters) as {
    description?: string
    anyOf: Array<{
      properties: Record<string, { const?: string; description?: string; anyOf?: Array<{ type?: string }> }>
      required: string[]
    }>
  }
  expect(schema.anyOf.map((variant) => variant.properties.action.const)).toEqual([
    "targets",
    "plan",
    "start",
    "list",
    "status",
    "logs",
    "artifacts",
    "cancel",
    "retry_delivery",
    "release",
  ])
  expect(JSON.stringify(schema)).not.toContain('"operation"')
  const plan = schema.anyOf[1]
  expect(plan.required).toEqual(["name", "purpose", "command", "target", "action"])
  expect(plan.properties.target.anyOf?.every((target) => target.type === "object")).toBe(true)
  expect(schema.description).toContain('{"action":"targets"}')
  expect(plan.properties.target.description).toContain("never a quoted JSON string")
})

test("normalizes only unambiguous action aliases and valid JSON-object targets", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const tool = await createComputeJobTool({ root, workspace: tmp.path }).init()
      const targets = await tool.execute({ operation: "targets" } as never, context(session.id, []))
      expect(targets.output).toContain('"kind": "local"')

      const duplicate = await tool.execute(
        { action: "targets", operation: "targets" } as never,
        context(session.id, []),
      )
      expect(duplicate.output).toContain('"kind": "local"')

      const preview = await tool.execute(
        {
          action: "plan",
          name: "environment probe",
          purpose: "Check the local runtime before starting work.",
          command: "python --version",
          target: '{"kind":"local"}',
        } as never,
        context(session.id, []),
      )
      expect(preview.output).toContain('"provider": "local"')

      const dispatched = await tool.execute(
        {
          action: "start",
          name: "normalization probe",
          purpose: "Verify defaulted fields reach compute execution.",
          command: "printf normalized",
          target: { kind: "local" },
        },
        context(session.id, []),
      )
      const job = dispatched.metadata.job
      if (!job) throw new Error("compute_job did not return its normalization probe")
      const listed = await tool.execute({ operation: "list" } as never, context(session.id, []))
      expect(listed.output).toContain(job.id)
      await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })
    },
  })
})

test("rejects ambiguous or invalid compute shapes with one copy-ready repair", async () => {
  const tool = await createComputeJobTool().init()
  await expect(
    tool.execute({ action: "targets", operation: "plan" } as never, context("ses_validation", [])),
  ).rejects.toThrow('Use the field "action", not "operation"')
  await expect(tool.execute({ operation: "inspect" } as never, context("ses_validation", []))).rejects.toThrow(
    "Valid action values: targets, plan, start, list, status, logs, artifacts, cancel, retry_delivery, release",
  )
  await expect(
    tool.execute(
      {
        action: "plan",
        name: "environment probe",
        purpose: "Check the local runtime before starting work.",
        command: "python --version",
        target: '{"kind":"ssh"}',
      } as never,
      context("ses_validation", []),
    ),
  ).rejects.toThrow(
    '{"action":"plan","name":"Environment probe","purpose":"Check the local runtime before starting work.","command":"python --version","target":{"kind":"local"}}',
  )
})

test("plans and starts a detached local job through the model-facing broker", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const tool = await createComputeJobTool({ root, workspace: tmp.path }).init()
      const asked: Asked[] = []
      const workload = {
        name: "local broker run",
        purpose: "Produce a durable local result.",
        command: "printf 'local broker ready\\n'",
        target: { kind: "local" as const },
      }

      const preview = await tool.execute({ action: "plan", ...workload }, context(session.id, asked))
      expect(preview.output).toContain('"provider": "local"')
      expect(preview.output).toContain("active session sandbox")
      expect(asked).toEqual([])

      const dispatched = await tool.execute({ action: "start", ...workload }, context(session.id, asked))
      const job = dispatched.metadata.job
      if (!job) throw new Error("compute_job did not return its started local job")
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({
        permission: "compute_job",
        patterns: [preview.metadata.compute_job.plan?.digest],
        always: [],
      })
      expect(dispatched.output).toContain(`Dispatched local job ${job.id}`)
      const finished = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })
      expect(finished.status).toBe("succeeded")
      expect(await ComputeJobs.log(job.id, { root, workspace: tmp.path })).toContain("local broker ready")
    },
  })
})

test("keeps one project inventory across isolated conversation workspaces", async () => {
  await using tmp = await tmpdir({ git: true })
  const data = path.join(tmp.path, "data")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const first = await Session.create({})
      const second = await Session.create({})
      const tool = await createComputeJobTool({ data }).init()
      const dispatched = await tool.execute(
        {
          action: "start",
          name: "shared inventory",
          purpose: "Verify project-wide compute visibility.",
          command: "printf shared-inventory",
          target: { kind: "local" },
        },
        context(first.id, []),
      )
      const job = dispatched.metadata.job
      if (!job) throw new Error("compute_job did not return its durable handle")

      const listed = await tool.execute({ action: "list", limit: 20 }, context(second.id, []))
      expect(await SessionFilesystem.workspace(first.id)).not.toBe(await SessionFilesystem.workspace(second.id))
      expect(listed.output).toContain(job.id)

      const finished = await ComputeJobs.wait(job.id, {
        data,
        projectDirectory: tmp.path,
        workspace: await SessionFilesystem.workspace(first.id),
        timeout: 5_000,
      })
      expect(finished.status).toBe("succeeded")
    },
  })
})

test("discovers saved SSH targets and produces an exact scoped Slurm plan", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  const host = ComputeJobs.Host.parse({
    id: "lab-slurm",
    label: "Lab Slurm",
    host: "cluster.example.org",
    user: "researcher",
    scheduler: "slurm",
    workdir: "/scratch/research",
    notes: "Load the site Python module and use project scratch.",
    fingerprint: `SHA256:${"a".repeat(43)}`,
    host_key: `cluster.example.org ssh-ed25519 ${Buffer.from("host-key").toString("base64")}`,
    concurrency: 4,
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const tool = await createComputeJobTool({ root, workspace: tmp.path, hosts: [host] }).init()
      const asked: Asked[] = []

      const targets = await tool.execute({ action: "targets" }, context(session.id, asked))
      expect(targets.output).toContain('"host_id": "lab-slurm"')
      expect(targets.output).toContain('"scheduler": "slurm"')
      expect(targets.output).toContain('"verified": true')

      const preview = await tool.execute(
        {
          action: "plan",
          name: "Slurm broker run",
          purpose: "Fit the model on the lab scheduler.",
          command: "python train.py",
          target: { kind: "ssh", host_id: host.id },
          resources: { cpus: 8, gpus: 1, memory_gb: 32, time_minutes: 45, partition: "gpu" },
          modules: ["python/3.12"],
        },
        context(session.id, asked),
      )
      expect(preview.output).toContain('"provider": "ssh"')
      expect(preview.output).toContain('"scheduler": "slurm"')
      expect(preview.output).toContain(host.notes!)
      const digest = preview.metadata.compute_job.plan?.digest
      expect(digest).toMatch(/^[a-f0-9]{64}$/)
      expect(asked).toEqual([])

      const stopped = {
        ...context(session.id, asked),
        ask: async (input: Asked) => {
          asked.push(input)
          throw new Error("approval halted before SSH dispatch")
        },
      }
      await expect(
        tool.execute(
          {
            action: "start",
            name: "Slurm broker run",
            purpose: "Fit the model on the lab scheduler.",
            command: "python train.py",
            target: { kind: "ssh", host_id: host.id },
            resources: { cpus: 8, gpus: 1, memory_gb: 32, time_minutes: 45, partition: "gpu" },
            modules: ["python/3.12"],
          },
          stopped,
        ),
      ).rejects.toThrow("approval halted before SSH dispatch")
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ permission: "remote_compute", patterns: [digest], always: [digest] })
      expect(await ComputeJobs.list({ root, workspace: tmp.path })).toEqual([])
    },
  })
})

test("starts Modal through JobBroker only after a digest-bound scoped approval", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  const modal = {
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none" as const,
    timeoutMinutes: 10,
    concurrency: 1,
  }
  const credentials = { ...modal, tokenId: "ak-test", tokenSecret: "as-test" }
  const provider = {
    volume: (project: string, id: string) => `test-${Bun.hash(`${project}\0${id}`)}`,
    run: async () => ({ code: 0, outputs: [] }),
    recover: async () => ({ code: 0, outputs: [] }),
    find: async () => undefined,
    close: async () => undefined,
    release: async () => undefined,
  } satisfies ComputeJobs.ModalProvider
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const workspace = await SessionFilesystem.workspace(session.id)
      await fs.mkdir(path.join(workspace, "reviewed-run"), { recursive: true })
      const tool = await createComputeJobTool({
        root,
        workspace: tmp.path,
        modal,
        credentials,
        provider,
      }).init()
      const asked: Asked[] = []
      const workload = {
        name: "Modal broker run",
        purpose: "Run a bounded paid evaluation.",
        command: "python -c 'print(42)'",
        cwd: "reviewed-run",
        target: { kind: "modal" as const },
        gpu: "none",
        resources: { cpus: 2, memory_gb: 4, time_minutes: 5 },
      }

      const preview = await tool.execute({ action: "plan", ...workload }, context(session.id, asked))
      const digest = preview.metadata.compute_job.plan?.digest
      expect(preview.output).toContain('"provider": "modal"')
      expect(digest).toMatch(/^[a-f0-9]{64}$/)
      expect(preview.metadata.compute_job.plan).toMatchObject({
        workspace_cwd: "reviewed-run",
        cwd: path.join(workspace, "reviewed-run"),
      })

      const dispatched = await tool.execute({ action: "start", ...workload }, context(session.id, asked))
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ permission: "modal", patterns: [digest], always: [digest] })
      expect(dispatched.metadata.job?.modal?.approval).toBe(digest)
      expect(dispatched.output).toContain("Dispatched modal job")
    },
  })
})

async function start(
  _directory: string,
  root: string,
  sessionID: string,
  input: Omit<ComputeJobs.Input, "target"> & { target?: ComputeJobs.Target },
) {
  const workspace = await SessionFilesystem.workspace(sessionID)
  return ComputeJobs.start(
    {
      ...input,
      target: input.target ?? { kind: "local" },
      sessionID,
    },
    { root, workspace },
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
      const workspace = await SessionFilesystem.workspace(session.id)
      const job = await start(tmp.path, root, session.id, {
        name: "broker inspection",
        command: "mkdir -p results && printf 'visible output\\n' && printf 'artifact data\\n' > results/value.txt",
        artifacts: ["results/value.txt"],
      })
      const finished = await ComputeJobs.wait(job.id, { root, workspace, timeout: 5_000 })
      if (finished.status !== "succeeded") {
        throw new Error(await ComputeJobs.log(job.id, { root, workspace }))
      }
      const tool = await createComputeJobTool({ root }).init()
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
      const workspace = await SessionFilesystem.workspace(session.id)
      const job = await start(tmp.path, root, session.id, {
        name: "broker cancellation",
        command: "sleep 30",
      })
      const tool = await createComputeJobTool({ root }).init()
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
      const workspace = await SessionFilesystem.workspace(session.id)
      const request = {
        name: "retained output",
        command: "printf result > result.txt",
        target: { kind: "modal" as const },
        gpu: "none",
        artifacts: ["result.txt"],
        sessionID: session.id,
      }
      const plan = await ComputeJobs.plan(request, { root, workspace, modal })
      const job = await ComputeJobs.start(
        { ...request, approval: plan.digest },
        { root, workspace, modal, credentials, provider },
      )
      const retained = async (attempts = 100): Promise<ComputeJobs.Job> => {
        const current = await ComputeJobs.get(job.id, { root, workspace })
        if (current?.lifecycle?.recoverable) return current
        if (!attempts) throw new Error("Timed out waiting for retained Modal output")
        await Bun.sleep(20)
        return retained(attempts - 1)
      }
      await retained()
      const tool = await createComputeJobTool({
        root,
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
