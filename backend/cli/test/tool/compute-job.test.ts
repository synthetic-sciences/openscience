import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { ComputeJobs } from "../../src/compute/jobs"
import { ModalUpload } from "../../src/compute/modal/upload"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { Filesystem } from "../../src/util/filesystem"
import { ComputeJobParameters, computeJobTesting, createComputeJobTool } from "../../src/tool/compute-job"
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

test("advertises an object-rooted compute schema for strict providers", () => {
  const schema = z.toJSONSchema(ComputeJobParameters) as {
    type: string
    description?: string
    properties: Record<string, { enum?: string[]; description?: string; anyOf?: Array<{ type?: string }> }>
    required: string[]
  }
  expect(schema.type).toBe("object")
  expect(schema.properties.action.enum).toEqual([
    "targets",
    "plan",
    "start",
    "list",
    "status",
    "wait",
    "logs",
    "artifacts",
    "cancel",
    "retry_delivery",
    "release",
  ])
  expect(JSON.stringify(schema)).not.toContain('"operation"')
  expect(schema.required).toEqual(["action"])
  expect(schema.properties.target.anyOf?.every((target) => target.type === "object")).toBe(true)
  expect(schema.description).toContain('{"action":"targets"}')
  expect(schema.properties.target.description).toContain("never a quoted JSON string")
  expect(ComputeJobParameters.safeParse({ action: "plan" }).success).toBe(false)
  expect(ComputeJobParameters.safeParse({ action: "targets", job_id: "wrong-action" }).success).toBe(false)
  expect(ComputeJobParameters.safeParse({ action: "wait", job_id: "job_long", seconds: 3_600 }).success).toBe(true)
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
      // One preflight block says whether a job could run, download, and reach a
      // model API, so readiness is not pieced together from settings prose.
      const readiness = JSON.parse(targets.output).readiness
      expect(readiness).toMatchObject({
        remote_compute_configured: false,
        outbound_network: "blocked",
        downloads_permitted: false,
        secret_refs_available: [],
        ready_to_execute: "no remote target; local jobs only",
      })
      expect(readiness.credential_forwarding).toContain("not forwarded")

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
    "Valid action values: targets, plan, start, list, status, wait, logs, artifacts, cancel, retry_delivery, release",
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
      // A job that finishes within the dispatch's grace comes back settled,
      // with its output's tail and what it delivered, in this one step: no
      // wait, logs or artifacts round-trips for work a shell command returns
      // in one.
      expect(dispatched.output).toContain(`"id": "${job.id}"`)
      expect(dispatched.output).toContain('"status": "succeeded"')
      expect(dispatched.output).toContain("local broker ready")
      expect(dispatched.output).toContain('"delivered"')
      expect(dispatched.output).not.toContain("Dispatched local job")
      const finished = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })
      expect(finished.status).toBe("succeeded")
    },
  })
})

