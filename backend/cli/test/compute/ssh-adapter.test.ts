import { expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SshAdapter } from "../../src/compute/ssh/adapter"

test("accepts only Slurm COMPLETED 0:0 as a successful terminal result", async () => {
  expect(await SshAdapter.slurm("COMPLETED", "0:0")).toMatchObject({ state: "done", code: 0 })
  expect(await SshAdapter.slurm("CANCELLED by 1000", "0:15")).toMatchObject({ state: "cancelled" })
  expect(await SshAdapter.slurm("RUNNING", "0:0")).toMatchObject({ state: "running" })
  for (const [state, exit] of [
    ["FAILED", "1:0"],
    ["TIMEOUT", "0:9"],
    ["OUT_OF_MEMORY", "0:0"],
    ["NODE_FAIL", "0:0"],
    ["COMPLETED", "0:9"],
    ["COMPLETED", "2:0"],
  ] as const) {
    const result = await SshAdapter.slurm(state, exit)
    expect(result.state).toBe("done")
    expect(result.code).toBeGreaterThan(0)
  }
})

test("stops a control subprocess before buffering an oversized response", async () => {
  if (process.platform === "win32") return
  await expect(SshAdapter.slurm("X".repeat(96 * 1024), "1:0")).rejects.toThrow(
    "SSH command stdout exceeded 65536 bytes",
  )
})

