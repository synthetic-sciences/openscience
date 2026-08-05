import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ComputeJobs, ComputeJobsCorruptError } from "../../src/compute/jobs"
import { ModalAdapter } from "../../src/compute/modal/adapter"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { OpenScience } from "../../src/openscience"
import { Sandbox } from "../../src/sandbox/sandbox"
import { ExecutionAuthority } from "../../src/project/execution"
import { tmpdir, trustProject } from "../fixture/fixture"

type StartOptions = NonNullable<Parameters<typeof ComputeJobs.start>[1]>

const modal = {
  app: "openscience-test",
  image: "python:3.12-slim",
  network: "none" as const,
  timeoutMinutes: 10,
  concurrency: 1,
}
const credentials = { ...modal, tokenId: "ak-test", tokenSecret: "as-test" }

function modalProvider(overrides: Partial<ComputeJobs.ModalProvider> = {}): ComputeJobs.ModalProvider {
  return {
    volume: (project, id) => `test-${Bun.hash(`${project}\0${id}`)}`,
    run: async () => ({ code: 0, outputs: [] }),
    recover: async () => ({ code: 0, outputs: [] }),
    find: async () => undefined,
    close: async () => undefined,
    release: async () => undefined,
    ...overrides,
  }
}

async function start(input: ComputeJobs.Input, options: StartOptions) {
  if (!options.workspace) throw new Error("Compute test start requires an explicit workspace")
  return Instance.provide({
    directory: options.workspace,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      return ComputeJobs.start({ ...input, sessionID: session.id }, options)
    },
  })
}

describe("ComputeJobs command adapters", () => {
  const host = {
    id: "cluster",
    label: "Lab cluster",
    host: "hpc.example.org",
    user: "researcher",
    port: 2222,
    scheduler: "slurm" as const,
    workdir: "/scratch/team project",
  }

  test("builds a non-interactive SSH command for a Slurm job", () => {
    const command = ComputeJobs.command(
      {
        id: "job-123",
        name: "RNA benchmark",
        command: "python train.py --label 'A B'",
        cwd: "/scratch/team project",
        resources: {
          cpus: 8,
          gpus: 2,
          memory_gb: 48,
          time_minutes: 95,
          partition: "gpu-long",
        },
        modules: ["cuda/12.4", "python/3.12"],
        container: "/containers/research image.sif",
      },
      host,
    )

    expect(command.argv.slice(0, 7)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-p", "2222"])
    expect(command.argv).toContain("researcher@hpc.example.org")
    expect(command.argv.at(-1)).toContain("sbatch --wait --parsable")
    expect(command.argv.at(-1)).toContain("--cpus-per-task=8")
    expect(command.argv.at(-1)).toContain("--gres=gpu:2")
    expect(command.argv.at(-1)).toContain("--mem=48G")
    expect(command.argv.at(-1)).toContain("--time=01:35:00")
    expect(command.argv.at(-1)).toContain("--partition='gpu-long'")
    expect(command.argv.at(-1)).toContain("module load")
    expect(command.argv.at(-1)).toContain("cuda/12.4")
    expect(command.argv.at(-1)).toContain("python/3.12")
    expect(command.argv.at(-1)).toContain("apptainer exec")
    expect(command.argv.at(-1)).toContain("/containers/research image.sif")
    expect(command.argv.at(-1)).toContain("os-job-123")
    expect(command.argv.at(-1)).toContain("python train.py")
  })

  test("builds PBS and direct SSH adapters from the same profile", () => {
    const input = {
      id: "job-9",
      name: "Variant call",
      command: "bash pipeline.sh",
      cwd: "/work",
      resources: { cpus: 4, gpus: 1, memory_gb: 16, time_minutes: 30 },
    }
    const pbs = ComputeJobs.command(input, { ...host, scheduler: "pbs" }).argv.at(-1)
    expect(pbs).toContain("qsub")
    expect(pbs).toContain("select=1:ncpus=4:ngpus=1:mem=16gb")
    expect(pbs).toContain("walltime=00:30:00")
    expect(ComputeJobs.command(input, { ...host, scheduler: "none" }).argv.at(-1)).toContain("exec")
  })
})

describe("ComputeJobs persistence", () => {
  for (const [label, bytes] of [
    ["truncated JSON", '[{"id":"historic"'],
    ["structurally invalid job", '[{"id":"historic","status":"running"}]'],
  ] as const) {
    test(`fails closed on ${label} without changing its bytes`, async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "state")
      const filepath = path.join(root, "jobs.json")
      await fs.mkdir(root)
      await fs.writeFile(filepath, bytes, { mode: 0o600 })

      await expect(ComputeJobs.list({ root, workspace: tmp.path })).rejects.toBeInstanceOf(ComputeJobsCorruptError)
      expect(await Bun.file(filepath).text()).toBe(bytes)
      expect(await Bun.file(`${filepath}.corrupt-${process.pid}`).exists()).toBe(false)
    })
  }

  test("refuses clear, cancel, and start mutations while preserving corrupt history", async () => {
    await using tmp = await tmpdir()
    const bytes = '[{"id":"historic"'
    const launched = path.join(tmp.path, "launched.txt")
    const cases = [
      {
        name: "clear",
        run: (root: string) => ComputeJobs.clear({ root, workspace: tmp.path }),
      },
      {
        name: "cancel",
        run: (root: string) => ComputeJobs.cancel("historic", { root, workspace: tmp.path }),
      },
      {
        name: "start",
        run: (root: string) =>
          start(
            {
              name: "must not replace history",
              command: `printf launched > ${ComputeJobs.quote(launched)}`,
              target: { kind: "local" },
            },
            { root, workspace: tmp.path },
          ),
      },
    ]

    for (const item of cases) {
      const root = path.join(tmp.path, item.name)
      const filepath = path.join(root, "jobs.json")
      const backup = `${filepath}.corrupt-${process.pid}`
      await fs.mkdir(root)
      await fs.writeFile(filepath, bytes, { mode: 0o600 })

      await expect(item.run(root)).rejects.toThrow(/Refusing to overwrite/)
      expect(await Bun.file(filepath).text()).toBe(bytes)
      expect(await Bun.file(backup).text()).toBe(bytes)
      expect((await fs.stat(backup)).mode & 0o777).toBe(0o600)
    }
    expect(await Bun.file(launched).exists()).toBe(false)
  })

  test("ignores an interrupted sibling temp file and publishes a complete replacement", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const filepath = path.join(root, "jobs.json")
    const partial = `${filepath}.${process.pid}.interrupted.tmp`
    const fragment = '[{"id":"interrupted"'
    await fs.mkdir(root)
    await fs.writeFile(filepath, "[]", { mode: 0o600 })
    await fs.writeFile(partial, fragment, { mode: 0o600 })

    const job = await start(
      {
        name: "atomic persistence",
        command: "true",
        target: { kind: "local" },
      },
      { root, workspace: tmp.path },
    )
    const finished = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })
    const persisted = ComputeJobs.Job.array().parse(JSON.parse(await Bun.file(filepath).text()))
    const temps = (await fs.readdir(root)).filter((file) => file.startsWith("jobs.json.") && file.endsWith(".tmp"))

    expect(finished.status).toBe("succeeded")
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.id).toBe(job.id)
    expect(await Bun.file(partial).text()).toBe(fragment)
    expect(temps).toEqual([path.basename(partial)])
  })
})