test("a local job at the project root runs in place when scratch is the project, even for a study's refreshed dispatch", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  await fs.writeFile(path.join(tmp.path, "train.py"), "print('trained')\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      // A headless run's sessions use the project as their workspace.
      const session = await Session.create({ workspace: "project" })
      const tool = await createComputeJobTool({ root, workspace: tmp.path }).init()
      const asked: Asked[] = []
      const workload = {
        name: "in place",
        purpose: "Run where the code is.",
        command: "python3 train.py",
        cwd: ".",
        target: { kind: "local" as const },
      }
      const preview = await tool.execute({ action: "plan", ...workload }, context(session.id, asked))
      expect(preview.metadata.compute_job.plan).toMatchObject({
        provider: "local",
        cwd: await Filesystem.canonical(tmp.path),
      })
      // The same request with the absolute project path, and through the
      // study path that refreshes staged copies from the project.
      const absolute = await tool.execute({ action: "plan", ...workload, cwd: tmp.path }, context(session.id, asked))
      expect(absolute.metadata.compute_job.plan).toMatchObject({
        provider: "local",
        cwd: await Filesystem.canonical(tmp.path),
      })
      expect(asked).toEqual([])
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

test("a worker starts a local job in the lead's directory it was given to work in", async () => {
  await using tmp = await tmpdir({ git: true })
  const data = path.join(tmp.path, "data")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const lead = await Session.create({})
      const worker = await Session.create({ parentID: lead.id })
      // What the task tool does for every worker: its own scratch, the
      // lead's directory as its working directory.
      await SessionFilesystem.shareWorkingDirectory({ parentSessionID: lead.id, childSessionID: worker.id })
      const directory = await SessionFilesystem.toolDirectory(worker.id)
      expect(directory).toBe(await SessionFilesystem.toolDirectory(lead.id))
      expect(directory).not.toBe(await SessionFilesystem.workspace(worker.id))
      await fs.mkdir(path.join(directory, "fits"), { recursive: true })
      await fs.writeFile(path.join(directory, "fits", "run.sh"), "printf fitted > result.txt\n")

      const tool = await createComputeJobTool({ data }).init()
      // A worker's job used to fail here with "Compute project does not match
      // the session workspace", because the compute workspace was the
      // worker's private scratch while its code sat in the lead's directory.
      const dispatched = await tool.execute(
        {
          action: "start",
          name: "worker fit",
          purpose: "A worker's long computation, detached.",
          command: "sh run.sh",
          cwd: "fits",
          target: { kind: "local" },
        },
        context(worker.id, []),
      )
      const job = dispatched.metadata.job
      if (!job) throw new Error("compute_job did not return its durable handle")
      const finished = await ComputeJobs.wait(job.id, {
        data,
        projectDirectory: tmp.path,
        workspace: directory,
        timeout: 5_000,
      })
      expect(finished.status).toBe("succeeded")
      expect(await fs.readFile(path.join(directory, "fits", "result.txt"), "utf8")).toBe("fitted")
      // The lead sees the worker's job in the one project inventory.
      const listed = await tool.execute({ action: "list", limit: 20 }, context(lead.id, []))
      expect(listed.output).toContain(job.id)
    },
  })
})

test("discovers saved SSH targets and produces an exact scoped Slurm plan", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  const source = path.join(tmp.path, "ssh-analysis")
  await fs.mkdir(source, { recursive: true })
  await Bun.write(path.join(source, "train.py"), "print('ssh input')\n")
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

      const staged = await tool.execute(
        {
          action: "plan",
          name: "Staged Slurm run",
          purpose: "Stage the project analysis before dispatch.",
          command: "python train.py",
          cwd: "ssh-analysis",
          target: { kind: "ssh", host_id: host.id },
          resources: { cpus: 2, time_minutes: 5 },
        },
        context(session.id, asked),
      )
      expect(staged.output).toContain("Staged Project files/ssh-analysis into Session scratch before planning.")
      expect(staged.metadata.compute_job.plan).toMatchObject({
        provider: "ssh",
        remote_cwd: "ssh-analysis",
        uploads: [expect.objectContaining({ path: "ssh-analysis/train.py" })],
      })

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
      const targets = await tool.execute({ action: "targets" }, context(session.id, asked))
      expect(targets.output).toContain("Outbound network access is blocked")
      expect(targets.output).toContain("bare CUDA runtime images do not")
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
      // The exact plan asks; an hour's allowance (four of this five-minute
      // job, rounded up to the hour) is offered beside it.
      expect(asked[0]).toMatchObject({ permission: "modal", patterns: [digest], always: [digest, "allowance:60"] })
      expect(asked[0]!.metadata).toMatchObject({ compute: { allowance: { proposed_minutes: 60 } } })
      expect(dispatched.metadata.job?.modal?.approval).toBe(digest)
      // The fixture's Modal job settles at once, so the dispatch reports it settled.
      expect(dispatched.output).toContain('"status": "succeeded"')

      // The person answered "this session": the exact plan and the hour's
      // allowance are granted. A different job (new script, new digest) in
      // the same session then asks under the allowance, not on a new digest,
      // while its timeout still fits beside the five minutes already used.
      const granted = PermissionNext.ask({
        id: "permission_reviewed",
        sessionID: session.id,
        permission: "modal",
        patterns: asked[0]!.patterns ?? [],
        always: asked[0]!.always ?? [],
        metadata: {},
        ruleset: [{ permission: "modal", pattern: "*", action: "ask" }],
        mode: "approve",
      })
      await PermissionNext.reply({ requestID: "permission_reviewed", reply: "session" })
      await granted
      const second = await tool.execute(
        { action: "start", ...workload, name: "Modal follow-up", command: "python -c 'print(43)'" },
        context(session.id, asked),
      )
      expect(asked).toHaveLength(2)
      expect(asked[1]).toMatchObject({ permission: "modal", patterns: ["allowance:60"] })
      expect(asked[1]!.metadata).toMatchObject({
        compute: { allowance: { covered_by: "allowance:60", used_minutes: 5 } },
      })
      expect(second.metadata.job?.modal?.approval).toMatch(/^[a-f0-9]{64}$/)
      expect(second.metadata.job?.modal?.approval).not.toBe(digest)
    },
  })
})

