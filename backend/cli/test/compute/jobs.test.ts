import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ComputeJobs, ComputeJobsCorruptError } from "../../src/compute/jobs"
import { SshAdapter } from "../../src/compute/ssh/adapter"
import { ModalAdapter } from "../../src/compute/modal/adapter"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { OpenScience } from "../../src/openscience"
import { Sandbox } from "../../src/sandbox/sandbox"
import { ExecutionAuthority } from "../../src/project/execution"
import { ArtifactStore } from "../../src/artifact/store"
import { CredentialProcessLedger } from "../../src/credentials/process-ledger"
import { CapabilityRegistry } from "../../src/science/capability/registry"
import { sandboxedExecution, tmpdir, trustProject } from "../fixture/fixture"

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

async function start(
  input: ComputeJobs.Input & {
    capability?: ComputeJobs.CapabilityBinding
    capability_execution?: ComputeJobs.CapabilityExecution
  },
  options: StartOptions,
) {
  if (!options.workspace) throw new Error("Compute test start requires an explicit workspace")
  const projectDirectory = options.workspace
  return Instance.provide({
    directory: projectDirectory,
    fn: async () => {
      await trustProject()
      const session = await Session.create({})
      const workspace = await SessionFilesystem.workspace(session.id)
      const grants = await SessionFilesystem.list(session.id)
      for (const grant of grants) {
        if (grant.source === "workspace" || grant.scope !== "session") continue
        await SessionFilesystem.revoke(session.id, grant.id)
      }
      const excluded = [options.root, options.data]
        .filter((value): value is string => !!value)
        .map((value) => path.resolve(value))
      await fs.cp(projectDirectory, workspace, {
        recursive: true,
        force: true,
        filter: (source) => {
          const resolved = path.resolve(source)
          return !excluded.some((value) => resolved === value || resolved.startsWith(`${value}${path.sep}`))
        },
      })
      const cwd = (() => {
        if (!input.cwd || !path.isAbsolute(input.cwd)) return input.cwd
        const relative = path.relative(projectDirectory, input.cwd)
        if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
          return path.join(workspace, relative)
        }
        return input.cwd
      })()
      return ComputeJobs.start({ ...input, cwd, sessionID: session.id }, { ...options, projectDirectory, workspace })
    },
  })
}