describe("ComputeJobs local lifecycle", () => {
  test("rejects a missing working directory before recording a job", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const cwd = path.join(tmp.path, "missing")
    await expect(
      start(
        {
          name: "missing cwd",
          command: "printf unreachable",
          cwd,
          target: { kind: "local" },
        },
        { root, workspace: tmp.path },
      ),
    ).rejects.toThrow("must be inside the session workspace")
    expect(await ComputeJobs.list({ root, workspace: tmp.path })).toEqual([])
  })

  test("runs a real local job, persists status, and streams its log", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const job = await start(
      {
        name: "deterministic smoke",
        command: "printf 'alpha\\nbeta\\n'",
        cwd: tmp.path,
        target: { kind: "local" },
      },
      { root, workspace: tmp.path },
    )

    const finished = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })
    expect(job.provenance).toMatchObject({
      format: "openscience.provenance.v1",
      kind: "local_compute",
      identity: {
        project_id: { status: "available", value: job.authority?.projectID },
        session_id: { status: "available", value: job.session_id },
        run_id: { status: "available", value: job.id },
      },
      input: {
        code: { status: "available", value: "printf 'alpha\\nbeta\\n'" },
        cwd: { status: "available", value: tmp.path },
        code_state: { status: "unavailable", reason: "not_captured" },
      },
      outputs: { status: "queued", items: [] },
      timestamps: {
        created_at: { status: "available" },
        started_at: { status: "unavailable", reason: "not_captured" },
        completed_at: { status: "unavailable", reason: "not_captured" },
      },
      handoff: {
        atlas_compute_id: { status: "unavailable", reason: "not_implemented" },
        atlas_run_id: { status: "unavailable", reason: "not_published" },
      },
    })
    expect(finished.status).toBe("succeeded")
    expect(finished.exit_code).toBe(0)
    expect(finished.lifecycle).toMatchObject({
      execution: "succeeded",
      delivery: "none",
      resource: "closed",
      recoverable: false,
    })
    expect(await ComputeJobs.log(job.id, { root, workspace: tmp.path })).toContain("alpha\nbeta")
    expect(finished.reproducibility).toMatchObject({
      platform: process.platform,
      arch: process.arch,
      command: "printf 'alpha\\nbeta\\n'",
    })
    expect(finished.provenance).toMatchObject({
      outputs: { status: "succeeded", items: [] },
      environment: {
        host: {
          status: "available",
          value: { platform: process.platform, arch: process.arch },
        },
        kernel: { status: "unavailable", reason: "not_applicable" },
      },
      timestamps: {
        started_at: { status: "available" },
        completed_at: { status: "available" },
      },
    })
    expect((await fs.stat(path.join(root, "jobs.json"))).mode & 0o777).toBe(0o600)
    expect((await fs.readdir(root)).filter((file) => file.endsWith(".tmp"))).toEqual([])
  })

  test("captures output artifacts, checksums, lockfiles, and checkpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = path.join(tmp.path, "state")
    await Bun.write(path.join(tmp.path, "requirements.txt"), "numpy==2.2.0\n")
    const job = await start(
      {
        name: "artifact capture",
        command:
          "mkdir -p outputs checkpoints && printf 'metric,value\\nloss,0.1\\n' > outputs/results.csv && printf model > checkpoints/latest.ckpt",
        cwd: tmp.path,
        target: { kind: "local" },
        artifacts: ["outputs/**/*.csv"],
        checkpoint: "checkpoints/latest.ckpt",
        resources: { cpus: 2, memory_gb: 4 },
      },
      { root, workspace: tmp.path },
    )

    const finished = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })
    expect(finished.artifacts).toHaveLength(1)
    expect(finished.artifacts?.[0]).toMatchObject({
      path: "outputs/results.csv",
      size: 22,
    })
    expect(finished.artifacts?.[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(finished.checkpoint).toMatchObject({
      path: "checkpoints/latest.ckpt",
      size: 5,
    })
    expect(finished.reproducibility?.git?.dirty).toBe(true)
    expect(finished.reproducibility?.lockfiles).toContainEqual(
      expect.objectContaining({
        path: "requirements.txt",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    )
    expect(finished.provenance?.outputs.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "artifact",
          path: { status: "available", value: "outputs/results.csv" },
          sha256: finished.artifacts?.[0]?.sha256,
          version_id: { status: "unavailable", reason: "not_versioned" },
          version: { status: "unavailable", reason: "not_versioned" },
        }),
        expect.objectContaining({
          kind: "checkpoint",
          path: { status: "available", value: "checkpoints/latest.ckpt" },
          sha256: finished.checkpoint?.sha256,
          version_id: { status: "unavailable", reason: "not_versioned" },
          version: { status: "unavailable", reason: "not_versioned" },
        }),
      ]),
    )
  })

  test("captures the code state before a local job mutates the workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = path.join(tmp.path, "state")
    const job = await start(
      {
        name: "pre-run snapshot",
        command: "printf generated > result.txt",
        cwd: tmp.path,
        target: { kind: "local" },
        artifacts: ["result.txt"],
      },
      { root, workspace: tmp.path },
    )

    expect(job.reproducibility?.git?.dirty).toBe(false)
    expect(job.provenance?.input.code_state).toMatchObject({
      status: "available",
      value: {
        commit: { status: "available", value: expect.stringMatching(/^[a-f0-9]{40}$/) },
        dirty: { status: "available", value: false },
      },
    })
    const finished = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })
    expect(finished.reproducibility?.git?.dirty).toBe(false)
    expect(finished.provenance?.outputs.items[0]).toMatchObject({
      path: { status: "available", value: "result.txt" },
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(await Bun.file(path.join(tmp.path, "result.txt")).exists()).toBe(true)
  })

  test("redacts command and env-like job fields before durable persistence", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const secret = `compute-persistence-${crypto.randomUUID()}`
    OpenScience.registerSecretValues([secret])
    const job = await start(
      {
        name: "secret persistence",
        command: `printf complete >/dev/null # ${secret}`,
        cwd: tmp.path,
        target: { kind: "local" },
        modules: [`CUSTOM_TOKEN=${secret}`],
      },
      { root, workspace: tmp.path },
    )

    const finished = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })
    const persisted = await Bun.file(path.join(root, "jobs.json")).text()
    expect(finished.status).toBe("succeeded")
    expect(finished.command).toContain("[REDACTED]")
    expect(finished.modules).toEqual(["CUSTOM_TOKEN=[REDACTED]"])
    expect(persisted).not.toContain(secret)
    expect(persisted).toContain("[REDACTED]")
  })

  test("cancels a running local process tree", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const job = await start(
      {
        name: "cancel smoke",
        command: "sleep 30",
        cwd: tmp.path,
        target: { kind: "local" },
      },
      { root, workspace: tmp.path },
    )

    await ComputeJobs.cancel(job.id, { root, workspace: tmp.path })
    const cancelled = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.lifecycle).toMatchObject({ execution: "cancelled", resource: "closed" })
  })

  test("cancels active jobs by owning session without touching sibling sessions", async () => {
    if (!Sandbox.available()) return
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const first = await Session.create({})
        const second = await Session.create({})
        const [one, two] = await Promise.all([
          ComputeJobs.start(
            {
              sessionID: first.id,
              name: "first session",
              command: "sleep 30",
              target: { kind: "local" },
            },
            { root, workspace: tmp.path },
          ),
          ComputeJobs.start(
            {
              sessionID: second.id,
              name: "second session",
              command: "sleep 30",
              target: { kind: "local" },
            },
            { root, workspace: tmp.path },
          ),
        ])
        for (const _ of Array.from({ length: 100 })) {
          const current = await ComputeJobs.get(one.id, { root, workspace: tmp.path })
          if (current?.status === "running") break
          await Bun.sleep(20)
        }

        expect(await ComputeJobs.cancelSession(first.id)).toBe(1)
        expect((await ComputeJobs.wait(one.id, { root, workspace: tmp.path, timeout: 5_000 })).status).toBe("cancelled")
        expect((await ComputeJobs.get(two.id, { root, workspace: tmp.path }))?.status).toBe("running")
        await ComputeJobs.cancel(two.id, { root, workspace: tmp.path })
      },
    })
  })

  test("does not relabel a completed job when cancellation arrives late", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const job = await start(
      {
        name: "late cancel",
        command: "true",
        cwd: tmp.path,
        target: { kind: "local" },
      },
      { root, workspace: tmp.path },
    )

    const completed = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })
    expect(completed.status).toBe("succeeded")
    const unchanged = await ComputeJobs.cancel(job.id, { root, workspace: tmp.path })
    expect(unchanged.status).toBe("succeeded")
  })

  test("recovers a completed detached job from its durable exit marker", async () => {
    const root = await fs.mkdtemp(path.join(import.meta.dir, "jobs-recovery-"))
    const id = "recovered-job"
    await fs.mkdir(path.join(root, "jobs"), { recursive: true })
    await Bun.write(
      path.join(root, "jobs.json"),
      JSON.stringify([
        {
          id,
          name: "recovered",
          command: "true",
          target: { kind: "local" },
          target_label: "This computer",
          scheduler: "none",
          status: "running",
          created_at: new Date(Date.now() - 10_000).toISOString(),
          started_at: new Date(Date.now() - 9_000).toISOString(),
          pid: 999_999,
        },
      ]),
    )
    await Bun.write(path.join(root, "jobs", `${id}.exit`), "0")

    const job = (await ComputeJobs.list({ root, workspace: root })).find((item) => item.id === id)
    expect(job?.status).toBe("succeeded")
    expect(job?.exit_code).toBe(0)
    expect(job?.lifecycle).toMatchObject({ execution: "succeeded", resource: "closed" })
    expect(job?.provenance).toMatchObject({
      format: "openscience.provenance.v1",
      identity: {
        run_id: { status: "available", value: id },
      },
      outputs: { status: "succeeded" },
      timestamps: {
        completed_at: { status: "available" },
      },
    })
    await fs.rm(root, { recursive: true, force: true })
  })
})