test("snapshots an existing Project-files cwd into Session scratch before a Modal plan", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  const source = path.join(tmp.path, "cerbench-analysis")
  await fs.mkdir(source, { recursive: true })
  await Bun.write(path.join(source, "analysis.py"), "print('staged input')\n")
  const modal = {
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none" as const,
    timeoutMinutes: 10,
    concurrency: 1,
  }
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
      const asked: Asked[] = []
      const tool = await createComputeJobTool({
        root,
        modal,
        credentials: { ...modal, tokenId: "ak", tokenSecret: "as" },
        provider,
      }).init()

      const preview = await tool.execute(
        {
          action: "plan",
          name: "CERBench shards",
          purpose: "Run the reviewed evaluation inputs.",
          command: "python analysis.py",
          cwd: "cerbench-analysis",
          target: { kind: "modal" },
          gpu: "none",
        },
        context(session.id, asked),
      )

      expect(preview.output).toContain("Staged Project files/cerbench-analysis into Session scratch before planning.")
      expect(preview.metadata.compute_job.plan).toMatchObject({
        provider: "modal",
        cwd: path.join(workspace, "cerbench-analysis"),
        workspace_cwd: "cerbench-analysis",
        uploads: [expect.objectContaining({ path: "analysis.py" })],
      })
      expect(await Bun.file(path.join(workspace, "cerbench-analysis", "analysis.py")).text()).toBe(
        "print('staged input')\n",
      )
      expect(asked).toEqual([])
      expect(await ComputeJobs.list({ root, projectDirectory: tmp.path, workspace })).toEqual([])

      const dispatched = await tool.execute(
        {
          action: "start",
          name: "CERBench shards",
          purpose: "Run the reviewed evaluation inputs.",
          command: "python analysis.py",
          cwd: "cerbench-analysis",
          target: { kind: "modal" },
          gpu: "none",
        },
        context(session.id, asked),
      )
      expect(dispatched.metadata.job?.modal?.uploads).toEqual([expect.objectContaining({ path: "analysis.py" })])
      expect(asked).toHaveLength(1)
    },
  })
})