test("bounds scheduler command output and reaps its owned process group", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-scheduler-bound-"))
  const remote = path.join(root, "remote")
  const bin = path.join(root, "bin")
  const pidfile = path.join(root, "scheduler.pid")
  const token = "scheduler-owner"
  const spec: SshAdapter.Spec = {
    id: "bounded-scheduler",
    owner: token,
    root: remote,
    cwd: ".",
    command: "true",
    scheduler: "slurm",
    outputs: [],
    uploads: [],
  }
  try {
    await Promise.all([fs.mkdir(remote), fs.mkdir(bin)])
    const packed = await SshAdapter.archive(spec, root)
    const extracted = Bun.spawn(["tar", "-xf", packed, "-C", remote], {
      stdout: "ignore",
      stderr: "pipe",
    })
    const [extractCode, extractError] = await Promise.all([extracted.exited, new Response(extracted.stderr).text()])
    if (extractCode !== 0) throw new Error(extractError)
    await Promise.all([
      fs.writeFile(path.join(remote, "owner"), `${crypto.createHash("sha256").update(token).digest("hex")}\n`),
      fs.writeFile(
        path.join(bin, "sbatch"),
        `#!/bin/sh
printf '%s\n' "$$" > ${JSON.stringify(pidfile)}
python3 -c 'import os,time
time.sleep(0.1)
os.set_blocking(1,True)
data=b"x"*(128*1024)
while data:
    data=data[os.write(1,data):]
time.sleep(60)' &
child=$!
printf '%s\n' "$child" >> ${JSON.stringify(pidfile)}
wait "$child"
`,
        { mode: 0o700 },
      ),
    ])
    const proc = Bun.spawn(["python3", path.join(remote, "control.py"), "submit", token], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(code).not.toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toContain("Remote command stdout exceeded 65536 bytes")
    expect(await Bun.file(path.join(remote, "intent.json")).exists()).toBe(false)
    const pids = (await Bun.file(pidfile).text()).trim().split("\n").map(Number)
    expect(pids).toHaveLength(2)
    for (const pid of pids) {
      const gone = await (async function wait(attempts = 100): Promise<boolean> {
        try {
          process.kill(pid, 0)
        } catch {
          return true
        }
        if (!attempts) return false
        await Bun.sleep(20)
        return wait(attempts - 1)
      })()
      expect(gone).toBe(true)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("terminates an SSH probe when its bounded operation times out or is aborted", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-probe-"))
  const bin = path.join(root, "bin")
  const keyscan = path.join(bin, "ssh-keyscan")
  const keygen = path.join(bin, "ssh-keygen")
  const previous = process.env.PATH
  await fs.mkdir(bin)
  await Promise.all([
    fs.writeFile(keyscan, "#!/bin/sh\nexec sleep 60\n", { mode: 0o700 }),
    fs.writeFile(keygen, "#!/bin/sh\nexit 1\n", { mode: 0o700 }),
  ])
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`
  const nativeExecutable = SshAdapter.executable
  const executable = spyOn(SshAdapter, "executable").mockImplementation((name) => {
    if (name === "ssh-keyscan") return Promise.resolve(keyscan)
    if (name === "ssh-keygen") return Promise.resolve(keygen)
    return nativeExecutable(name)
  })
  const host = { id: "slow", label: "Slow", host: "example.com", scheduler: "none" as const }
  try {
    const started = Date.now()
    await expect(SshAdapter.scan(host, { timeoutMs: 50 })).rejects.toThrow("SSH operation timed out")
    expect(Date.now() - started).toBeLessThan(2_000)

    const controller = new AbortController()
    const pending = SshAdapter.scan(host, { signal: controller.signal, timeoutMs: 5_000 })
    setTimeout(() => controller.abort(new Error("probe cancelled")), 25)
    await expect(pending).rejects.toThrow("probe cancelled")
  } finally {
    executable.mockRestore()
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("never selects workspace OpenSSH trust utilities from ambient PATH", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-path-shim-"))
  const previous = process.env.PATH
  try {
    for (const name of ["ssh", "ssh-keygen", "ssh-keyscan"] as const) {
      await fs.writeFile(path.join(root, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    }
    process.env.PATH = `${root}${path.delimiter}${previous ?? ""}`
    for (const name of ["ssh", "ssh-keygen", "ssh-keyscan"] as const) {
      expect(await SshAdapter.executable(name)).not.toBe(await fs.realpath(path.join(root, name)))
    }
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("rejects a non-regular approved upload without blocking on its contents", async () => {
  if (process.platform === "win32") return
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-upload-")))
  const source = path.join(root, "blocked-input")
  const fifo = Bun.spawn(["mkfifo", source], { stdout: "ignore", stderr: "pipe" })
  const [code, error] = await Promise.all([fifo.exited, new Response(fifo.stderr).text()])
  if (code !== 0) throw new Error(error)
  const spec: SshAdapter.Spec = {
    id: "blocked-upload",
    owner: "owner",
    root: "/remote/job",
    cwd: ".",
    command: "true",
    scheduler: "none",
    outputs: [],
    uploads: [
      {
        path: "blocked-input",
        canonical: source,
        size: 0,
        sha256: crypto.createHash("sha256").digest("hex"),
      },
    ],
  }
  try {
    const started = Date.now()
    await expect(SshAdapter.archive(spec, root, { timeoutMs: 500 })).rejects.toThrow(
      "SSH input changed during secure access",
    )
    expect(Date.now() - started).toBeLessThan(1_000)
    expect((await fs.readdir(root)).some((name) => name.includes(".ssh-stage-"))).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("packages and receives a bounded verified SSH staging archive", async () => {
  if (process.platform === "win32") return
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-receiver-")))
  const source = path.join(root, "input.txt")
  const content = Buffer.from("verified input\n")
  await fs.writeFile(source, content)
  const spec: SshAdapter.Spec = {
    id: "receiver",
    owner: "owner-token",
    root: path.join(root, "remote"),
    cwd: ".",
    command: "true",
    scheduler: "none",
    outputs: [],
    uploads: [
      {
        path: "input.txt",
        canonical: source,
        size: content.byteLength,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
      },
    ],
  }
  const packed = await SshAdapter.archive(spec, root)
  const input = await fs.open(packed, "r")
  try {
    const proc = Bun.spawn(["bash", "-lc", SshAdapter.receive(spec)], {
      stdin: input.fd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ staged: true, files: 1 })
    expect(await fs.readFile(path.join(spec.root, "work/input.txt"))).toEqual(content)
  } finally {
    await input.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function archive(root: string, relative: string, content: string) {
  const source = await fs.mkdtemp(path.join(root, "archive-source-"))
  const files = path.join(source, "files")
  const target = path.join(files, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
  const manifest = {
    files: [
      {
        path: relative,
        size: Buffer.byteLength(content),
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
      },
    ],
  }
  await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify(manifest))
  const targetArchive = path.join(root, `${crypto.randomUUID()}.tar`)
  const proc = Bun.spawn(["tar", "-cf", targetArchive, "-C", source, "manifest.json", "files"], {
    stdout: "ignore",
    stderr: "pipe",
  })
  const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(error)
  await fs.rm(source, { recursive: true, force: true })
  return targetArchive
}

async function adversarialArchive(root: string, manifest: unknown, relative: string, content: Buffer) {
  const source = await fs.mkdtemp(path.join(root, "archive-adversarial-"))
  const target = path.join(source, "files", relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
  await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify(manifest))
  const targetArchive = path.join(root, `${crypto.randomUUID()}.tar`)
  const proc = Bun.spawn(["tar", "-cf", targetArchive, "-C", source, "manifest.json", "files"], {
    stdout: "ignore",
    stderr: "pipe",
  })
  const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(error)
  await fs.rm(source, { recursive: true, force: true })
  return targetArchive
}

test("bounds manifest and file-member extraction from adversarial output archives", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-bounded-"))
  const workspace = path.join(root, "workspace")
  await fs.mkdir(workspace)
  try {
    const hugeManifest = await adversarialArchive(
      root,
      { files: [], padding: "x".repeat(512 * 1024) },
      "unused",
      Buffer.alloc(0),
    )
    await expect(SshAdapter.deliver(hugeManifest, workspace)).rejects.toThrow(
      "SSH command stdout exceeded 262144 bytes",
    )

    const content = Buffer.alloc(2 * 1024 * 1024, 7)
    const oversizedMember = await adversarialArchive(
      root,
      {
        files: [
          {
            path: "results/value.bin",
            size: 1,
            sha256: crypto.createHash("sha256").update(content).digest("hex"),
          },
        ],
      },
      "results/value.bin",
      content,
    )
    await expect(SshAdapter.deliver(oversizedMember, workspace)).rejects.toThrow("SSH command stdout exceeded 1 bytes")
    expect(await Bun.file(path.join(workspace, "results/value.bin")).exists()).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("cancels a blocked tar reader and leaves no delivery staging directory", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-cancel-"))
  const archivePath = path.join(root, "blocked.tar")
  const workspace = path.join(root, "workspace")
  await fs.mkdir(workspace)
  const fifo = Bun.spawn(["mkfifo", archivePath], { stdout: "ignore", stderr: "pipe" })
  const [code, error] = await Promise.all([fifo.exited, new Response(fifo.stderr).text()])
  if (code !== 0) throw new Error(error)
  const controller = new AbortController()
  const pending = SshAdapter.deliver(archivePath, workspace, { signal: controller.signal, timeoutMs: 5_000 })
  setTimeout(() => controller.abort(new Error("delivery cancelled")), 25)
  try {
    await expect(pending).rejects.toThrow("delivery cancelled")
    const names = await fs.readdir(root)
    expect(names.some((name) => name.startsWith("ssh-delivery-"))).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("installs SSH outputs beneath an inode-pinned workspace while an ancestor name is swapped", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-delivery-"))
  const archivePath = await archive(root, "results/value.bin", Buffer.alloc(2 * 1024 * 1024, 7).toString("binary"))
  for (const attempt of Array.from({ length: 25 }, (_, index) => index)) {
    const workspace = path.join(root, `workspace-${attempt}`)
    const outside = path.join(root, `outside-${attempt}`)
    const alias = path.join(workspace, "results")
    const parked = path.join(workspace, "parked")
    await Promise.all([fs.mkdir(alias, { recursive: true }), fs.mkdir(outside)])
    const stop = new AbortController()
    let cycles = 0
    const swapped = (async () => {
      while (!stop.signal.aborted) {
        await fs.rename(alias, parked).catch(() => undefined)
        await fs.symlink(outside, alias).catch(() => undefined)
        await fs.rm(alias, { force: true }).catch(() => undefined)
        await fs.rename(parked, alias).catch(() => undefined)
        cycles++
      }
    })()
    const delivered = await SshAdapter.deliver(archivePath, workspace).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
    )
    stop.abort()
    await swapped
    expect(cycles).toBeGreaterThan(0)
    expect(await Bun.file(path.join(outside, "value.bin")).exists()).toBe(false)
    const accepted = [path.join(alias, "value.bin"), path.join(parked, "value.bin")]
    const published = (await Promise.all(accepted.map((item) => Bun.file(item).exists()))).filter(Boolean)
    if (delivered.ok) {
      expect(delivered.value.map((item) => item.path)).toEqual(["results/value.bin"])
      expect(published).toHaveLength(1)
    } else {
      expect(delivered.error).toContain("SSH output destination changed during delivery")
      expect(published).toHaveLength(0)
    }
    for (const folder of [alias, parked]) {
      const names = await fs.readdir(folder).catch(() => [])
      expect(names.some((name) => name.endsWith(".openscience.tmp"))).toBe(false)
    }
  }
  await fs.rm(root, { recursive: true, force: true })
}, 30_000)

test("SSH output delivery is idempotent but never replaces different workspace bytes", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-existing-"))
  const workspace = path.join(root, "workspace")
  const target = path.join(workspace, "results/value.txt")
  const archivePath = await archive(root, "results/value.txt", "remote-result\n")
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, "local-work\n")
  await expect(SshAdapter.deliver(archivePath, workspace)).rejects.toThrow(
    "Refusing to replace an existing workspace file",
  )
  expect(await fs.readFile(target, "utf8")).toBe("local-work\n")
  await fs.writeFile(target, "remote-result\n")
  expect((await SshAdapter.deliver(archivePath, workspace)).map((item) => item.path)).toEqual(["results/value.txt"])
  expect(await fs.readFile(target, "utf8")).toBe("remote-result\n")
  await fs.rm(root, { recursive: true, force: true })
})