describe("ComputeJobs Modal governance", () => {
  test("records a Modal sandbox timeout as a terminal timed-out job", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const provider = modalProvider({
      run: async (_context, spec, hooks) => {
        await hooks.created(`sandbox-${spec.id}`)
        return { code: 124, outputs: [], timedOut: true }
      },
      recover: async () => ({ code: 124, outputs: [], timedOut: true }),
    })
    const request = {
      name: "timed out modal job",
      command: "sleep 900",
      target: { kind: "modal" as const },
      gpu: "T4",
      resources: { time_minutes: 10 },
    }
    const prepared = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const plan = await ComputeJobs.plan({ ...request, sessionID: session.id }, { root, workspace: tmp.path, modal })
        return { session, plan }
      },
    })
    const job = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        ComputeJobs.start(
          { ...request, sessionID: prepared.session.id, approval: prepared.plan.digest },
          { root, workspace: tmp.path, modal, credentials, provider },
        ),
    })
    const finished = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })

    expect(finished.status).toBe("failed")
    expect(finished.exit_code).toBe(124)
    expect(finished.error).toBe("Modal job timed out after 10 minutes")
    expect(finished.lifecycle).toMatchObject({
      execution: "timed_out",
      deadline_fired: true,
      delivery: "none",
      resource: "closed",
    })
  })

  test("refuses another paid dispatch after the project reaches its configured concurrency", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const gate = Promise.withResolvers<void>()
    const provider = modalProvider({
      run: async (_context, spec, hooks) => {
        await hooks.created(`sandbox-${spec.id}`)
        await gate.promise
        return { code: 0, outputs: [] }
      },
      release: async () => gate.resolve(),
    })
    const request = {
      name: "held modal job",
      command: "sleep 30",
      target: { kind: "modal" as const },
      gpu: "none",
    }
    const firstPlan = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        return {
          session,
          plan: await ComputeJobs.plan({ ...request, sessionID: session.id }, { root, workspace: tmp.path, modal }),
        }
      },
    })
    const secondPlan = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        return {
          session,
          plan: await ComputeJobs.plan({ ...request, sessionID: session.id }, { root, workspace: tmp.path, modal }),
        }
      },
    })
    const attempts = await Promise.allSettled([
      Instance.provide({
        directory: tmp.path,
        fn: () =>
          ComputeJobs.start(
            { ...request, sessionID: firstPlan.session.id, approval: firstPlan.plan.digest },
            { root, workspace: tmp.path, modal, credentials, provider },
          ),
      }),
      Instance.provide({
        directory: tmp.path,
        fn: () =>
          ComputeJobs.start(
            { ...request, sessionID: secondPlan.session.id, approval: secondPlan.plan.digest },
            { root, workspace: tmp.path, modal, credentials, provider },
          ),
      }),
    ])
    const started = attempts.filter((attempt) => attempt.status === "fulfilled")
    const refused = attempts.filter((attempt) => attempt.status === "rejected")

    expect(started).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(refused[0]?.reason).toBeInstanceOf(Error)
    expect((refused[0] as PromiseRejectedResult).reason.message).toContain("Modal concurrency limit reached")
    const first = (started[0] as PromiseFulfilledResult<ComputeJobs.Job>).value
    expect(first.modal?.volume).toStartWith("test-")

    await ComputeJobs.cancel(first.id, { root, workspace: tmp.path, credentials, provider })
  })

  test("warns when Modal does not confirm that cancellation stopped billing", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const gate = Promise.withResolvers<void>()
    const releases = { count: 0 }
    const provider = modalProvider({
      run: async (_context, spec, hooks) => {
        await hooks.created(`sandbox-${spec.id}`)
        await gate.promise
        return { code: 0, outputs: [] }
      },
      release: async () => {
        gate.resolve()
        releases.count++
        if (releases.count === 1) throw new Error("provider unavailable")
      },
    })
    const request = {
      name: "cancel modal job",
      command: "sleep 30",
      target: { kind: "modal" as const },
      gpu: "none",
    }
    const prepared = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const plan = await ComputeJobs.plan({ ...request, sessionID: session.id }, { root, workspace: tmp.path, modal })
        return { session, plan }
      },
    })
    const job = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        ComputeJobs.start(
          { ...request, sessionID: prepared.session.id, approval: prepared.plan.digest },
          { root, workspace: tmp.path, modal, credentials, provider },
        ),
    })

    const cancelled = await ComputeJobs.cancel(job.id, { root, workspace: tmp.path, credentials, provider })

    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.lifecycle?.resource).toBe("unknown")
    expect(cancelled.cleanup_error).toContain("may still be billing")
    expect(cancelled.error).toBeUndefined()
    expect(await ComputeJobs.events(job.id, { root, workspace: tmp.path })).toContain("may still be billing")
    expect(await ComputeJobs.clear({ root, workspace: tmp.path })).toBe(0)

    const released = await ComputeJobs.cancel(job.id, { root, workspace: tmp.path, credentials, provider })
    expect(released.lifecycle?.resource).toBe("closed")
    expect(released.cleanup_error).toBeUndefined()
    expect(released.error).toBeUndefined()
    expect(await ComputeJobs.clear({ root, workspace: tmp.path })).toBe(1)
  })

  test("keeps a completed job recoverable when final Modal cleanup fails", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const releases = { count: 0 }
    const provider = modalProvider({
      run: async (_context, spec, hooks) => {
        await hooks.created(`sandbox-${spec.id}`)
        return { code: 0, outputs: [] }
      },
      release: async () => {
        releases.count++
        if (releases.count === 1) throw new Error("provider unavailable")
      },
    })
    const request = {
      name: "complete modal job",
      command: "true",
      target: { kind: "modal" as const },
      gpu: "none",
    }
    const prepared = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const plan = await ComputeJobs.plan({ ...request, sessionID: session.id }, { root, workspace: tmp.path, modal })
        return { session, plan }
      },
    })
    const job = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        ComputeJobs.start(
          { ...request, sessionID: prepared.session.id, approval: prepared.plan.digest },
          { root, workspace: tmp.path, modal, credentials, provider },
        ),
    })
    await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })
    await Bun.sleep(20)
    const finished = await ComputeJobs.get(job.id, { root, workspace: tmp.path })

    expect(finished?.status).toBe("succeeded")
    expect(finished?.lifecycle?.resource).toBe("unknown")
    expect(finished?.cleanup_error).toContain("may still be billing")
    expect(finished?.error).toBeUndefined()
    expect(await ComputeJobs.clear({ root, workspace: tmp.path })).toBe(0)

    const released = await ComputeJobs.cancel(job.id, { root, workspace: tmp.path, credentials, provider })
    expect(released.status).toBe("succeeded")
    expect(released.lifecycle?.resource).toBe("closed")
    expect(released.cleanup_error).toBeUndefined()
    expect(released.error).toBeUndefined()
  })

  test("retries delivery from the durable Modal resource without rerunning the command", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const calls = { run: 0, recover: 0, release: 0 }
    const provider = modalProvider({
      run: async (_context, spec, hooks) => {
        calls.run++
        await hooks.created(`sandbox-${spec.id}`)
        return { code: 0, outputs: [{ path: "../escape", staging: tmp.path, size: 0 }] }
      },
      recover: async (_context, spec, id, hooks) => {
        calls.recover++
        expect(id).toBe(`sandbox-${spec.id}`)
        expect(await ComputeJobs.log(spec.id, { root, workspace: tmp.path })).toBe("last visible output\n")
        await hooks.output("recovered output\n")
        const staging = path.join(tmp.path, "recovered", "result.txt")
        await Bun.write(staging, "recovered")
        return { code: 0, outputs: [{ path: "result.txt", staging, size: 9 }] }
      },
      release: async () => {
        calls.release++
      },
    })
    const request = {
      name: "recover output",
      command: "printf recovered > result.txt",
      target: { kind: "modal" as const },
      gpu: "none",
      artifacts: ["result.txt"],
    }
    const prepared = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const plan = await ComputeJobs.plan({ ...request, sessionID: session.id }, { root, workspace: tmp.path, modal })
        return { session, plan }
      },
    })
    const job = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        ComputeJobs.start(
          { ...request, sessionID: prepared.session.id, approval: prepared.plan.digest },
          { root, workspace: tmp.path, modal, credentials, provider },
        ),
    })
    const delivery = async (attempts = 100): Promise<ComputeJobs.Job> => {
      const current = await ComputeJobs.get(job.id, { root, workspace: tmp.path })
      if (current?.lifecycle?.delivery === "failed") return current
      if (!attempts) throw new Error("Timed out waiting for recoverable Modal output")
      await Bun.sleep(20)
      return delivery(attempts - 1)
    }
    const failed = await delivery()

    expect(failed.status).toBe("succeeded")
    expect(failed.lifecycle?.recoverable).toBe(true)
    expect(calls).toEqual({ run: 1, recover: 0, release: 0 })

    await Bun.write(path.join(root, "jobs", `${job.id}.log`), "last visible output\n")
    await ComputeJobs.retry(job.id, { root, workspace: tmp.path, credentials, provider })
    const complete = async (attempts = 100): Promise<ComputeJobs.Job> => {
      const current = await ComputeJobs.get(job.id, { root, workspace: tmp.path })
      if (current?.lifecycle?.resource === "closed") return current
      if (!attempts) throw new Error("Timed out waiting for Modal output recovery")
      await Bun.sleep(20)
      return complete(attempts - 1)
    }
    const recovered = await complete()

    expect(recovered.status).toBe("succeeded")
    expect(recovered.lifecycle).toMatchObject({ delivery: "complete", resource: "closed", recoverable: false })
    expect(await ComputeJobs.log(job.id, { root, workspace: tmp.path })).toBe("recovered output\n")
    expect(await Bun.file(path.join(tmp.path, "result.txt")).text()).toBe("recovered")
    expect(calls).toEqual({ run: 1, recover: 1, release: 1 })
  })

  test("retains a completed Modal Volume when its first control-plane download fails", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const calls = { run: 0, recover: 0, release: 0 }
    const provider = modalProvider({
      run: async (_context, spec, hooks) => {
        calls.run++
        await hooks.created(`sandbox-${spec.id}`)
        throw new ModalAdapter.HarvestError(0, new Error("control plane unavailable"))
      },
      recover: async () => {
        calls.recover++
        return { code: 0, outputs: [] }
      },
      release: async () => {
        calls.release++
      },
    })
    const request = {
      name: "recover direct volume",
      command: "true",
      target: { kind: "modal" as const },
      gpu: "none",
    }
    const prepared = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const plan = await ComputeJobs.plan({ ...request, sessionID: session.id }, { root, workspace: tmp.path, modal })
        return { session, plan }
      },
    })
    const job = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        ComputeJobs.start(
          { ...request, sessionID: prepared.session.id, approval: prepared.plan.digest },
          { root, workspace: tmp.path, modal, credentials, provider },
        ),
    })
    const delivery = async (attempts = 100): Promise<ComputeJobs.Job> => {
      const current = await ComputeJobs.get(job.id, { root, workspace: tmp.path })
      if (current?.lifecycle?.delivery === "failed") return current
      if (!attempts) throw new Error("Timed out waiting for recoverable Modal Volume")
      await Bun.sleep(20)
      return delivery(attempts - 1)
    }
    const failed = await delivery()

    expect(failed.status).toBe("succeeded")
    expect(failed.exit_code).toBe(0)
    expect(failed.lifecycle).toMatchObject({ delivery: "failed", resource: "unknown", recoverable: true })
    expect(calls).toEqual({ run: 1, recover: 0, release: 0 })

    await ComputeJobs.retry(job.id, { root, workspace: tmp.path, credentials, provider })
    const complete = async (attempts = 100): Promise<ComputeJobs.Job> => {
      const current = await ComputeJobs.get(job.id, { root, workspace: tmp.path })
      if (current?.lifecycle?.resource === "closed") return current
      if (!attempts) throw new Error("Timed out waiting for direct Modal Volume recovery")
      await Bun.sleep(20)
      return complete(attempts - 1)
    }
    const recovered = await complete()

    expect(recovered.status).toBe("succeeded")
    expect(recovered.lifecycle).toMatchObject({ delivery: "complete", resource: "closed", recoverable: false })
    expect(calls).toEqual({ run: 1, recover: 1, release: 1 })
  })

  test("retains the Volume when a declared output is missing, truncated, or corrupt", async () => {
    for (const mismatch of ["missing", "truncated", "corrupt"] as const) {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "state")
      const calls = { release: 0 }
      const staging = path.join(tmp.path, "staging", "result.txt")
      await fs.mkdir(path.dirname(staging), { recursive: true })
      await Bun.write(staging, "short")
      const provider = modalProvider({
        run: async (_context, spec, hooks) => {
          await hooks.created(`sandbox-${spec.id}`)
          return {
            code: 0,
            outputs:
              mismatch === "missing"
                ? []
                : [{ path: "result.txt", staging, size: mismatch === "truncated" ? 100 : 5, sha256: "a".repeat(64) }],
          }
        },
        release: async () => {
          calls.release++
        },
      })
      const request = {
        name: `${mismatch} Modal output`,
        command: "true",
        target: { kind: "modal" as const },
        gpu: "none",
        artifacts: ["result.txt"],
      }
      const prepared = await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await trustProject()
          const session = await Session.create({})
          const plan = await ComputeJobs.plan(
            { ...request, sessionID: session.id },
            { root, workspace: tmp.path, modal },
          )
          return { session, plan }
        },
      })
      const job = await Instance.provide({
        directory: tmp.path,
        fn: () =>
          ComputeJobs.start(
            { ...request, sessionID: prepared.session.id, approval: prepared.plan.digest },
            { root, workspace: tmp.path, modal, credentials, provider },
          ),
      })

      const finished = await ComputeJobs.wait(job.id, {
        root,
        workspace: tmp.path,
        credentials,
        provider,
        timeout: 5_000,
      })

      expect(finished.lifecycle).toMatchObject({ delivery: "failed", resource: "unknown", recoverable: true })
      expect(finished.capture_error).toContain(
        mismatch === "missing" ? "did not produce" : mismatch === "truncated" ? "size changed" : "checksum changed",
      )
      expect(calls.release).toBe(0)
    }
  })

  test("retains the Volume when a successful command misses a declared glob", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const calls = { release: 0 }
    const provider = modalProvider({
      run: async (_context, spec, hooks) => {
        await hooks.created(`sandbox-${spec.id}`)
        return { code: 0, outputs: [] }
      },
      release: async () => {
        calls.release++
      },
    })
    const request = {
      name: "missing glob output",
      command: "true",
      target: { kind: "modal" as const },
      gpu: "none",
      artifacts: ["outputs/*.json"],
    }
    const prepared = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const plan = await ComputeJobs.plan({ ...request, sessionID: session.id }, { root, workspace: tmp.path, modal })
        return { session, plan }
      },
    })
    const job = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        ComputeJobs.start(
          { ...request, sessionID: prepared.session.id, approval: prepared.plan.digest },
          { root, workspace: tmp.path, modal, credentials, provider },
        ),
    })

    const finished = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })

    expect(finished.status).toBe("succeeded")
    expect(finished.lifecycle).toMatchObject({ delivery: "failed", resource: "unknown", recoverable: true })
    expect(finished.capture_error).toContain("outputs/*.json")
    expect(calls.release).toBe(0)
  })

  test("does not require declared outputs from a failed Modal command", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const calls = { release: 0 }
    const provider = modalProvider({
      run: async (_context, spec, hooks) => {
        await hooks.created(`sandbox-${spec.id}`)
        return { code: 1, outputs: [] }
      },
      release: async () => {
        calls.release++
      },
    })
    const request = {
      name: "failed without checkpoint",
      command: "exit 1",
      target: { kind: "modal" as const },
      gpu: "none",
      checkpoint: "checkpoint.pt",
    }
    await Bun.write(path.join(tmp.path, "checkpoint.pt"), "stale local checkpoint")
    const prepared = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const plan = await ComputeJobs.plan({ ...request, sessionID: session.id }, { root, workspace: tmp.path, modal })
        return { session, plan }
      },
    })
    const job = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        ComputeJobs.start(
          { ...request, sessionID: prepared.session.id, approval: prepared.plan.digest },
          { root, workspace: tmp.path, modal, credentials, provider },
        ),
    })

    const finished = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })

    expect(finished.status).toBe("failed")
    expect(finished.lifecycle).toMatchObject({ delivery: "complete", resource: "closed", recoverable: false })
    expect(finished.checkpoint).toBeUndefined()
    expect(calls.release).toBe(1)
  })

  test("resumes terminal pending delivery after an OpenScience restart", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const calls = { credentials: 0, recover: 0, release: 0 }
    const id = "terminal-pending"
    const staging = path.join(tmp.path, "staging", "result.txt")
    await fs.mkdir(path.dirname(staging), { recursive: true })
    await Bun.write(staging, "recovered")
    const provider = modalProvider({
      recover: async () => {
        calls.recover++
        return { code: 0, outputs: [{ path: "result.txt", staging, size: 9 }] }
      },
      release: async () => {
        calls.release++
      },
    })
    const authority = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        return ExecutionAuthority.require({
          projectID: Instance.project.id,
          sessionID: session.id,
          capability: "remote_job",
        })
      },
    })
    const volume = provider.volume(tmp.path, id)
    const job = ComputeJobs.Job.parse({
      id,
      name: "restart delivery",
      command: "true",
      cwd: tmp.path,
      target: { kind: "modal" },
      target_label: "Modal",
      scheduler: "none",
      status: "succeeded",
      created_at: new Date(Date.now() - 10_000).toISOString(),
      started_at: new Date(Date.now() - 9_000).toISOString(),
      completed_at: new Date(Date.now() - 1_000).toISOString(),
      exit_code: 0,
      artifact_patterns: ["result.txt"],
      authority,
      lifecycle: { execution: "succeeded", delivery: "pending", resource: "active", recoverable: false },
      remote_id: "sandbox-terminal-pending",
      modal: {
        app: modal.app,
        image: modal.image,
        packages: [],
        gpu: "none",
        network: modal.network,
        timeout_minutes: modal.timeoutMinutes,
        uploads: [],
        upload_bytes: 0,
        approval: "a".repeat(64),
        sdk: ModalAdapter.VERSION,
        volume,
      },
    })
    await fs.mkdir(root, { recursive: true })
    await Bun.write(path.join(root, "jobs.json"), JSON.stringify([job]))

    const resolve = async () => {
      calls.credentials++
      await Bun.sleep(30)
      return credentials
    }
    await Promise.all([
      ComputeJobs.list({ root, workspace: tmp.path, resolveCredentials: resolve, provider }),
      ComputeJobs.list({ root, workspace: tmp.path, resolveCredentials: resolve, provider }),
    ])
    const finished = await ComputeJobs.wait(id, {
      root,
      workspace: tmp.path,
      resolveCredentials: resolve,
      provider,
      timeout: 5_000,
    })
    await ComputeJobs.list({
      root,
      workspace: tmp.path,
      resolveCredentials: async () => {
        calls.credentials++
        return credentials
      },
      provider,
    })

    expect(finished.lifecycle).toMatchObject({ delivery: "complete", resource: "closed", recoverable: false })
    expect(await Bun.file(path.join(tmp.path, "result.txt")).text()).toBe("recovered")
    expect(calls).toEqual({ credentials: 1, recover: 1, release: 1 })
  })

  test("returns the attached Modal status on the first list after restart", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const id = "queued-restart"
    const gate = Promise.withResolvers<void>()
    const provider = modalProvider({
      find: async () => "sandbox-queued-restart",
      recover: async () => {
        await gate.promise
        return { code: 0, outputs: [] }
      },
    })
    const authority = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        return ExecutionAuthority.require({
          projectID: Instance.project.id,
          sessionID: session.id,
          capability: "remote_job",
        })
      },
    })
    const job = ComputeJobs.Job.parse({
      id,
      name: "queued restart",
      command: "true",
      cwd: tmp.path,
      target: { kind: "modal" },
      target_label: "Modal",
      scheduler: "none",
      status: "queued",
      created_at: new Date(Date.now() - 10_000).toISOString(),
      authority,
      lifecycle: { execution: "queued", delivery: "none", resource: "none", recoverable: false },
      modal: {
        app: modal.app,
        image: modal.image,
        packages: [],
        gpu: "none",
        network: modal.network,
        timeout_minutes: modal.timeoutMinutes,
        uploads: [],
        upload_bytes: 0,
        approval: "a".repeat(64),
        sdk: ModalAdapter.VERSION,
        volume: provider.volume(tmp.path, id),
      },
    })
    await fs.mkdir(root, { recursive: true })
    await Bun.write(path.join(root, "jobs.json"), JSON.stringify([job]))

    const first = await ComputeJobs.list({ root, workspace: tmp.path, credentials, provider })

    expect(first[0]?.status).toBe("running")
    expect(first[0]?.remote_id).toBe("sandbox-queued-restart")
    gate.resolve()
    expect((await ComputeJobs.wait(id, { root, workspace: tmp.path, timeout: 5_000 })).status).toBe("succeeded")
  })

  test("does not block job listing on a slow Modal lookup after restart", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const id = "slow-restart"
    const gate = Promise.withResolvers<void>()
    const provider = modalProvider({
      find: async () => {
        await gate.promise
        return "sandbox-slow-restart"
      },
    })
    const authority = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        return ExecutionAuthority.require({
          projectID: Instance.project.id,
          sessionID: session.id,
          capability: "remote_job",
        })
      },
    })
    const job = ComputeJobs.Job.parse({
      id,
      name: "slow restart",
      command: "true",
      cwd: tmp.path,
      target: { kind: "modal" },
      target_label: "Modal",
      scheduler: "none",
      status: "queued",
      created_at: new Date(Date.now() - 10_000).toISOString(),
      authority,
      lifecycle: { execution: "queued", delivery: "none", resource: "none", recoverable: false },
      modal: {
        app: modal.app,
        image: modal.image,
        packages: [],
        gpu: "none",
        network: modal.network,
        timeout_minutes: modal.timeoutMinutes,
        uploads: [],
        upload_bytes: 0,
        approval: "a".repeat(64),
        sdk: ModalAdapter.VERSION,
        volume: provider.volume(tmp.path, id),
      },
    })
    await fs.mkdir(root, { recursive: true })
    await Bun.write(path.join(root, "jobs.json"), JSON.stringify([job]))

    const listed = await Promise.race([
      ComputeJobs.list({ root, workspace: tmp.path, credentials, provider }),
      Bun.sleep(1_000).then(() => Promise.reject(new Error("job listing blocked on Modal lookup"))),
    ])

    expect(listed[0]?.status).toBe("queued")
    gate.resolve()
    expect((await ComputeJobs.wait(id, { root, workspace: tmp.path, timeout: 5_000 })).status).toBe("succeeded")
  })

  test("fails a running job after the third plain recovery error", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const id = "exhausted-recovery"
    const calls = { recover: 0, close: 0, release: 0 }
    const provider = modalProvider({
      recover: async () => {
        calls.recover++
        throw new Error("sandbox and volume unavailable")
      },
      close: async () => {
        calls.close++
      },
      release: async () => {
        calls.release++
      },
    })
    const authority = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        return ExecutionAuthority.require({
          projectID: Instance.project.id,
          sessionID: session.id,
          capability: "remote_job",
        })
      },
    })
    const job = ComputeJobs.Job.parse({
      id,
      name: "exhausted recovery",
      command: "true",
      cwd: tmp.path,
      target: { kind: "modal" },
      target_label: "Modal",
      scheduler: "none",
      status: "running",
      created_at: new Date(Date.now() - 60_000).toISOString(),
      started_at: new Date(Date.now() - 59_000).toISOString(),
      remote_id: "sandbox-exhausted-recovery",
      authority,
      lifecycle: { execution: "running", delivery: "none", resource: "active", recoverable: false },
      recovery_attempts: 2,
      recovery_retry_at: "2020-01-01T00:00:31.000Z",
      modal: {
        app: modal.app,
        image: modal.image,
        packages: [],
        gpu: "none",
        network: modal.network,
        timeout_minutes: modal.timeoutMinutes,
        uploads: [],
        upload_bytes: 0,
        approval: "a".repeat(64),
        sdk: ModalAdapter.VERSION,
        volume: provider.volume(tmp.path, id),
      },
    })
    await fs.mkdir(path.join(root, "jobs"), { recursive: true })
    await Promise.all([
      Bun.write(path.join(root, "jobs.json"), JSON.stringify([job])),
      Bun.write(
        path.join(root, "jobs", `${id}.events.log`),
        [
          "[2020-01-01T00:00:00.000Z] Recovery was unavailable",
          "[2020-01-01T00:00:16.000Z] Recovery remained unavailable",
          "",
        ].join("\n"),
      ),
    ])

    await ComputeJobs.list({ root, workspace: tmp.path, credentials, provider })
    const failed = await (async function poll(attempts = 100): Promise<ComputeJobs.Job> {
      const current = await ComputeJobs.get(id, { root, workspace: tmp.path })
      if (current?.status === "failed") return current
      if (!attempts) throw new Error("Timed out waiting for exhausted Modal recovery")
      await Bun.sleep(20)
      return poll(attempts - 1)
    })()

    expect(failed.status).toBe("failed")
    expect(failed.error).toContain("sandbox and volume unavailable")
    expect(failed.lifecycle).toMatchObject({ delivery: "failed", resource: "unknown", recoverable: true })
    await Bun.sleep(20)
    await ComputeJobs.list({ root, workspace: tmp.path, credentials, provider })
    await Bun.sleep(20)
    expect(calls).toEqual({ recover: 1, close: 1, release: 0 })
  })

  test("turns a rejected terminal recovery into one recoverable delivery failure", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const id = "terminal-recovery-failure"
    const calls = { recover: 0 }
    const provider = modalProvider({
      recover: async () => {
        calls.recover++
        throw new Error("control plane unavailable")
      },
    })
    const authority = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        return ExecutionAuthority.require({
          projectID: Instance.project.id,
          sessionID: session.id,
          capability: "remote_job",
        })
      },
    })
    const job = ComputeJobs.Job.parse({
      id,
      name: "failed restart delivery",
      command: "true",
      cwd: tmp.path,
      target: { kind: "modal" },
      target_label: "Modal",
      scheduler: "none",
      status: "succeeded",
      created_at: new Date(Date.now() - 10_000).toISOString(),
      completed_at: new Date().toISOString(),
      exit_code: 0,
      artifact_patterns: ["result.txt"],
      authority,
      lifecycle: { execution: "succeeded", delivery: "pending", resource: "active", recoverable: false },
      remote_id: "sandbox-terminal-recovery-failure",
      modal: {
        app: modal.app,
        image: modal.image,
        packages: [],
        gpu: "none",
        network: modal.network,
        timeout_minutes: modal.timeoutMinutes,
        uploads: [],
        upload_bytes: 0,
        approval: "a".repeat(64),
        sdk: ModalAdapter.VERSION,
        volume: provider.volume(tmp.path, id),
      },
    })
    await fs.mkdir(root, { recursive: true })
    await Bun.write(path.join(root, "jobs.json"), JSON.stringify([job]))

    await ComputeJobs.list({ root, workspace: tmp.path, credentials, provider })
    const failed = await (async function poll(attempts = 100): Promise<ComputeJobs.Job> {
      const current = await ComputeJobs.get(id, { root, workspace: tmp.path })
      if (current?.lifecycle?.delivery === "failed") return current
      if (!attempts) throw new Error("Timed out waiting for failed recovery")
      await Bun.sleep(20)
      return poll(attempts - 1)
    })()
    await ComputeJobs.list({ root, workspace: tmp.path, credentials, provider })
    await Bun.sleep(20)

    expect(failed.status).toBe("succeeded")
    expect(failed.lifecycle).toMatchObject({ delivery: "failed", resource: "unknown", recoverable: true })
    expect(calls.recover).toBe(1)
  })

  test("successful cleanup preserves an existing execution error", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const id = "failed-cleanup"
    const provider = modalProvider()
    const job = ComputeJobs.Job.parse({
      id,
      name: "failed job",
      command: "exit 1",
      cwd: tmp.path,
      target: { kind: "modal" },
      target_label: "Modal",
      scheduler: "none",
      status: "failed",
      created_at: new Date(Date.now() - 10_000).toISOString(),
      completed_at: new Date().toISOString(),
      exit_code: 1,
      error: "training failed",
      lifecycle: { execution: "failed", delivery: "none", resource: "unknown", recoverable: false },
      modal: {
        app: modal.app,
        image: modal.image,
        packages: [],
        gpu: "none",
        network: modal.network,
        timeout_minutes: modal.timeoutMinutes,
        uploads: [],
        upload_bytes: 0,
        approval: "a".repeat(64),
        sdk: ModalAdapter.VERSION,
        volume: provider.volume(tmp.path, id),
      },
    })
    await fs.mkdir(root, { recursive: true })
    await Bun.write(path.join(root, "jobs.json"), JSON.stringify([job]))

    const cleaned = await ComputeJobs.cancel(id, { root, workspace: tmp.path, credentials, provider })

    expect(cleaned.lifecycle?.resource).toBe("closed")
    expect(cleaned.cleanup_error).toBeUndefined()
    expect(cleaned.error).toBe("training failed")
  })
})