test("an absolute Project-files directory is the same request as its relative form; the root and outside paths are refused with the directory to name", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  const source = path.join(tmp.path, "autoresearch_churn")
  await fs.mkdir(source, { recursive: true })
  await Bun.write(path.join(source, "train.py"), "print('train')\n")
  const modal = {
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none" as const,
    timeoutMinutes: 10,
    concurrency: 1,
  }
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
      const asked: Asked[] = []
      const tool = await createComputeJobTool({
        root,
        modal,
        credentials: { ...modal, tokenId: "ak", tokenSecret: "as" },
        provider,
      }).init()
      const plan = (cwd: string) =>
        tool.execute(
          {
            action: "plan",
            name: "Churn GPU smoke test",
            purpose: "Fit the baseline on the accelerator.",
            command: "python train.py --model blend",
            cwd,
            target: { kind: "modal" },
            gpu: "none",
          },
          context(session.id, asked),
        )

      // The model read train.py by its full path and named the job's
      // directory the same way: that is the relative "autoresearch_churn".
      const preview = await plan(source)
      expect(preview.metadata.compute_job.plan).toMatchObject({
        provider: "modal",
        cwd: path.join(workspace, "autoresearch_churn"),
        workspace_cwd: "autoresearch_churn",
        uploads: [expect.objectContaining({ path: "train.py" })],
      })

      // The Project-files root has no relative form: say what to name instead.
      await expect(plan(tmp.path)).rejects.toThrow(/Project files root itself.*cwd "autoresearch_churn"/)
      // Session scratch itself is where jobs run (in a headless run it is the
      // project, and the code sits there): its root is the working directory ".".
      const rooted = await plan(workspace)
      expect(rooted.metadata.compute_job.plan).toMatchObject({ provider: "modal", workspace_cwd: "." })
      // And a directory outside both roots stays outside.
      await expect(plan(path.join(path.dirname(tmp.path), "somewhere-else"))).rejects.toThrow(
        /outside Session scratch and Project files/,
      )
      await expect(plan("../elsewhere")).rejects.toThrow(/cannot contain '\.\.'/)
      expect(asked).toEqual([])
    },
  })
})

test("a study's runs ask under the study's approval, and a staged copy is refreshed from the project on the next dispatch", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  const source = path.join(tmp.path, "autoresearch_churn")
  await fs.mkdir(source, { recursive: true })
  await Bun.write(path.join(source, "train.py"), "VERSION = 1\n")
  await Bun.write(path.join(source, "ideas.md"), "# ideas\n")
  const modal = {
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none" as const,
    timeoutMinutes: 10,
    concurrency: 1,
  }
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
      const asked: Asked[] = []
      const tool = await createComputeJobTool({
        root,
        modal,
        credentials: { ...modal, tokenId: "ak", tokenSecret: "as" },
        provider,
      }).init()
      const ctx = { ...context(session.id, asked), extra: { studyApproval: "study:stu_1", studyStaging: "refresh" } }
      // The agent left a same-named directory in scratch before the study
      // existed; the study's root under Project files is still what runs.
      await Bun.write(path.join(workspace, "autoresearch_churn", "notes.txt"), "scratch notes\n")
      const workload = {
        name: "Churn: baseline",
        purpose: "Study run.",
        command: "python train.py",
        cwd: "autoresearch_churn",
        target: { kind: "modal" as const },
        gpu: "none",
        exclude_uploads: ["ideas.md"],
      }
      const first = await tool.execute({ action: "start", ...workload }, ctx)
      // The card carries the study's pattern, not a digest that changes per run.
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ permission: "modal", patterns: ["study:stu_1"], always: ["study:stu_1"] })
      const uploads = (first.metadata.job?.modal?.uploads ?? []).map((file: { path: string }) => file.path)
      expect(uploads).toEqual(["notes.txt", "train.py"])
      expect(await Bun.file(path.join(workspace, "autoresearch_churn", "train.py")).text()).toBe("VERSION = 1\n")
      expect(await Bun.file(path.join(workspace, "autoresearch_churn", "notes.txt")).exists()).toBe(true)
      // A delivered output sits in the copy; the study then changes the code.
      await Bun.write(path.join(workspace, "autoresearch_churn", "outputs", "metrics.json"), "{}")
      await Bun.write(path.join(source, "train.py"), "VERSION = 2\n")
      const second = await tool.execute({ action: "start", ...workload }, ctx)
      // The second dispatch ships the current code: the copy was refreshed,
      // and what earlier runs delivered into it is still there.
      expect(await Bun.file(path.join(workspace, "autoresearch_churn", "train.py")).text()).toBe("VERSION = 2\n")
      expect(await Bun.file(path.join(workspace, "autoresearch_churn", "outputs", "metrics.json")).exists()).toBe(true)
      const shaOf = (result: typeof first) =>
        (result.metadata.job?.modal?.uploads ?? []).find((file: { path: string }) => file.path === "train.py")?.sha256
      expect(shaOf(second)).toBeDefined()
      expect(shaOf(second)).not.toBe(shaOf(first))
    },
  })
})