async function hostDescendantPID(job: ComputeJobs.Job, options: StartOptions, reportedPID: number): Promise<number> {
  if (process.platform !== "linux") return reportedPID
  const stored = await ComputeJobs.get(job.id, options)
  if (!stored?.pid || !stored.process_identity) throw new Error("Compute leader identity was not persisted")
  const resolved = await CredentialProcessLedger.resolveLinuxNamespacePID({
    leaderPID: stored.pid,
    leaderIdentity: stored.process_identity,
    namespacePID: reportedPID,
  })
  if (!resolved) throw new Error(`Could not resolve sandbox PID ${reportedPID} below compute leader ${stored.pid}`)
  return resolved
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
    concurrency: 4,
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

  test("uses an imported config hostname directly without loading user SSH config", () => {
    const imported = ComputeJobs.Host.parse({
      id: "lab",
      label: "lab",
      host: "login.cluster.example",
      user: "researcher",
      port: 2222,
      scheduler: "none",
      concurrency: 4,
    })
    const argv = SshAdapter.argv(imported, "/tmp/known-hosts", "true")

    expect(argv).toContain("/dev/null")
    expect(argv).toContain("researcher@login.cluster.example")
    expect(argv).not.toContain("lab")
  })

  test("binds SSH resources, modules, and container into the approved digest", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const pinned = ComputeJobs.Host.parse({
      ...host,
      scheduler: "none",
      notes: "Use the research partition; installations belong under /scratch/team/envs.",
      fingerprint: `SHA256:${"a".repeat(43)}`,
      host_key: `hpc.example.org ssh-ed25519 ${Buffer.from("test-key").toString("base64")}`,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const workspace = await SessionFilesystem.workspace(session.id)
        const request = {
          sessionID: session.id,
          name: "approved SSH contract",
          command: "python3 train.py",
          target: { kind: "ssh" as const, host_id: pinned.id },
          resources: { cpus: 4, gpus: 1, memory_gb: 16, time_minutes: 20, partition: "research" },
          modules: ["python/3.12"],
          container: "/images/research.sif",
        }
        const approved = await ComputeJobs.plan(request, { root, workspace, hosts: [pinned] })
        expect(approved.provider === "ssh" && approved.host_notes).toBe(pinned.notes)
        expect(approved.warning).toContain("never executed automatically")
        for (const mutation of [
          { resources: { ...request.resources, gpus: 2 } },
          { modules: ["python/3.13"] },
          { container: "/images/unreviewed.sif" },
        ]) {
          await expect(
            ComputeJobs.start(
              { ...request, ...mutation, approval: approved.digest },
              { root, workspace, hosts: [pinned] },
            ),
          ).rejects.toThrow("The SSH run must be approved using its current plan digest")
        }
        for (const changed of [
          { ...pinned, user: "other" },
          { ...pinned, port: 2200 },
          { ...pinned, workdir: "/different/base" },
          { ...pinned, notes: "Use a different partition." },
        ]) {
          await expect(
            ComputeJobs.start({ ...request, approval: approved.digest }, { root, workspace, hosts: [changed] }),
          ).rejects.toThrow("The SSH run must be approved using its current plan digest")
        }
        expect(await ComputeJobs.list({ root, workspace })).toEqual([])
      },
    })
  })

  test("returns the durable SSH handle before background staging finishes", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const bin = path.join(tmp.path, "bin")
    const counter = path.join(tmp.path, "ssh-invocations")
    const stageFinished = path.join(tmp.path, "ssh-stage-finished")
    const fingerprint = "SHA256:Qhi22lbcPTt1frRtqU56iDRQ6YjdwJU8EDmi0QCdnbc"
    const pinned = ComputeJobs.Host.parse({
      ...host,
      fingerprint,
      host_key: "hpc.example.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAUsmADCYwCBoe8869NDLxsh3Vvnsd3raFGoMF1h8fXB",
    })
    await fs.mkdir(bin)
    await Bun.write(
      path.join(bin, "ssh"),
      `#!/bin/sh
counter=${JSON.stringify(counter)}
count=0
if [ -f "$counter" ]; then count=$(cat "$counter"); fi
count=$((count + 1))
printf '%s' "$count" > "$counter"
if [ "$count" -eq 1 ]; then
  sleep 1
  printf 'yes' > ${JSON.stringify(stageFinished)}
  printf '%s\\n' '{"staged":true,"files":0}'
  exit 0
fi
if [ "$count" -eq 2 ]; then
  printf '%s\\n' '{"remote_id":"slurm:durable-123","reattached":false}'
  exit 0
fi
printf '%s\\n' '{"exists":true}'
`,
    )
    await fs.chmod(path.join(bin, "ssh"), 0o700)

    const previousPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await trustProject()
          const session = await Session.create({})
          const workspace = await SessionFilesystem.workspace(session.id)
          const request = {
            sessionID: session.id,
            name: "background SSH dispatch",
            purpose: "prove durable handoff",
            command: "python3 train.py",
            target: { kind: "ssh" as const, host_id: pinned.id },
            resources: { cpus: 2, time_minutes: 10 },
          }
          const options = { root, workspace, hosts: [pinned] }
          const plan = await ComputeJobs.plan(request, options)
          const startedAt = performance.now()
          const job = await ComputeJobs.start({ ...request, approval: plan.digest }, options)
          const elapsed = performance.now() - startedAt

          expect(elapsed).toBeLessThan(750)
          expect(job).toMatchObject({ status: "queued", remote_id: undefined })
          expect(await Bun.file(stageFinished).exists()).toBe(false)

          for (let attempt = 0; attempt < 500; attempt++) {
            const current = await ComputeJobs.get(job.id, options)
            const events = await ComputeJobs.events(job.id, options)
            if (current?.remote_id === "slurm:durable-123" && events.includes("Submitted slurm:durable-123")) {
              expect(current.status).toBe("running")
              return
            }
            if (current?.status === "failed") {
              throw new Error(`Background SSH submission failed: ${current.error ?? "unknown"}\n${events}`)
            }
            await Bun.sleep(20)
          }
          const current = await ComputeJobs.get(job.id, options)
          const events = await ComputeJobs.events(job.id, options)
          const count = await Bun.file(counter)
            .text()
            .catch(() => "missing")
          throw new Error(
            `Timed out waiting for the background SSH submission: ${JSON.stringify(current)}\ncount=${count}\n${events}`,
          )
        },
      })
    } finally {
      process.env.PATH = previousPath
    }
  }, 15_000)

  test("bounds SSH control output and reaps every owned transport process", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const bin = path.join(tmp.path, "bin")
    const pids = path.join(tmp.path, "ssh-pids")
    const pinned = ComputeJobs.Host.parse({
      ...host,
      fingerprint: "SHA256:Qhi22lbcPTt1frRtqU56iDRQ6YjdwJU8EDmi0QCdnbc",
      host_key: "hpc.example.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAUsmADCYwCBoe8869NDLxsh3Vvnsd3raFGoMF1h8fXB",
    })
    await fs.mkdir(bin)
    await fs.writeFile(
      path.join(bin, "ssh"),
      `#!/bin/sh
printf '%s\n' "$$" >> ${JSON.stringify(pids)}
exec python3 -c 'import os,time
os.set_blocking(1,True)
data=b"x"*(512*1024)
while data:
    data=data[os.write(1,data):]
time.sleep(60)'
`,
      { mode: 0o700 },
    )
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await trustProject()
          const session = await Session.create({})
          const workspace = await SessionFilesystem.workspace(session.id)
          const request = {
            sessionID: session.id,
            name: "bounded SSH control",
            purpose: "prove transport output cannot exhaust broker memory",
            command: "true",
            target: { kind: "ssh" as const, host_id: pinned.id },
          }
          const options = { root, workspace, hosts: [pinned] }
          const plan = await ComputeJobs.plan(request, options)
          const job = await ComputeJobs.start({ ...request, approval: plan.digest }, options)
          const failed = await (async function poll(attempts = 500): Promise<ComputeJobs.Job> {
            const current = await ComputeJobs.get(job.id, options)
            if (current?.status === "failed") return current
            if (!attempts) throw new Error(`Timed out waiting for bounded SSH failure: ${JSON.stringify(current)}`)
            await Bun.sleep(20)
            return poll(attempts - 1)
          })()
          expect(failed.error).toContain("SSH operation stdout exceeded 262144 bytes")
          await (async function cleanup(attempts = 1_500): Promise<void> {
            const current = await ComputeJobs.get(job.id, options)
            if (current?.status === "failed" && current.lifecycle?.resource !== "starting") return
            if (!attempts) throw new Error(`Timed out waiting for bounded SSH cleanup: ${JSON.stringify(current)}`)
            await Bun.sleep(20)
            return cleanup(attempts - 1)
          })()
        },
      })
      const owned = (await Bun.file(pids).text()).trim().split("\n").map(Number)
      expect(owned.length).toBeGreaterThanOrEqual(1)
      for (const pid of owned) {
        for (let attempt = 0; attempt < 100; attempt++) {
          const alive = (() => {
            try {
              process.kill(pid, 0)
              return true
            } catch {
              return false
            }
          })()
          if (!alive) break
          if (attempt === 99) throw new Error(`Bounded SSH transport process ${pid} remained alive`)
          await Bun.sleep(20)
        }
      }
    } finally {
      process.env.PATH = previousPath
    }
  }, 45_000)

  test("bounds SSH probe output and reports a transport error", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    const pidfile = path.join(tmp.path, "probe.pid")
    await fs.mkdir(bin)
    await Promise.all([
      fs.writeFile(
        path.join(bin, "ssh-keyscan"),
        "#!/bin/sh\nprintf '%s\\n' 'probe.example.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAUsmADCYwCBoe8869NDLxsh3Vvnsd3raFGoMF1h8fXB'\n",
        { mode: 0o700 },
      ),
      fs.writeFile(
        path.join(bin, "ssh-keygen"),
        "#!/bin/sh\nprintf '%s\\n' '256 SHA256:Qhi22lbcPTt1frRtqU56iDRQ6YjdwJU8EDmi0QCdnbc probe (ED25519)'\n",
        { mode: 0o700 },
      ),
      fs.writeFile(
        path.join(bin, "ssh"),
        `#!/bin/sh
printf '%s' "$$" > ${JSON.stringify(pidfile)}
exec python3 -c 'import os,time
os.set_blocking(1,True)
data=b"x"*(128*1024)
while data:
    data=data[os.write(1,data):]
time.sleep(60)'
`,
        { mode: 0o700 },
      ),
    ])
    const module = path.resolve(import.meta.dir, "../../src/compute/jobs.ts")
    const script = `
import { ComputeJobs } from ${JSON.stringify(module)}
const result = await ComputeJobs.probe({
  id: "bounded-probe",
  label: "Bounded probe",
  host: "probe.example.org",
  scheduler: "none",
  concurrency: 1,
})
console.log(JSON.stringify(result))
`
    try {
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(stderr)
      const result = ComputeJobs.Probe.parse(JSON.parse(stdout.trim().split("\n").at(-1)!))
      expect(result.ok).toBe(false)
      expect(result.error).toBe("SSH operation stdout exceeded 65536 bytes")
      const pid = Number(await Bun.file(pidfile).text())
      for (let attempt = 0; attempt < 100; attempt++) {
        const alive = (() => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        })()
        if (!alive) return
        await Bun.sleep(20)
      }
      throw new Error(`Bounded SSH probe process ${pid} remained alive`)
    } finally {
      await fs.rm(pidfile, { force: true })
    }
  }, 10_000)

  test("rejects an SSH launch that fails before its first durable transport handoff", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const bin = path.join(tmp.path, "bin")
    const invoked = path.join(tmp.path, "ssh-invoked")
    const pinned = ComputeJobs.Host.parse({
      ...host,
      scheduler: "none",
      fingerprint: "SHA256:Qhi22lbcPTt1frRtqU56iDRQ6YjdwJU8EDmi0QCdnbc",
      host_key: "hpc.example.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAUsmADCYwCBoe8869NDLxsh3Vvnsd3raFGoMF1h8fXB",
    })
    await fs.mkdir(bin)
    await Bun.write(
      path.join(bin, "ssh"),
      `#!/bin/sh
printf invoked > ${JSON.stringify(invoked)}
sleep 30
`,
    )
    await fs.chmod(path.join(bin, "ssh"), 0o700)

    const previousPath = process.env.PATH
    const previousFailure = process.env.OPENSCIENCE_SSH_TEST_REGISTRATION_FAILURE
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`
    process.env.OPENSCIENCE_SSH_TEST_REGISTRATION_FAILURE = "1"
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await trustProject()
          const session = await Session.create({})
          const workspace = await SessionFilesystem.workspace(session.id)
          const request = {
            sessionID: session.id,
            name: "failed SSH handoff",
            purpose: "prove pre-registration failures are synchronous",
            command: "python3 train.py",
            target: { kind: "ssh" as const, host_id: pinned.id },
          }
          const options = { root, workspace, hosts: [pinned] }
          const plan = await ComputeJobs.plan(request, options)

          await expect(ComputeJobs.start({ ...request, approval: plan.digest }, options)).rejects.toThrow(
            "Injected SSH control registration failure",
          )

          let failed: ComputeJobs.Job | undefined
          for (let attempt = 0; attempt < 250; attempt++) {
            failed = (await ComputeJobs.list(options)).at(0)
            if (failed?.status === "failed") break
            await Bun.sleep(20)
          }
          expect(failed).toMatchObject({
            status: "failed",
            error: "Injected SSH control registration failure",
          })
          // Every supported desktop launcher holds the actual SSH executable
          // behind its ownership gate until registration has succeeded.
          expect(await Bun.file(invoked).exists()).toBe(false)
          await Bun.sleep(50)
        },
      })
    } finally {
      process.env.PATH = previousPath
      if (previousFailure === undefined) delete process.env.OPENSCIENCE_SSH_TEST_REGISTRATION_FAILURE
      else process.env.OPENSCIENCE_SSH_TEST_REGISTRATION_FAILURE = previousFailure
    }
  }, 15_000)
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
  test("persists an internal capability binding in the job and provenance envelope", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const workspace = path.join(tmp.path, "project")
    const runtime = path.join(tmp.path, "runtime")
    await fs.mkdir(workspace, { recursive: true })
    await fs.mkdir(runtime, { recursive: true })
    const marker = path.join(runtime, "lock-marker")
    await fs.writeFile(marker, "verified")
    const capability = ComputeJobs.CapabilityBinding.parse({
      id: "scipy",
      version: "2.0.0",
      manifest_sha256: "a".repeat(64),
      profile: "smoke",
      runtime_digest: "b".repeat(64),
    })
    const capabilityExecution = ComputeJobs.CapabilityExecution.parse({
      network: "none",
      lock_digest: "c".repeat(64),
      pip_requirements: "scipy==1.18.1 --hash=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      runtime_binary: path.join(runtime, "bin", "python"),
      runtime_root: runtime,
    })
    const reattest = spyOn(CapabilityRegistry, "reattest").mockImplementation(async (binding, execution) => ({
      binding,
      execution,
    }))
    try {
      if (!Sandbox.available()) {
        await expect(
          start(
            {
              name: "capability provenance",
              command: `test "$(cat '${path.join(runtime, "lock-marker")}')" = verified`,
              target: { kind: "local" },
              capability,
              capability_execution: capabilityExecution,
            },
            { root, workspace },
          ),
        ).rejects.toThrow("requires an enforced host sandbox")
        return
      }
      const job = await start(
        {
          name: "capability provenance",
          command: [
            `test "$(cat ${JSON.stringify(marker)})" = verified`,
            `if (printf tampered > ${JSON.stringify(marker)}) 2>/dev/null; then exit 17; fi`,
            `test "$(cat ${JSON.stringify(marker)})" = verified`,
          ].join("; "),
          target: { kind: "local" },
          capability,
          capability_execution: capabilityExecution,
        },
        { root, workspace },
      )
      const finished = await ComputeJobs.wait(job.id, { root, workspace, timeout: 5_000 })
      const restarted = await ComputeJobs.get(job.id, { root, workspace })
      const log = await ComputeJobs.log(job.id, { root, workspace })

      expect({ status: finished.status, error: finished.error, log }).toEqual({
        status: "succeeded",
        error: undefined,
        log: "",
      })
      expect(await Bun.file(marker).text()).toBe("verified")
      expect(reattest).toHaveBeenCalledTimes(2)
      expect(finished.sandbox).toMatchObject({ requested: true, enforced: true, network: "deny" })
      expect(restarted?.capability).toEqual(capability)
      expect(restarted?.capability_execution).toEqual(capabilityExecution)
      expect(restarted?.provenance?.scientific_capability).toEqual({
        ...capability,
        execution_network: "none",
        lock_digest: capabilityExecution.lock_digest,
      })

      const nestedRuntime = path.join(workspace, ".data", "conda", "envs", "exact")
      const nestedMarker = path.join(nestedRuntime, "lock-marker")
      const spawned = path.join(workspace, "unsafe-spawned")
      await fs.mkdir(nestedRuntime, { recursive: true })
      await fs.writeFile(nestedMarker, "verified")
      const nestedExecution = ComputeJobs.CapabilityExecution.parse({
        ...capabilityExecution,
        runtime_binary: path.join(nestedRuntime, "bin", "python"),
        runtime_root: nestedRuntime,
      })
      await expect(
        start(
          {
            name: "nested capability runtime",
            command: `touch ${JSON.stringify(spawned)}`,
            target: { kind: "local" },
            capability,
            capability_execution: nestedExecution,
          },
          { root, workspace },
        ),
      ).rejects.toThrow("must be outside every writable sandbox root")
      expect(await Bun.file(nestedMarker).text()).toBe("verified")
      expect(await Bun.file(spawned).exists()).toBe(false)

      const policyRoot = path.join(tmp.path, "machine-writable")
      const policyRuntime = path.join(policyRoot, "conda", "envs", "exact")
      const policyMarker = path.join(policyRuntime, "lock-marker")
      const policySpawned = path.join(workspace, "policy-unsafe-spawned")
      await fs.mkdir(policyRuntime, { recursive: true })
      await fs.writeFile(policyMarker, "verified")
      const policyExecution = ComputeJobs.CapabilityExecution.parse({
        ...capabilityExecution,
        runtime_binary: path.join(policyRuntime, "bin", "python"),
        runtime_root: policyRuntime,
      })
      const originalRequire = ExecutionAuthority.require
      const authority = spyOn(ExecutionAuthority, "require").mockImplementation(async (input) => {
        const decision = await originalRequire(input)
        return ExecutionAuthority.Decision.parse({
          ...decision,
          sandbox: { ...decision.sandbox, allowWrite: [policyRoot] },
        })
      })
      try {
        await expect(
          start(
            {
              name: "policy-nested capability runtime",
              command: `touch ${JSON.stringify(policySpawned)}`,
              target: { kind: "local" },
              capability,
              capability_execution: policyExecution,
            },
            { root, workspace },
          ),
        ).rejects.toThrow("must be outside every writable sandbox root")
      } finally {
        authority.mockRestore()
      }
      expect(await Bun.file(policyMarker).text()).toBe("verified")
      expect(await Bun.file(policySpawned).exists()).toBe(false)
    } finally {
      reattest.mockRestore()
    }
  })

  test("rejects capability identity without its execution policy", () => {
    const base = {
      name: "invalid capability binding",
      command: "true",
      target: { kind: "local" as const },
      sessionID: "ses_fixture",
    }
    const capability = {
      id: "scipy",
      version: "2.0.0",
      manifest_sha256: "a".repeat(64),
      profile: "smoke" as const,
      runtime_digest: "b".repeat(64),
    }
    expect(() => ComputeJobs.Request.parse({ ...base, capability })).toThrow("supplied together")
  })

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
        cwd: { status: "available", value: job.cwd },
        code_state: { status: "unavailable", reason: "not_captured" },
      },
      outputs: { status: "queued", items: [] },
      timestamps: {
        created_at: { status: "available" },
        started_at: { status: "unavailable", reason: "not_captured" },
        completed_at: { status: "unavailable", reason: "not_captured" },
      },
      handoff: {
        atlas_run_id: { status: "unavailable", reason: "not_published" },
      },
    })
    expect(finished.status).toBe("succeeded")
    expect(finished.exit_code).toBe(0)
    expect(Date.parse(finished.last_activity_at ?? "")).toBeGreaterThanOrEqual(Date.parse(finished.created_at))
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
    const artifactID = finished.artifacts?.[0]?.artifact_id
    const versionID = finished.artifacts?.[0]?.version_id
    expect(artifactID).toMatch(/^art_/)
    expect(versionID).toMatch(/^ver_/)
    expect(finished.artifacts?.[0]?.version).toBe(1)
    expect(finished.checkpoint).toMatchObject({
      path: "checkpoints/latest.ckpt",
      size: 5,
      version: 1,
    })
    expect(finished.checkpoint?.artifact_id).toMatch(/^art_/)
    expect(finished.checkpoint?.version_id).toMatch(/^ver_/)
    const immutable = await ArtifactStore.read(job.authority!.projectID, artifactID!, versionID!)
    expect(await immutable?.content.text()).toBe("metric,value\nloss,0.1\n")
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
          artifact_id: { status: "available", value: finished.artifacts?.[0]?.artifact_id },
          version_id: { status: "available", value: finished.artifacts?.[0]?.version_id },
          version: { status: "available", value: 1 },
        }),
        expect.objectContaining({
          kind: "checkpoint",
          path: { status: "available", value: "checkpoints/latest.ckpt" },
          sha256: finished.checkpoint?.sha256,
          artifact_id: { status: "available", value: finished.checkpoint?.artifact_id },
          version_id: { status: "available", value: finished.checkpoint?.version_id },
          version: { status: "available", value: 1 },
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
    expect(await Bun.file(path.join(job.cwd!, "result.txt")).exists()).toBe(true)
  }, 15_000)

  test("bounds repository-controlled metadata while retaining dirty-state truth", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = path.join(tmp.path, "state")
    await fs.appendFile(
      path.join(tmp.path, ".git", "config"),
      `\n[remote "origin"]\n\turl = https://example.com/${"x".repeat(70 * 1024)}\n`,
    )
    await Promise.all(
      Array.from({ length: 400 }, (_, index) =>
        Bun.write(path.join(tmp.path, `untracked-${String(index).padStart(4, "0")}-${"x".repeat(180)}.txt`), ""),
      ),
    )

    const job = await start(
      {
        name: "bounded code state",
        command: "true",
        cwd: tmp.path,
        target: { kind: "local" },
      },
      { root, workspace: tmp.path },
    )

    expect(job.reproducibility?.git?.dirty).toBe(true)
    expect(job.reproducibility?.git?.repository).toBeUndefined()
    expect(JSON.stringify(job.reproducibility).length).toBeLessThan(100_000)
    expect((await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })).status).toBe("succeeded")
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

  test("cancels credential-bearing children when the host credential snapshot changes", async () => {
    if (!Sandbox.available()) return
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const job = await start(
      {
        name: "credential snapshot",
        command: "sleep 30",
        cwd: tmp.path,
        target: { kind: "local" },
      },
      { root, workspace: tmp.path },
    )
    for (const _ of Array.from({ length: 100 })) {
      const current = await ComputeJobs.get(job.id, { root, workspace: tmp.path })
      if (current?.status === "running") break
      await Bun.sleep(20)
    }

    expect(await ComputeJobs.cancelCredentialProcesses()).toBe(1)
    expect((await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })).status).toBe("cancelled")
  })

  const posixTest = process.platform === "win32" ? test.skip : test

  posixTest("reaps same-group background work before completing a local job", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const marker = "compute-descendant.pid"
    const release = "compute-release"
    let descendantPID = 0
    let descendantIdentity: string | undefined
    let job: ComputeJobs.Job | undefined
    try {
      job = await start(
        {
          name: "background descendant regression",
          command: [
            "sleep 600 &",
            'child="$!";',
            `printf %s "$child" > ${ComputeJobs.quote(marker)};`,
            `while [ ! -f ${ComputeJobs.quote(release)} ]; do sleep 0.02; done`,
          ].join(" "),
          target: { kind: "local" },
        },
        { root, workspace: tmp.path },
      )
      const ownedMarker = path.join(job.cwd!, marker)
      const ownedRelease = path.join(job.cwd!, release)
      for (let attempt = 0; attempt < 500 && !(await Bun.file(ownedMarker).exists()); attempt++) await Bun.sleep(10)
      expect(await Bun.file(ownedMarker).exists()).toBe(true)
      descendantPID = await hostDescendantPID(
        job,
        { root, workspace: tmp.path },
        Number((await Bun.file(ownedMarker).text()).trim()),
      )
      descendantIdentity = await CredentialProcessLedger.identity(descendantPID)
      expect(descendantIdentity).toMatch(/^[a-f0-9]{64}$/)

      await Bun.write(ownedRelease, "release")
      const finished = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })

      expect(finished.status).toBe("succeeded")
      expect(await CredentialProcessLedger.owns(descendantPID, descendantIdentity)).toBe(false)
    } finally {
      if (job) await ComputeJobs.cancel(job.id, { root, workspace: tmp.path }).catch(() => undefined)
      if (descendantPID && (await CredentialProcessLedger.owns(descendantPID, descendantIdentity))) {
        process.kill(descendantPID, "SIGKILL")
      }
    }
  })

  posixTest("credential revocation reaps compute work that starts a new session", async () => {
    const python = Bun.which("python3")
    if (!python) return
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const marker = "compute-setsid.pid"
    const script = [
      "import subprocess, sys, time",
      "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'], start_new_session=True)",
      "open(sys.argv[1], 'w').write(str(child.pid))",
      "time.sleep(600)",
    ].join("; ")
    let descendantPID = 0
    let descendantIdentity: string | undefined
    let job: ComputeJobs.Job | undefined
    try {
      job = await start(
        {
          name: "new session descendant regression",
          command: `${ComputeJobs.quote(python)} -c ${ComputeJobs.quote(script)} ${ComputeJobs.quote(marker)}`,
          target: { kind: "local" },
        },
        { root, workspace: tmp.path },
      )
      const ownedMarker = path.join(job.cwd!, marker)
      for (let attempt = 0; attempt < 500 && !(await Bun.file(ownedMarker).exists()); attempt++) await Bun.sleep(10)
      expect(await Bun.file(ownedMarker).exists()).toBe(true)
      descendantPID = await hostDescendantPID(
        job,
        { root, workspace: tmp.path },
        Number((await Bun.file(ownedMarker).text()).trim()),
      )
      descendantIdentity = await CredentialProcessLedger.identity(descendantPID)
      expect(descendantIdentity).toMatch(/^[a-f0-9]{64}$/)

      expect((await ComputeJobs.cancel(job.id, { root, workspace: tmp.path })).status).toBe("cancelled")
      const finished = await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })
      expect(finished.status).toBe("cancelled")
      expect(await CredentialProcessLedger.owns(descendantPID, descendantIdentity)).toBe(false)
    } finally {
      if (job) await ComputeJobs.cancel(job.id, { root, workspace: tmp.path }).catch(() => undefined)
      if (descendantPID && (await CredentialProcessLedger.owns(descendantPID, descendantIdentity))) {
        process.kill(descendantPID, "SIGKILL")
      }
    }
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
  test("binds scientific wheel locks and no-network execution into the Modal approval", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const capability = ComputeJobs.CapabilityBinding.parse({
      id: "scipy",
      version: "2.0.0",
      manifest_sha256: "a".repeat(64),
      profile: "smoke",
      runtime_digest: "b".repeat(64),
    })
    const capability_execution = ComputeJobs.CapabilityExecution.parse({
      network: "none",
      lock_digest: "c".repeat(64),
      pip_requirements: `scipy==1.18.1 --hash=sha256:${"d".repeat(64)}`,
    })
    const plan = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        return ComputeJobs.plan(
          {
            sessionID: session.id,
            name: "locked scientific Modal smoke",
            command: "python -I smoke.py",
            target: { kind: "modal" },
            image: "python:3.12-slim@sha256:" + "e".repeat(64),
            packages: ["scipy==1.18.1"],
            gpu: "none",
            uploads: [],
            capability,
            capability_execution,
          },
          { root, workspace: tmp.path, modal: { ...modal, network: "unrestricted" } },
        )
      },
    })

    expect(plan).toMatchObject({
      provider: "modal",
      network: "none",
      package_lock: {
        digest: capability_execution.lock_digest,
        requirements: capability_execution.pip_requirements,
      },
      uploads: [],
      upload_bytes: 0,
    })
  })

  test("returns the approved dispatch before the remote workload finishes", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const provider = modalProvider({
      run: async (_context, spec, hooks) => {
        await hooks.created(`sandbox-${spec.id}`)
        entered.resolve()
        await gate.promise
        return { code: 0, outputs: [] }
      },
    })
    const request = {
      name: "asynchronous modal job",
      command: "sleep 3600",
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

    const job = await Promise.race([
      Instance.provide({
        directory: tmp.path,
        fn: () =>
          ComputeJobs.start(
            { ...request, sessionID: prepared.session.id, approval: prepared.plan.digest },
            { root, workspace: tmp.path, modal, credentials, provider },
          ),
      }),
      Bun.sleep(2_000).then(() => Promise.reject(new Error("approved dispatch waited for the remote workload"))),
    ])

    await entered.promise
    expect(job.status).toBe("queued")
    expect((await ComputeJobs.get(job.id, { root, workspace: tmp.path }))?.status).toBe("running")

    gate.resolve()
    expect((await ComputeJobs.wait(job.id, { root, workspace: tmp.path, timeout: 5_000 })).status).toBe("succeeded")
  }, 15_000)

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
    const releases = { count: 0 }
    const provider = modalProvider({
      run: async (_context, spec, hooks) => {
        await hooks.created(`sandbox-${spec.id}`)
        await gate.promise
        return { code: 0, outputs: [] }
      },
      close: async () => gate.resolve(),
      release: async () => {
        releases.count++
      },
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
    const startedRelease = Date.now()
    await expect(ComputeJobs.release(first.id, { root, workspace: tmp.path, credentials, provider })).rejects.toThrow(
      `Cancel compute job ${first.id} before releasing its resources`,
    )
    expect(Date.now() - startedRelease).toBeLessThan(1_000)
    expect(releases.count).toBe(0)

    await ComputeJobs.cancel(first.id, { root, workspace: tmp.path, credentials, provider })
  })

  test("cancellation stops Modal execution but retains its durable volume until explicit release", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const calls = { close: 0, release: 0 }
    const provider = modalProvider({
      run: async (_context, spec, hooks) => {
        await hooks.created(`sandbox-${spec.id}`)
        entered.resolve()
        await gate.promise
        return { code: 0, outputs: [] }
      },
      close: async () => {
        gate.resolve()
        calls.close++
        if (calls.close === 1) throw new Error("provider unavailable")
      },
      release: async () => {
        calls.release++
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
    await entered.promise

    const cancelled = await ComputeJobs.cancel(job.id, { root, workspace: tmp.path, credentials, provider })

    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.lifecycle?.resource).toBe("unknown")
    expect(cancelled.cleanup_error).toContain("may still be billing")
    expect(cancelled.error).toBeUndefined()
    expect(await ComputeJobs.events(job.id, { root, workspace: tmp.path })).toContain("may still be billing")
    expect(await ComputeJobs.clear({ root, workspace: tmp.path })).toBe(0)

    const released = await ComputeJobs.cancel(job.id, { root, workspace: tmp.path, credentials, provider })
    expect(released.lifecycle?.resource).toBe("unknown")
    expect(released.modal?.retained_volume).toBe(true)
    expect(released.cleanup_error).toBeUndefined()
    expect(released.error).toBeUndefined()
    expect(calls).toEqual({ close: 2, release: 0 })
    const discarded = await ComputeJobs.release(job.id, { root, workspace: tmp.path, credentials, provider })
    expect(discarded.lifecycle?.resource).toBe("closed")
    expect(discarded.modal?.retained_volume).toBe(false)
    expect(calls).toEqual({ close: 2, release: 1 })
    expect(await ComputeJobs.clear({ root, workspace: tmp.path })).toBe(1)
  })

  test("cancellation harvests declared partial Modal outputs without deleting the volume", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const calls = { close: 0, collect: 0, release: 0 }
    const provider = modalProvider({
      run: async (_context, spec, hooks) => {
        await hooks.created(`sandbox-${spec.id}`)
        entered.resolve()
        await gate.promise
        return { code: 130, outputs: [] }
      },
      close: async () => {
        calls.close++
        gate.resolve()
      },
      collect: async (_context, spec) => {
        calls.collect++
        const staging = path.join(tmp.path, "partial", "results.csv")
        await fs.mkdir(path.dirname(staging), { recursive: true })
        await Bun.write(staging, "candidate,score\nA,0.8\n")
        return {
          code: 130,
          outputs: [{ path: "results.csv", staging, size: 22 }],
        }
      },
      release: async () => {
        calls.release++
      },
    })
    const request = {
      name: "retain partial output",
      command: "python analysis.py",
      target: { kind: "modal" as const },
      gpu: "none",
      artifacts: ["results.csv"],
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
    await entered.promise

    const cancelled = await ComputeJobs.cancel(job.id, { root, workspace: tmp.path, credentials, provider })

    expect(cancelled).toMatchObject({
      status: "cancelled",
      lifecycle: { delivery: "complete", resource: "unknown", recoverable: false },
      modal: { retained_volume: true },
    })
    expect(cancelled.artifacts?.map((item) => item.path)).toEqual(["results.csv"])
    expect(await Bun.file(path.join(job.cwd!, "results.csv")).text()).toBe("candidate,score\nA,0.8\n")
    expect(calls).toEqual({ close: 1, collect: 1, release: 0 })
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

    const released = await ComputeJobs.release(job.id, { root, workspace: tmp.path, credentials, provider })
    expect(released.status).toBe("succeeded")
    expect(released.lifecycle?.resource).toBe("closed")
    expect(released.cleanup_error).toBeUndefined()
    expect(released.error).toBeUndefined()
  })

  test("release waits for the exact Modal job lease before checking active recovery", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const blocked = Promise.withResolvers<void>()
    const deactivating = Promise.withResolvers<void>()
    const calls = { release: 0 }
    await using _testing = ComputeJobs.testing({
      beforeModalDeactivate: async () => {
        deactivating.resolve()
        await blocked.promise
      },
    })
    const provider = modalProvider({
      run: async () => {
        throw new Error("synthetic Modal launch failure")
      },
      release: async () => {
        calls.release++
      },
    })
    const request = {
      name: "failed Modal handoff",
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
    await deactivating.promise
    expect((await ComputeJobs.get(job.id, { root, workspace: tmp.path }))?.status).toBe("failed")
    const releasing = ComputeJobs.release(job.id, { root, workspace: tmp.path, credentials, provider }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    try {
      const pending = await Promise.race([releasing.then(() => false), Bun.sleep(25).then(() => true)])
      expect(pending).toBe(true)
      expect(calls.release).toBe(0)
    } finally {
      blocked.resolve()
    }

    const result = await releasing
    expect(result.ok).toBe(true)
    if (!result.ok) throw result.error
    expect(result.value.status).toBe("failed")
    expect(result.value.lifecycle?.resource).toBe("closed")
    expect(calls.release).toBe(1)
  }, 15_000)

  test("retries delivery from the durable Modal resource without rerunning the command", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const calls = { run: 0, recover: 0, release: 0 }
    const executionNetworks: ModalAdapter.Context["network"][] = []
    const unrestrictedCredentials = { ...credentials, network: "unrestricted" as const }
    const capability = ComputeJobs.CapabilityBinding.parse({
      id: "scipy",
      version: "2.0.0",
      manifest_sha256: "a".repeat(64),
      profile: "smoke",
      runtime_digest: "b".repeat(64),
    })
    const capability_execution = ComputeJobs.CapabilityExecution.parse({
      network: "none",
      lock_digest: "c".repeat(64),
      pip_requirements: `scipy==1.18.1 --hash=sha256:${"d".repeat(64)}`,
    })
    const provider = modalProvider({
      run: async (context, spec, hooks) => {
        calls.run++
        executionNetworks.push(context.network)
        await hooks.created(`sandbox-${spec.id}`)
        entered.resolve()
        await finish.promise
        return { code: 0, outputs: [{ path: "../escape", staging: tmp.path, size: 0 }] }
      },
      recover: async (context, spec, id, hooks) => {
        calls.recover++
        executionNetworks.push(context.network)
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
      capability,
      capability_execution,
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
          { root, workspace: tmp.path, modal, credentials: unrestrictedCredentials, provider },
        ),
    })
    await entered.promise
    expect(calls).toEqual({ run: 1, recover: 0, release: 0 })

    await Bun.write(path.join(root, "jobs", `${job.id}.log`), "last visible output\n")
    const retry = ComputeJobs.retry(job.id, {
      root,
      workspace: tmp.path,
      credentials: unrestrictedCredentials,
      provider,
    })
    const beforeFinish = await Promise.race([
      retry.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      Bun.sleep(50).then(() => "waiting" as const),
    ])
    finish.resolve()
    expect(beforeFinish).toBe("waiting")
    await retry
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
    expect(await Bun.file(path.join(job.cwd!, "result.txt")).text()).toBe("recovered")
    expect(calls).toEqual({ run: 1, recover: 1, release: 1 })
    expect(executionNetworks).toEqual(["none", "none"])
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

  test("keeps a running job recoverable after repeated control-plane errors", async () => {
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
    const deferred = await (async function poll(attempts = 100): Promise<ComputeJobs.Job> {
      const current = await ComputeJobs.get(id, { root, workspace: tmp.path })
      if (current?.recovery_attempts === 3) return current
      if (!attempts) throw new Error("Timed out waiting for deferred Modal recovery")
      await Bun.sleep(20)
      return poll(attempts - 1)
    })()

    expect(deferred.status).toBe("running")
    expect(deferred.error).toBeUndefined()
    expect(deferred.lifecycle).toMatchObject({ execution: "running", resource: "active" })
    expect(Date.parse(deferred.recovery_retry_at ?? "")).toBeGreaterThan(Date.now())
    await Bun.sleep(20)
    await ComputeJobs.list({ root, workspace: tmp.path, credentials, provider })
    await Bun.sleep(20)
    expect(calls).toEqual({ recover: 1, close: 0, release: 0 })
    expect(await Bun.file(path.join(root, "jobs", `${id}.events.log`)).text()).toContain(
      "Modal recovery attempt 3 deferred",
    )
  })

  test("stops retrying a permanent recovery failure without releasing unknown launch admission", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    const id = "permanent-recovery-failure"
    const calls = { recover: 0, close: 0 }
    const provider = modalProvider({
      recover: async () => {
        calls.recover++
        throw Object.assign(new Error("Modal credentials are not authorized"), { code: 16 })
      },
      close: async () => {
        calls.close++
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
      name: "permanent recovery failure",
      command: "true",
      cwd: tmp.path,
      target: { kind: "modal" },
      target_label: "Modal",
      scheduler: "none",
      status: "running",
      created_at: new Date(Date.now() - 60_000).toISOString(),
      started_at: new Date(Date.now() - 59_000).toISOString(),
      remote_id: "sandbox-permanent-recovery-failure",
      authority,
      lifecycle: { execution: "running", delivery: "none", resource: "active", recoverable: false },
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
      if (!attempts) throw new Error("Timed out waiting for permanent Modal recovery failure")
      await Bun.sleep(20)
      return poll(attempts - 1)
    })()

    expect(failed.status).toBe("failed")
    expect(failed.lifecycle).toMatchObject({
      execution: "failed",
      delivery: "failed",
      resource: "unknown",
      recoverable: true,
      error_kind: "unauthorized",
    })
    expect(failed.modal?.retained_volume).toBe(true)
    expect(failed.recovery_retry_at).toBeUndefined()
    await ComputeJobs.list({ root, workspace: tmp.path, credentials, provider })
    await Bun.sleep(20)
    expect(calls).toEqual({ recover: 1, close: 0 })

    const request = {
      name: "replacement after permanent failure",
      command: "true",
      target: { kind: "modal" as const },
      gpu: "none",
    }
    const replacement = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const plan = await ComputeJobs.plan({ ...request, sessionID: session.id }, { root, workspace: tmp.path, modal })
        return { session, plan }
      },
    })
    await expect(
      Instance.provide({
        directory: tmp.path,
        fn: () =>
          ComputeJobs.start(
            { ...request, sessionID: replacement.session.id, approval: replacement.plan.digest },
            { root, workspace: tmp.path, modal, credentials, provider },
          ),
      }),
    ).rejects.toThrow("Modal concurrency limit reached")
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

    const cleaned = await ComputeJobs.release(id, { root, workspace: tmp.path, credentials, provider })

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
    await using _sandbox = await sandboxedExecution()
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const workspace = path.join(tmp.path, "project")
    const outside = path.join(os.homedir(), `.openscience-compute-escape-${process.pid}-${crypto.randomUUID()}`)
    await fs.mkdir(workspace)
    await fs.rm(outside, { force: true })
    const run = () =>
      start(
        {
          name: "sandbox",
          command: `if printf escape > ${ComputeJobs.quote(outside)}; then exit 97; fi; printf safe > inside.txt`,
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
      expect(await Bun.file(path.join(job.cwd!, "inside.txt")).text()).toBe("safe")
      expect(await Bun.file(outside).exists()).toBe(false)
    } finally {
      await fs.rm(outside, { force: true })
    }
  })
})