describe("ComputeJobs project boundaries", () => {
  test("start rejects a project scope that differs from the approved session workspace", async () => {
    await using tmp = await tmpdir()
    const first = path.join(tmp.path, "first")
    const second = path.join(tmp.path, "second")
    const root = path.join(tmp.path, "state")
    await Promise.all([fs.mkdir(first), fs.mkdir(second)])
    const request = {
      name: "wrong project",
      command: "true",
      target: { kind: "modal" as const },
      gpu: "none",
    }
    const prepared = await Instance.provide({
      directory: first,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const plan = await ComputeJobs.plan({ ...request, sessionID: session.id }, { root, workspace: first, modal })
        return { session, plan }
      },
    })

    await Instance.provide({
      directory: first,
      fn: () =>
        expect(
          ComputeJobs.start(
            { ...request, sessionID: prepared.session.id, approval: prepared.plan.digest },
            { root, workspace: second, modal, credentials, provider: modalProvider() },
          ),
        ).rejects.toThrow("Compute project does not match the session workspace"),
    })
  })

  test("isolates state and every job operation by canonical workspace", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const first = path.join(tmp.path, "first")
    const second = path.join(tmp.path, "second")
    await Promise.all([fs.mkdir(first), fs.mkdir(second)])
    const job = await start(
      {
        name: "isolated",
        command: "printf project-one",
        target: { kind: "local" },
      },
      { data, workspace: first },
    )
    await ComputeJobs.wait(job.id, { data, workspace: first, timeout: 5_000 })

    expect(await ComputeJobs.list({ data, workspace: second })).toEqual([])
    expect(await ComputeJobs.get(job.id, { data, workspace: second })).toBeUndefined()
    await expect(ComputeJobs.log(job.id, { data, workspace: second })).rejects.toThrow("was not found")
    await expect(ComputeJobs.events(job.id, { data, workspace: second })).rejects.toThrow("was not found")
    await expect(ComputeJobs.cancel(job.id, { data, workspace: second })).rejects.toThrow("was not found")
    expect(await ComputeJobs.clear({ data, workspace: second })).toBe(0)

    expect(await ComputeJobs.log(job.id, { data, workspace: first })).toContain("project-one")
    expect(await ComputeJobs.events(job.id, { data, workspace: first })).toBe("")
    expect(await ComputeJobs.clear({ data, workspace: first })).toBe(1)
  })

  test("quarantines legacy global records instead of guessing a project owner", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const workspace = path.join(tmp.path, "project")
    const legacy = path.join(data, "compute")
    await fs.mkdir(workspace)
    const job = await start(
      {
        name: "legacy",
        command: "printf legacy",
        target: { kind: "local" },
      },
      { root: legacy, workspace },
    )
    await ComputeJobs.wait(job.id, { root: legacy, workspace, timeout: 5_000 })

    expect(await ComputeJobs.list({ data, workspace })).toEqual([])
    expect(await Bun.file(path.join(legacy, "jobs.json")).exists()).toBe(true)
  })

  test("rejects cwd and output paths that escape through traversal or symlinks", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const workspace = path.join(tmp.path, "project")
    const outside = path.join(tmp.path, "outside")
    await Promise.all([fs.mkdir(workspace), fs.mkdir(outside)])
    await Bun.write(path.join(outside, "checkpoint.bin"), "secret")
    await fs.symlink(outside, path.join(workspace, "linked"))
    await fs.symlink(path.join(outside, "checkpoint.bin"), path.join(workspace, "checkpoint.bin"))

    const input = {
      name: "escape",
      command: "true",
      target: { kind: "local" as const },
    }
    await expect(start({ ...input, cwd: outside }, { data, workspace })).rejects.toThrow(
      "must be inside the session workspace",
    )
    await expect(start({ ...input, cwd: "linked" }, { data, workspace })).rejects.toThrow(
      "must be inside the session workspace",
    )
    await expect(start({ ...input, artifacts: ["linked/*.csv"] }, { data, workspace })).rejects.toThrow(
      "escapes the project working directory through a symlink",
    )
    await expect(start({ ...input, checkpoint: "checkpoint.bin" }, { data, workspace })).rejects.toThrow(
      "escapes the project working directory through a symlink",
    )
    expect(await ComputeJobs.list({ data, workspace })).toEqual([])
  })

  test("enforces the configured sandbox or fails closed when no backend is available", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const workspace = path.join(tmp.path, "project")
    const inside = path.join(workspace, "inside.txt")
    const outside = path.join(os.homedir(), `.openscience-compute-escape-${process.pid}-${crypto.randomUUID()}`)
    await fs.mkdir(workspace)
    await fs.rm(outside, { force: true })
    const run = () =>
      start(
        {
          name: "sandbox",
          command: `if printf escape > ${ComputeJobs.quote(outside)}; then exit 97; fi; printf safe > ${ComputeJobs.quote(inside)}`,
          target: { kind: "local" },
        },
        { data, workspace },
      )

    try {
      if (!Sandbox.available()) {
        await expect(run()).rejects.toBeInstanceOf(ExecutionAuthority.DeniedError)
        expect(await ComputeJobs.list({ data, workspace })).toEqual([])
        return
      }

      const job = await run()
      expect(job.sandbox).toMatchObject({ requested: true, enforced: true, backend: Sandbox.backend() })
      const finished = await ComputeJobs.wait(job.id, { data, workspace, timeout: 5_000 })
      expect(finished.status).toBe("succeeded")
      expect(await Bun.file(inside).text()).toBe("safe")
      expect(await Bun.file(outside).exists()).toBe(false)
    } finally {
      await fs.rm(outside, { force: true })
    }
  })
})