test("remote Project-files staging excludes symlinks, denied paths, and ignored large directories", async () => {
  if (process.platform === "win32") return
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  const source = path.join(tmp.path, "filtered-analysis")
  const outside = path.join(tmp.path, "outside-inputs")
  await Promise.all([
    fs.mkdir(path.join(source, "ignored"), { recursive: true }),
    fs.mkdir(path.join(source, "node_modules", "package"), { recursive: true }),
    fs.mkdir(outside, { recursive: true }),
  ])
  await Promise.all([
    Bun.write(path.join(source, "analysis.py"), "print('approved')\n"),
    Bun.write(path.join(source, ".gitignore"), "ignored/\n"),
    Bun.write(path.join(source, ".env"), "PRIVATE_TOKEN=secret\n"),
    Bun.write(path.join(source, "node_modules", "package", "index.js"), "throw new Error('not staged')\n"),
    Bun.write(path.join(outside, "external.py"), "print('outside')\n"),
  ])
  await Bun.write(path.join(source, "ignored", "large.bin"), "")
  await fs.truncate(path.join(source, "ignored", "large.bin"), ModalUpload.LIMIT + 1)
  await Promise.all([
    fs.symlink(outside, path.join(source, "external")),
    fs.symlink(path.join(source, "analysis.py"), path.join(source, "alias.py")),
  ])
  const modal = {
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none" as const,
    timeoutMinutes: 10,
    concurrency: 1,
  }

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const workspace = await SessionFilesystem.workspace(session.id)
      const tool = await createComputeJobTool({
        root,
        modal,
        credentials: { ...modal, tokenId: "ak", tokenSecret: "as" },
      }).init()

      const preview = await tool.execute(
        {
          action: "plan",
          name: "Filtered inputs",
          purpose: "Stage only bounded ordinary project files.",
          command: "python analysis.py",
          cwd: "filtered-analysis",
          target: { kind: "modal" },
          gpu: "none",
        },
        context(session.id, []),
      )

      const plan = preview.metadata.compute_job.plan
      if (plan?.provider !== "modal") throw new Error("compute_job did not return its Modal staging plan")
      expect(plan.uploads.map((file) => file.path)).toEqual([".gitignore", "analysis.py"])
      const staged = path.join(workspace, "filtered-analysis")
      expect(await Bun.file(path.join(staged, "analysis.py")).text()).toBe("print('approved')\n")
      expect(await Bun.file(path.join(staged, ".gitignore")).exists()).toBe(true)
      expect(await fs.lstat(path.join(staged, "alias.py")).catch(() => undefined)).toBeUndefined()
      expect(await fs.lstat(path.join(staged, "external")).catch(() => undefined)).toBeUndefined()
      expect(await fs.lstat(path.join(staged, "ignored")).catch(() => undefined)).toBeUndefined()
      expect(await fs.lstat(path.join(staged, "node_modules")).catch(() => undefined)).toBeUndefined()
      expect(await Bun.file(path.join(staged, ".env")).exists()).toBe(false)
    },
  })
})

test("rejects an oversized Project-files staging manifest before copying or approval", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  const source = path.join(tmp.path, "oversized-analysis")
  await fs.mkdir(source, { recursive: true })
  await Bun.write(path.join(source, "large.bin"), "")
  await fs.truncate(path.join(source, "large.bin"), ModalUpload.LIMIT + 1)
  const modal = {
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none" as const,
    timeoutMinutes: 10,
    concurrency: 1,
  }

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const workspace = await SessionFilesystem.workspace(session.id)
      const asked: Asked[] = []
      const tool = await createComputeJobTool({
        root,
        modal,
        credentials: { ...modal, tokenId: "ak", tokenSecret: "as" },
      }).init()

      await expect(
        tool.execute(
          {
            action: "start",
            name: "Oversized inputs",
            purpose: "Prove the copy is bounded before dispatch.",
            command: "python analysis.py",
            cwd: "oversized-analysis",
            target: { kind: "modal" },
            gpu: "none",
          },
          context(session.id, asked),
        ),
      ).rejects.toThrow("Modal staging input exceeds the 100 MiB approval limit")
      expect(asked).toEqual([])
      expect(await fs.lstat(path.join(workspace, "oversized-analysis")).catch(() => undefined)).toBeUndefined()
      expect((await fs.readdir(workspace)).some((name) => name.startsWith(".compute-stage-"))).toBe(false)
      expect(await ComputeJobs.list({ root, projectDirectory: tmp.path, workspace })).toEqual([])
    },
  })
})

test("explicit remote uploads narrow or disable the Project-files snapshot", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  const selected = path.join(tmp.path, "selected-analysis")
  const empty = path.join(tmp.path, "empty-analysis")
  const denied = path.join(tmp.path, "denied-analysis")
  await Promise.all([
    fs.mkdir(selected, { recursive: true }),
    fs.mkdir(empty, { recursive: true }),
    fs.mkdir(path.join(denied, ".ssh"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(path.join(selected, "analysis.py"), "print('selected')\n"),
    Bun.write(path.join(selected, "notes.txt"), "not selected\n"),
    Bun.write(path.join(selected, ".env"), "PRIVATE_TOKEN=secret\n"),
    Bun.write(path.join(empty, "analysis.py"), "print('not uploaded')\n"),
    Bun.write(path.join(denied, ".ssh", "id_ed25519"), "private key\n"),
  ])
  const modal = {
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none" as const,
    timeoutMinutes: 10,
    concurrency: 1,
  }

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const workspace = await SessionFilesystem.workspace(session.id)
      const tool = await createComputeJobTool({
        root,
        modal,
        credentials: { ...modal, tokenId: "ak", tokenSecret: "as" },
      }).init()

      const narrowed = await tool.execute(
        {
          action: "plan",
          name: "Selected inputs",
          purpose: "Stage only the explicit input.",
          command: "python analysis.py",
          cwd: "selected-analysis",
          uploads: ["analysis.py"],
          target: { kind: "modal" },
          gpu: "none",
        },
        context(session.id, []),
      )
      const narrowedPlan = narrowed.metadata.compute_job.plan
      if (narrowedPlan?.provider !== "modal") throw new Error("compute_job did not return its Modal upload plan")
      expect(narrowedPlan.uploads.map((file) => file.path)).toEqual(["analysis.py"])
      expect(await Bun.file(path.join(workspace, "selected-analysis", "analysis.py")).exists()).toBe(true)
      expect(await Bun.file(path.join(workspace, "selected-analysis", "notes.txt")).exists()).toBe(false)
      expect(await Bun.file(path.join(workspace, "selected-analysis", ".env")).exists()).toBe(false)

      const disabled = await tool.execute(
        {
          action: "plan",
          name: "No inputs",
          purpose: "Preserve the explicit no-input contract.",
          command: "python -c 'print(42)'",
          cwd: "empty-analysis",
          uploads: [],
          target: { kind: "modal" },
          gpu: "none",
        },
        context(session.id, []),
      )
      const disabledPlan = disabled.metadata.compute_job.plan
      if (disabledPlan?.provider !== "modal") throw new Error("compute_job did not return its no-input Modal plan")
      expect(disabledPlan.uploads).toEqual([])
      // Only the staging marker under .openscience: no project file was copied.
      expect(
        (await fs.readdir(path.join(workspace, "empty-analysis"))).filter((entry) => entry !== ".openscience"),
      ).toEqual([])

      await expect(
        tool.execute(
          {
            action: "plan",
            name: "Denied inputs",
            purpose: "Keep explicit denied inputs fail-closed.",
            command: "true",
            cwd: "denied-analysis",
            uploads: [".ssh/id_ed25519"],
            target: { kind: "modal" },
            gpu: "none",
          },
          context(session.id, []),
        ),
      ).rejects.toThrow("Modal staging upload policy denied: .ssh")
      expect(await fs.lstat(path.join(workspace, "denied-analysis")).catch(() => undefined)).toBeUndefined()
    },
  })
})

test("Modal stages the session workspace when cwd and uploads are omitted", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  const modal = {
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none" as const,
    timeoutMinutes: 10,
    concurrency: 1,
  }

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const workspace = await SessionFilesystem.workspace(session.id)
      await Promise.all([
        Bun.write(path.join(workspace, "analysis.py"), "print('session input')\n"),
        Bun.write(path.join(workspace, ".env"), "PRIVATE_TOKEN=secret\n"),
      ])
      const tool = await createComputeJobTool({
        root,
        modal,
        credentials: { ...modal, tokenId: "ak", tokenSecret: "as" },
      }).init()
      const workload = {
        name: "Session root inputs",
        purpose: "Use the prepared session script without an artificial cwd.",
        command: "python analysis.py",
        target: { kind: "modal" as const },
        gpu: "none" as const,
      }

      const defaults = await tool.execute({ action: "plan", ...workload }, context(session.id, []))
      const defaultPlan = defaults.metadata.compute_job.plan
      if (defaultPlan?.provider !== "modal") throw new Error("compute_job did not return its Modal plan")
      expect(defaultPlan.workspace_cwd).toBe(".")
      expect(defaultPlan.uploads.map((file) => file.path)).toEqual(["analysis.py"])

      const disabled = await tool.execute({ action: "plan", ...workload, uploads: [] }, context(session.id, []))
      const disabledPlan = disabled.metadata.compute_job.plan
      if (disabledPlan?.provider !== "modal") throw new Error("compute_job did not return its Modal plan")
      expect(disabledPlan.uploads).toEqual([])
    },
  })
})

test("rejects an unavailable or absolute compute cwd before approval and dispatch", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  const modal = {
    app: "openscience-test",
    image: "python:3.12-slim",
    network: "none" as const,
    timeoutMinutes: 10,
    concurrency: 1,
  }

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const workspace = await SessionFilesystem.workspace(session.id)
      const asked: Asked[] = []
      const tool = await createComputeJobTool({
        root,
        modal,
        credentials: { ...modal, tokenId: "ak", tokenSecret: "as" },
      }).init()
      const workload = {
        action: "start" as const,
        name: "Missing inputs",
        purpose: "Verify compute preflight.",
        command: "python analysis.py",
        target: { kind: "modal" as const },
        gpu: "none",
      }

      await expect(tool.execute({ ...workload, cwd: "missing-analysis" }, context(session.id, asked))).rejects.toThrow(
        'Compute working directory "missing-analysis" does not exist in Session scratch or Project files',
      )
      // The Project-files root is not a working directory; the refusal names
      // the shape to use instead of restating the rule.
      await expect(tool.execute({ ...workload, cwd: tmp.path }, context(session.id, asked))).rejects.toThrow(
        /Project files root itself.*relative to Session scratch or Project files/,
      )
      expect(asked).toEqual([])
      expect(await ComputeJobs.list({ root, projectDirectory: tmp.path, workspace })).toEqual([])
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

test("a mis-copied job id resolves to the one job it is closest to; an unresolvable id lists the jobs", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const workspace = await SessionFilesystem.workspace(session.id)
      const job = await start(tmp.path, root, session.id, { name: "null models", command: "printf done" })
      await ComputeJobs.wait(job.id, { root, workspace, timeout: 5_000 })
      const tool = await createComputeJobTool({ root, workspace }).init()
      const ctx = context(session.id, [])
      // The transcription errors seen in the field: a case flip, one hex
      // digit substituted, one character dropped; and the job's name.
      const flipped = job.id.slice(0, -1) + job.id.slice(-1).toUpperCase()
      const substituted = job.id.replace(/^./, (c) => (c === "f" ? "e" : "f"))
      const dropped = job.id.slice(0, 3) + job.id.slice(4)
      for (const spelling of [flipped, substituted, dropped, "null models"]) {
        const result = await tool.execute({ action: "status", job_id: spelling }, ctx)
        expect(result.output).toContain(job.id)
      }
      await expect(tool.execute({ action: "status", job_id: "no-such-job" }, ctx)).rejects.toThrow(
        `Jobs in this project: ${job.id} (null models,`,
      )
    },
  })
})

test("a job that outlives the dispatch grace comes back as a dispatch that will wake the session", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const workspace = await SessionFilesystem.workspace(session.id)
      using _grace = computeJobTesting({ settleGraceMs: 300 })
      const tool = await createComputeJobTool({ root, workspace }).init()
      const asked: Asked[] = []
      const dispatched = await tool.execute(
        {
          action: "start",
          name: "long fit",
          purpose: "A computation longer than the dispatch grace.",
          command: "sleep 2 && printf done",
          target: { kind: "local" },
        },
        context(session.id, asked),
      )
      const job = dispatched.metadata.job
      if (!job) throw new Error("compute_job did not return its started job")
      // Not settled within the grace: the model gets the dispatch, told the
      // job will wake it, rather than an invitation to poll.
      expect(dispatched.output).toContain(`Dispatched local job ${job.id}`)
      expect(dispatched.output).toMatch(/wake you with its outcome|compute_job wait/)
      expect(dispatched.output).not.toContain('"status": "succeeded"')
      const finished = await ComputeJobs.wait(job.id, { root, workspace, timeout: 10_000 })
      expect(finished.status).toBe("succeeded")
      // Once settled, a wait carries the output's tail and the deliveries.
      const waited = await tool.execute({ action: "wait", job_id: job.id, seconds: 5 }, context(session.id, []))
      expect(waited.output).toContain('"output_tail": "done"')
      expect(waited.output).toContain('"delivered"')
    },
  })
})

test("waits on a compute job without asking the model to run shell sleep", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const workspace = await SessionFilesystem.workspace(session.id)
      const job = await start(tmp.path, root, session.id, {
        name: "wait action",
        command: "sleep 0.5 && printf ready",
      })
      const tool = await createComputeJobTool({ root, workspace }).init()
      const result = await tool.execute({ action: "wait", job_id: job.id, seconds: 2 }, context(session.id, []))

      expect(result.output).toContain('"status": "succeeded"')
      expect(result.output).toContain('"timed_out": false')
      expect(result.output).toContain('"changed": [')
      expect(result.output).toContain('"state"')
      expect(await ComputeJobs.log(job.id, { root, workspace })).toContain("ready")
    },
  })
})

test("a chatty job does not end a wait: log lines are read with logs, the wait returns on state or timeout", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = path.join(tmp.path, "compute")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const workspace = await SessionFilesystem.workspace(session.id)
      const job = await start(tmp.path, root, session.id, {
        name: "chatty",
        command: "for i in 1 2 3 4 5 6; do echo tick $i; sleep 0.3; done",
      })
      const tool = await createComputeJobTool({ root, workspace }).init()
      const started = Date.now()
      // One second of ticks: earlier this returned after the first quiet gap
      // between lines; now the wait runs to its timeout while the job talks.
      const result = await tool.execute({ action: "wait", job_id: job.id, seconds: 1 }, context(session.id, []))
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
      expect(result.output).toContain('"timed_out": true')
      expect(result.output).toContain('"status": "running"')
      // And the finish is still what ends the next wait.
      const done = await tool.execute({ action: "wait", job_id: job.id, seconds: 10 }, context(session.id, []))
      expect(done.output).toContain('"status": "succeeded"')
      expect(done.output).toContain('"timed_out": false')
      expect(await ComputeJobs.log(job.id, { root, workspace })).toContain("tick 6")
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
