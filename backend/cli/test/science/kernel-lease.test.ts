import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AuthorityProcessLedger } from "../../src/project/authority-process"
import { KernelProcessIdentity } from "../../src/science/kernel/process"

const dataRootFixture = path.resolve(import.meta.dir, "../fixture/kernel-data-root-lifecycle.ts")
const registrationRaceFixture = path.resolve(import.meta.dir, "../fixture/kernel-registration-race.ts")

function dataRootEnvironment(root: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config-xdg"),
    XDG_DATA_HOME: path.join(root, "data-xdg"),
    XDG_STATE_HOME: path.join(root, "state-xdg"),
  }
  delete env.OPENSCIENCE_DATA_DIR
  return env
}

async function invokeDataRoot(root: string, workspace: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, dataRootFixture, workspace, ...args], {
    env: dataRootEnvironment(root),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

async function waitDataRootJson<T>(file: string, attempt = 0): Promise<T> {
  const value = await Bun.file(file)
    .json()
    .catch(() => undefined)
  if (value) return value as T
  if (attempt >= 1_000) throw new Error(`Timed out waiting for ${file}`)
  await Bun.sleep(10)
  return waitDataRootJson<T>(file, attempt + 1)
}

async function exactProcessGone(target: { pid: number; identity: string }, attempt = 0): Promise<boolean> {
  if (!(await AuthorityProcessLedger.owns(target.pid, target.identity))) return true
  if (attempt >= 500) return false
  await Bun.sleep(10)
  return exactProcessGone(target, attempt + 1)
}

async function findText(root: string, needle: string): Promise<string | undefined> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await findText(target, needle)
      if (nested) return nested
      continue
    }
    if (!entry.isFile()) continue
    const text = await fs.readFile(target, "utf8").catch(() => undefined)
    if (text?.includes(needle)) return text
  }
}

// This launches two real servers and waits for native ownership registration,
// lease arbitration, and verified teardown; it is not a 5s unit operation.
test("two servers cannot start the same persistent kernel identity", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-kernel-lease-"))
  const workspace = path.join(root, "workspace")
  const runner = path.join(root, "kernel.ts")
  const registry = new URL("../../src/science/kernel/registry.ts", import.meta.url).href
  const processModule = new URL("../../src/science/kernel/process.ts", import.meta.url).href
  const launcher = new URL("../../src/process/windows-job-launcher.ts", import.meta.url).href
  const instance = new URL("../../src/project/instance.ts", import.meta.url).href
  const trust = new URL("../../src/project/trust.ts", import.meta.url).href
  const session = new URL("../../src/session/index.ts", import.meta.url).href
  const marker = path.join(root, "starts.log")
  await fs.mkdir(workspace)
  await Bun.write(
    runner,
    `
import fs from "node:fs/promises"
import { KernelRuntime } from ${JSON.stringify(registry)}
	import { KernelProcessIdentity } from ${JSON.stringify(processModule)}
	import { WindowsJobLauncher } from ${JSON.stringify(launcher)}
import { Instance } from ${JSON.stringify(instance)}
import { ProjectTrust } from ${JSON.stringify(trust)}
import { Session } from ${JSON.stringify(session)}
await Instance.provide({ directory: process.argv[2], fn: async () => {
  const status = await ProjectTrust.status(Instance.project)
  if (!status.canExecuteProjectCode) await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
  if (process.argv[3] === "setup") {
    console.log((await Session.create({})).id)
    return
  }
  const kernels = new Map()
  KernelRuntime.register({
    language: "lease-test",
	    async get(id, options) {
      const existing = kernels.get(id)
      if (existing) return existing
      await fs.appendFile(${JSON.stringify(marker)}, "start\\n")
	      const wrapped = WindowsJobLauncher.wrap({
          file: Bun.which("sleep") || "/bin/sleep",
          args: ["30"],
          linuxOwner: options?.processOwnership?.linuxOwner,
        })
	      const child = Bun.spawn([wrapped.file, ...wrapped.args], { detached: true, stdout: "ignore", stderr: "ignore" })
	      WindowsJobLauncher.bind(child, wrapped.release)
	      const ownership = options?.processOwnership ? { ...options.processOwnership, windowsRelease: wrapped.release } : undefined
	      const identity = await KernelProcessIdentity.register(child, ownership)
	      if (!identity) throw new Error("Kernel child exited before registration")
      const kernel = {
        id,
        language: "lease-test",
        ready: true,
        process: identity,
        async start() {},
        async execute() { return { ok: true, outputs: [], stdout: "", stderr: "" } },
        async shutdown() { await KernelProcessIdentity.terminate(identity) },
      }
      kernels.set(id, kernel)
      return kernel
    },
    async release(id) {
      await kernels.get(id)?.shutdown()
      kernels.delete(id)
    },
    async shutdownAll() {
      await Promise.all([...kernels.values()].map((kernel) => kernel.shutdown()))
      kernels.clear()
    },
  })
  const identity = {
    projectID: Instance.project.id,
    sessionID: process.argv[4],
    name: "shared",
    language: "lease-test",
  }
  await KernelRuntime.get(identity)
  await Bun.sleep(1_800)
  await KernelRuntime.release(identity)
} })
`,
  )
  const env = {
    ...process.env,
    OPENSCIENCE_DATA_DIR: path.join(root, "data"),
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config-xdg"),
    XDG_DATA_HOME: path.join(root, "data-xdg"),
    XDG_STATE_HOME: path.join(root, "state-xdg"),
  }

  try {
    const setup = Bun.spawn([process.execPath, runner, workspace, "setup"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [setupCode, sessionID, setupError] = await Promise.all([
      setup.exited,
      new Response(setup.stdout).text(),
      new Response(setup.stderr).text(),
    ])
    expect(setupCode, setupError).toBe(0)

    const first = Bun.spawn([process.execPath, runner, workspace, "run", sessionID.trim()], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    await Bun.sleep(100)
    const second = Bun.spawn([process.execPath, runner, workspace, "run", sessionID.trim()], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const results = await Promise.all(
      [first, second].map(async (proc) => ({
        code: await proc.exited,
        error: await new Response(proc.stderr).text(),
      })),
    )
    expect(results.filter((item) => item.code === 0)).toHaveLength(1)
    expect(results.find((item) => item.code !== 0)?.error).toContain("active in another OpenScience server")
    expect((await fs.readFile(marker, "utf8")).trim().split("\n")).toEqual(["start"])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("revocation reclaims identity-verified kernels orphaned by a killed server", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-kernel-revocation-"))
  const workspace = path.join(root, "workspace")
  const runner = path.join(root, "kernel.ts")
  const registry = new URL("../../src/science/kernel/registry.ts", import.meta.url).href
  const processModule = new URL("../../src/science/kernel/process.ts", import.meta.url).href
  const launcher = new URL("../../src/process/windows-job-launcher.ts", import.meta.url).href
  const instance = new URL("../../src/project/instance.ts", import.meta.url).href
  const trust = new URL("../../src/project/trust.ts", import.meta.url).href
  const session = new URL("../../src/session/index.ts", import.meta.url).href
  const markers = path.join(root, "owners")
  await fs.mkdir(workspace)
  await fs.mkdir(markers)
  await Bun.write(
    runner,
    `
import fs from "node:fs/promises"
import path from "node:path"
import { KernelRuntime } from ${JSON.stringify(registry)}
	import { KernelProcessIdentity } from ${JSON.stringify(processModule)}
	import { WindowsJobLauncher } from ${JSON.stringify(launcher)}
import { Instance } from ${JSON.stringify(instance)}
import { ProjectTrust } from ${JSON.stringify(trust)}
import { Session } from ${JSON.stringify(session)}
await Instance.provide({ directory: process.argv[2], fn: async () => {
  const mode = process.argv[3]
  if (mode === "setup") {
    console.log((await Session.create({})).id)
    return
  }
  const kernels = new Map()
  KernelRuntime.register({
    language: "revocation-test",
	    async get(id, options) {
      const existing = kernels.get(id)
      if (existing) return existing
	      const wrapped = WindowsJobLauncher.wrap({
          file: Bun.which("sleep") || "/bin/sleep",
          args: ["30"],
          linuxOwner: options?.processOwnership?.linuxOwner,
        })
	      const child = Bun.spawn([wrapped.file, ...wrapped.args], { detached: true, stdout: "ignore", stderr: "ignore" })
	      WindowsJobLauncher.bind(child, wrapped.release)
	      const ownership = options?.processOwnership ? { ...options.processOwnership, windowsRelease: wrapped.release } : undefined
	      const identity = await KernelProcessIdentity.register(child, ownership)
	      if (!identity) throw new Error("Kernel child exited before registration")
      const kernel = {
        id,
        language: "revocation-test",
        ready: true,
        process: identity,
        async start() {},
        async execute() { return { ok: true, outputs: [], stdout: "", stderr: "" } },
        async shutdown() { await KernelProcessIdentity.terminate(identity) },
      }
      kernels.set(id, kernel)
      return kernel
    },
    async release(id) {
      await kernels.get(id)?.shutdown()
      kernels.delete(id)
    },
    async shutdownAll() {
      await Promise.all([...kernels.values()].map((kernel) => kernel.shutdown()))
      kernels.clear()
    },
  })
  if (mode === "owner") {
    const status = await ProjectTrust.status(Instance.project)
    if (!status.canExecuteProjectCode) await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
    const kernel = await KernelRuntime.get({
      projectID: Instance.project.id,
      sessionID: process.argv[4],
      name: process.argv[5],
      language: "revocation-test",
    })
    await fs.writeFile(path.join(${JSON.stringify(markers)}, process.argv[5] + ".json"), JSON.stringify(kernel.process))
    await new Promise(() => {})
  }
  if (mode === "release-project") await KernelRuntime.releaseProject(Instance.project.id)
  if (mode === "remove-session") await KernelRuntime.removeSession(Instance.project.id, process.argv[4])
  if (mode === "dispose") {
    await KernelRuntime.restoreSession(Instance.project.id, process.argv[4])
    await Instance.dispose()
  }
} })
`,
  )
  const env = {
    ...process.env,
    OPENSCIENCE_DATA_DIR: path.join(root, "data"),
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config-xdg"),
    XDG_DATA_HOME: path.join(root, "data-xdg"),
    XDG_STATE_HOME: path.join(root, "state-xdg"),
  }
  const owners = new Set<ReturnType<typeof Bun.spawn>>()
  const identities: { pid: number; startedAt: number; token?: string }[] = []
  const read = async (name: string, attempt = 0): Promise<(typeof identities)[number]> => {
    const value = await Bun.file(path.join(markers, `${name}.json`))
      .json()
      .catch(() => undefined)
    if (value) return value as (typeof identities)[number]
    if (attempt >= 200) throw new Error(`Timed out waiting for ${name} to publish its kernel identity`)
    await Bun.sleep(25)
    return read(name, attempt + 1)
  }
  const gone = async (identity: (typeof identities)[number], attempt = 0): Promise<boolean> => {
    if (!KernelProcessIdentity.matchesRecorded(identity)) return true
    if (attempt >= 200) return false
    await Bun.sleep(10)
    return gone(identity, attempt + 1)
  }
  const invoke = async (mode: string, sessionID: string) => {
    const proc = Bun.spawn([process.execPath, runner, workspace, mode, sessionID], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    return { code, error }
  }

  try {
    const setup = Bun.spawn([process.execPath, runner, workspace, "setup"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [setupCode, sessionID, setupError] = await Promise.all([
      setup.exited,
      new Response(setup.stdout).text(),
      new Response(setup.stderr).text(),
    ])
    expect(setupCode, setupError).toBe(0)

    const actions = [
      ["release-project", "project-orphan"],
      ["remove-session", "session-orphan"],
      ["dispose", "instance-orphan"],
    ] as const
    for (const [action, name] of actions) {
      const owner = Bun.spawn([process.execPath, runner, workspace, "owner", sessionID.trim(), name], {
        env,
        stdout: "ignore",
        stderr: "pipe",
      })
      owners.add(owner)
      const identity = await read(name)
      identities.push(identity)
      expect(identity.token).toBeDefined()
      expect(KernelProcessIdentity.matchesRecorded(identity)).toBe(true)

      if (action === "release-project") {
        const live = await invoke(action, sessionID.trim())
        expect(live.code).not.toBe(0)
        expect(KernelProcessIdentity.matchesRecorded(identity)).toBe(true)
      }

      owner.kill("SIGKILL")
      await owner.exited
      owners.delete(owner)
      if (process.platform === "darwin") expect(await gone(identity)).toBe(true)
      else expect(KernelProcessIdentity.matchesRecorded(identity)).toBe(true)

      const revoked = await invoke(action, sessionID.trim())
      expect(revoked.code, revoked.error).toBe(0)
      expect(await gone(identity)).toBe(true)
    }
  } finally {
    for (const owner of owners) {
      owner.kill("SIGKILL")
      await owner.exited.catch(() => undefined)
    }
    await Promise.all(identities.map((identity) => KernelProcessIdentity.terminate(identity)))
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("the registered containment leader drains workers after the payload leader exits", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-kernel-leader-exit-"))
  const workspace = path.join(root, "workspace")
  const fixture = path.resolve(import.meta.dir, "../fixture/kernel-leader-exit.ts")
  const ready = path.join(root, "ready.json")
  const childFile = path.join(root, "child.pid")
  const releaseFile = path.join(root, "release")
  await fs.mkdir(workspace)
  const env = {
    ...process.env,
    OPENSCIENCE_DATA_DIR: path.join(root, "data"),
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config-xdg"),
    XDG_DATA_HOME: path.join(root, "data-xdg"),
    XDG_STATE_HOME: path.join(root, "state-xdg"),
  }
  let owner: ReturnType<typeof Bun.spawn> | undefined
  let child: { pid: number; identity: string } | undefined
  const waitJson = async <T>(file: string, attempt = 0): Promise<T> => {
    const value = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (value) return value as T
    if (attempt >= 500) throw new Error(`Timed out waiting for ${file}`)
    await Bun.sleep(10)
    return waitJson<T>(file, attempt + 1)
  }
  const gone = async (target: { pid: number; identity: string }, attempt = 0): Promise<boolean> => {
    if (!(await AuthorityProcessLedger.owns(target.pid, target.identity))) return true
    if (attempt >= 300) return false
    await Bun.sleep(10)
    return gone(target, attempt + 1)
  }
  const invoke = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, fixture, workspace, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, stdout, stderr }
  }

  try {
    const setup = await invoke("setup")
    expect(setup.code, setup.stderr).toBe(0)
    const sessionID = setup.stdout.trim()
    owner = Bun.spawn([process.execPath, fixture, workspace, "owner", sessionID, ready, childFile, releaseFile], {
      env,
      stdout: "ignore",
      stderr: "pipe",
    })
    const published = await waitJson<{
      process: { pid: number; startedAt: number; token?: string; ownershipID?: string }
      childPID: number
    }>(ready)
    expect(published.process.token).toHaveLength(64)
    expect(published.process.ownershipID).toStartWith("kernel-")
    const childIdentity = await AuthorityProcessLedger.identity(published.childPID)
    expect(childIdentity).toBeDefined()
    child = { pid: published.childPID, identity: childIdentity! }
    expect(await AuthorityProcessLedger.owns(child.pid, child.identity)).toBe(true)

    await Bun.write(releaseFile, "release")
    const leaderGone = async (attempt = 0): Promise<boolean> => {
      if (!KernelProcessIdentity.matchesRecorded(published.process)) return true
      if (attempt >= 300) return false
      await Bun.sleep(10)
      return leaderGone(attempt + 1)
    }
    expect(await leaderGone()).toBe(true)
    // The registered containment leader must not disappear until its payload
    // leader's surviving same-group worker has been drained.
    expect(await AuthorityProcessLedger.owns(child.pid, child.identity)).toBe(false)

    owner.kill("SIGKILL")
    await owner.exited
    owner = undefined
    const removed = await invoke("remove", sessionID)
    expect(removed.code, removed.stderr).toBe(0)
    expect(await gone(child)).toBe(true)
    expect(await Bun.file(path.join(root, "data", "authority-processes.json")).json()).toEqual([])
  } finally {
    owner?.kill("SIGKILL")
    await owner?.exited.catch(() => undefined)
    if (child && (await AuthorityProcessLedger.owns(child.pid, child.identity))) {
      process.kill(child.pid, "SIGKILL")
    }
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("server SIGKILL cannot let relocation pass a surviving kernel containment group", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-kernel-data-root-relocation-"))
  const workspace = path.join(root, "workspace")
  const ready = path.join(root, "owner.json")
  const moved = path.join(root, "moved.json")
  const target = path.join(root, "relocated")
  await fs.mkdir(workspace, { recursive: true })
  let owner: ReturnType<typeof Bun.spawn> | undefined
  let containment: { pid: number; identity: string } | undefined
  let worker: { pid: number; identity: string } | undefined
  try {
    const setup = await invokeDataRoot(root, workspace, "setup")
    expect(setup.code, setup.stderr).toBe(0)
    const sessionID = setup.stdout.trim()
    owner = Bun.spawn([process.execPath, dataRootFixture, workspace, "owner-ready", sessionID, ready], {
      env: dataRootEnvironment(root),
      stdout: "ignore",
      stderr: "pipe",
    })
    const published = await waitDataRootJson<{
      process: { pid: number; token: string; ownershipID: string }
      worker: { pid: number }
    }>(ready)
    containment = { pid: published.process.pid, identity: published.process.token }
    const workerIdentity = await AuthorityProcessLedger.identity(published.worker.pid)
    expect(workerIdentity).toBeDefined()
    worker = { pid: published.worker.pid, identity: workerIdentity! }
    expect(await AuthorityProcessLedger.owns(containment.pid, containment.identity)).toBe(true)
    expect(await AuthorityProcessLedger.owns(worker.pid, worker.identity)).toBe(true)

    const operationFiles = await fs.readdir(path.join(root, "config", "data-root-operations"))
    const childMarker = await Promise.all(
      operationFiles.map((name) => Bun.file(path.join(root, "config", "data-root-operations", name)).json()),
    ).then((records) =>
      records.find((record) => record.pid === containment!.pid && record.identity === containment!.identity),
    )
    expect(childMarker).toBeDefined()
    const oldRoot = await fs.realpath(path.join(root, "home", ".openscience"))
    const held = path.join(oldRoot, "kernel-held-open.log")
    const before = (await fs.stat(held)).size

    owner.kill("SIGKILL")
    await owner.exited
    owner = undefined
    const relocation = await invokeDataRoot(root, workspace, "relocate", "", target, moved)
    expect(relocation.code, relocation.stderr).toBe(0)
    const result = await waitDataRootJson<{ source: string; target: string }>(moved)
    expect(result.source).toBe(oldRoot)
    expect(await fs.realpath(result.target)).toBe(await fs.realpath(target))
    expect(await exactProcessGone(containment)).toBe(true)
    expect(await exactProcessGone(worker)).toBe(true)
    const settled = (await fs.stat(held)).size
    expect(settled).toBeGreaterThanOrEqual(before)
    await Bun.sleep(100)
    expect((await fs.stat(held)).size).toBe(settled)
  } finally {
    owner?.kill("SIGKILL")
    await owner?.exited.catch(() => undefined)
    if (containment && !(await exactProcessGone(containment))) process.kill(containment.pid, "SIGKILL")
    if (worker && !(await exactProcessGone(worker))) process.kill(worker.pid, "SIGKILL")
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("recovery reclaims durable kernel ownership when child pointer publication is interrupted", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-kernel-pointer-crash-"))
  const workspace = path.join(root, "workspace")
  const registered = path.join(root, "registered.json")
  await fs.mkdir(workspace, { recursive: true })
  let owner: ReturnType<typeof Bun.spawn> | undefined
  let containment: { pid: number; identity: string } | undefined
  try {
    const setup = await invokeDataRoot(root, workspace, "setup")
    expect(setup.code, setup.stderr).toBe(0)
    const sessionID = setup.stdout.trim()
    owner = Bun.spawn([process.execPath, dataRootFixture, workspace, "owner-crash-window", sessionID, registered], {
      env: dataRootEnvironment(root),
      stdout: "ignore",
      stderr: "pipe",
    })
    const processRecord = await waitDataRootJson<{ pid: number; token: string; ownershipID: string }>(registered)
    containment = { pid: processRecord.pid, identity: processRecord.token }
    const data = await fs.realpath(path.join(root, "home", ".openscience"))
    const persisted = await findText(path.join(data, "storage", "kernel_registry"), processRecord.ownershipID)
    expect(persisted).toContain(`"ownership_id": "${processRecord.ownershipID}"`)
    expect(persisted).toContain('"process": null')

    owner.kill("SIGKILL")
    await owner.exited
    owner = undefined
    const recovered = await invokeDataRoot(root, workspace, "recover", sessionID)
    expect(recovered.code, recovered.stderr).toBe(0)
    expect(await exactProcessGone(containment)).toBe(true)
    expect(await Bun.file(path.join(root, "home", ".openscience", "authority-processes.json")).json()).toEqual([])
    const cleared = await findText(path.join(data, "storage", "kernel_registry"), processRecord.ownershipID)
    expect(cleared).toBeUndefined()
  } finally {
    owner?.kill("SIGKILL")
    await owner?.exited.catch(() => undefined)
    if (containment && !(await exactProcessGone(containment))) process.kill(containment.pid, "SIGKILL")
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("a missed first revoke preserves the lexical startup ID through late registration", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-kernel-registration-race-"))
  const workspace = path.join(root, "workspace")
  const result = path.join(root, "result.json")
  await fs.mkdir(workspace, { recursive: true })
  try {
    const setup = Bun.spawn([process.execPath, registrationRaceFixture, workspace, "setup"], {
      env: dataRootEnvironment(root),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [setupCode, sessionID, setupError] = await Promise.all([
      setup.exited,
      new Response(setup.stdout).text(),
      new Response(setup.stderr).text(),
    ])
    expect(setupCode, setupError).toBe(0)

    const race = Bun.spawn([process.execPath, registrationRaceFixture, workspace, "race", sessionID.trim(), result], {
      env: dataRootEnvironment(root),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([race.exited, new Response(race.stderr).text()])
    expect(code, stderr).toBe(0)
    const outcome = await waitDataRootJson<{
      ownershipID: string
      started: PromiseSettledResult<unknown>["status"]
      stopped: PromiseSettledResult<unknown>["status"]
      ledger: unknown[]
      marker: boolean
      order: string
    }>(result)
    expect(outcome.ownershipID).toStartWith("kernel-")
    expect(outcome.started).toBe("rejected")
    expect(outcome.stopped).toBe("fulfilled")
    expect(outcome.ledger).toEqual([])
    expect(outcome.marker).toBe(false)
    expect(outcome.order).toContain("registered:ledger-absent")
    expect(outcome.order).not.toContain("pre-registration")
    expect(outcome.order).not.toContain("ledger-live")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("an exact absent-ID revoke disposes same-process child data-root coverage", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-kernel-absent-coverage-"))
  const workspace = path.join(root, "workspace")
  const result = path.join(root, "result.json")
  await fs.mkdir(workspace, { recursive: true })
  try {
    const setup = Bun.spawn([process.execPath, registrationRaceFixture, workspace, "setup"], {
      env: dataRootEnvironment(root),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [setupCode, sessionID, setupError] = await Promise.all([
      setup.exited,
      new Response(setup.stdout).text(),
      new Response(setup.stderr).text(),
    ])
    expect(setupCode, setupError).toBe(0)
    const coverage = Bun.spawn(
      [process.execPath, registrationRaceFixture, workspace, "coverage", sessionID.trim(), result],
      { env: dataRootEnvironment(root), stdout: "pipe", stderr: "pipe" },
    )
    const [code, stderr] = await Promise.all([coverage.exited, new Response(coverage.stderr).text()])
    expect(code, stderr).toBe(0)
    expect(await waitDataRootJson<{ marker: boolean; ledger: unknown[] }>(result)).toEqual({
      marker: false,
      ledger: [],
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("legacy POSIX kernel ownership quarantines relocation after its leader exits with an escaped worker", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-kernel-legacy-containment-"))
  const runner = path.join(root, "legacy.ts")
  const leader = path.join(root, "leader.ts")
  const authority = new URL("../../src/project/authority-process.ts", import.meta.url).href
  const relocation = new URL("../../src/global/data-relocation.ts", import.meta.url).href
  const global = new URL("../../src/global/index.ts", import.meta.url).href
  await fs.writeFile(
    leader,
    `
import fs from "node:fs/promises"
const worker = Bun.spawn([${JSON.stringify(Bun.which("sleep") || "/bin/sleep")}, "30"], {
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
})
worker.unref()
await fs.writeFile(process.argv[2], String(worker.pid))
while (!(await Bun.file(process.argv[3]).exists())) await Bun.sleep(10)
`,
  )
  await fs.writeFile(
    runner,
    `
import fs from "node:fs/promises"
import path from "node:path"
import { AuthorityProcessLedger } from ${JSON.stringify(authority)}
import { DataRelocation } from ${JSON.stringify(relocation)}
import { Global } from ${JSON.stringify(global)}
const workerReady = path.join(${JSON.stringify(root)}, "worker-ready")
const leaderRelease = path.join(${JSON.stringify(root)}, "leader-release")
const child = Bun.spawn([process.execPath, ${JSON.stringify(leader)}, workerReady, leaderRelease], {
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "pipe",
})
let leaderIdentity
for (let attempt = 0; attempt < 100 && !leaderIdentity; attempt++) {
  leaderIdentity = await AuthorityProcessLedger.identity(child.pid)
  if (!leaderIdentity) await Bun.sleep(10)
}
if (!leaderIdentity) throw new Error("legacy fixture has no leader identity")
for (let attempt = 0; attempt < 100 && !(await Bun.file(workerReady).exists()); attempt++) await Bun.sleep(10)
const workerPID = Number((await fs.readFile(workerReady, "utf8")).trim())
const workerIdentity = await AuthorityProcessLedger.identity(workerPID)
if (!workerIdentity) throw new Error("legacy fixture has no escaped worker identity")
const id = "kernel-legacy-containment-test"
const ledger = AuthorityProcessLedger.pathForTests()
await fs.mkdir(path.dirname(ledger), { recursive: true })
await fs.writeFile(ledger, JSON.stringify([{
  version: 1,
  id,
  kind: "kernel",
  pid: child.pid,
  identity: leaderIdentity,
  owns_process_group: true,
  owner_pid: process.pid,
  project_id: "legacy-project",
  session_id: "legacy-session",
  authority_generation: "legacy-generation",
  created_at: new Date().toISOString(),
}], null, 2))
let rejected = false
try { await AuthorityProcessLedger.revoke({ id, kind: "kernel" }) } catch { rejected = true }
await fs.writeFile(leaderRelease, "release")
await child.exited
for (let attempt = 0; attempt < 100 && await AuthorityProcessLedger.owns(child.pid, leaderIdentity); attempt++) {
  await Bun.sleep(10)
}
const leaderGone = !(await AuthorityProcessLedger.owns(child.pid, leaderIdentity))
const workerAliveBefore = await AuthorityProcessLedger.owns(workerPID, workerIdentity)
const source = await Global.Path.dataTarget
const target = path.join(${JSON.stringify(root)}, "relocated")
let relocationError = ""
try { await DataRelocation.relocate(target) } catch (error) { relocationError = String(error) }
const entries = await Bun.file(ledger).json()
const files = await fs.readdir(path.join(Global.Path.config, "data-root-operations")).catch(() => [])
const markers = await Promise.all(files.map((name) => Bun.file(path.join(Global.Path.config, "data-root-operations", name)).json()))
const workerAliveAfter = await AuthorityProcessLedger.owns(workerPID, workerIdentity)
console.log(JSON.stringify({
  rejected,
  leaderGone,
  workerAliveBefore,
  workerAliveAfter,
  retained: entries.some((entry) => entry.id === id && entry.containment === undefined),
  staleMarkerReaped: !markers.some((marker) => marker.pid === child.pid && marker.identity === leaderIdentity),
  relocationBlocked: relocationError.includes("legacy kernel process"),
  targetUnchanged: await Global.Path.dataTarget === source,
}))
try { process.kill(-workerPID, "SIGKILL") } catch {}
`,
  )
  try {
    const proc = Bun.spawn([process.execPath, runner], {
      env: dataRootEnvironment(root),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout.trim())).toEqual({
      rejected: true,
      leaderGone: true,
      workerAliveBefore: true,
      workerAliveAfter: true,
      retained: true,
      staleMarkerReaped: true,
      relocationBlocked: true,
      targetUnchanged: true,
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("cooperative kernel teardown drains a concurrent detached fork storm before its anchor exits", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-kernel-fork-storm-"))
  const workspace = path.join(root, "workspace")
  const result = path.join(root, "result.json")
  await fs.mkdir(workspace, { recursive: true })
  try {
    const setup = Bun.spawn([process.execPath, registrationRaceFixture, workspace, "setup"], {
      env: dataRootEnvironment(root),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [setupCode, sessionID, setupError] = await Promise.all([
      setup.exited,
      new Response(setup.stdout).text(),
      new Response(setup.stderr).text(),
    ])
    expect(setupCode, setupError).toBe(0)
    const storm = Bun.spawn(
      [process.execPath, registrationRaceFixture, workspace, "fork-storm", sessionID.trim(), result],
      { env: dataRootEnvironment(root), stdout: "pipe", stderr: "pipe" },
    )
    const [code, stderr] = await Promise.all([storm.exited, new Response(storm.stderr).text()])
    expect(code, stderr).toBe(0)
    const outcome = await waitDataRootJson<{
      forks: number
      alive: number[]
      containmentAlive: boolean
      ledger: unknown[]
      marker: boolean
    }>(result)
    expect(outcome.forks).toBeGreaterThanOrEqual(30)
    expect(outcome.alive).toEqual([])
    expect(outcome.containmentAlive).toBe(false)
    expect(outcome.ledger).toEqual([])
    expect(outcome.marker).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("a cross-process strict trust revocation requested before spawn cannot leave an executable kernel", async () => {
  if (process.platform === "win32") return
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-kernel-authority-race-"))
  const workspace = path.join(root, "workspace")
  const runner = path.join(root, "kernel.ts")
  const registry = new URL("../../src/science/kernel/registry.ts", import.meta.url).href
  const processModule = new URL("../../src/science/kernel/process.ts", import.meta.url).href
  const launcher = new URL("../../src/process/windows-job-launcher.ts", import.meta.url).href
  const authority = new URL("../../src/project/authority-signal.ts", import.meta.url).href
  const instance = new URL("../../src/project/instance.ts", import.meta.url).href
  const trust = new URL("../../src/project/trust.ts", import.meta.url).href
  const session = new URL("../../src/session/index.ts", import.meta.url).href
  const entered = path.join(root, "spawn-entered")
  const release = path.join(root, "spawn-release")
  const requested = path.join(root, "revoke-requested")
  const acknowledged = path.join(root, "revoke-acknowledged")
  const ready = path.join(root, "owner-ready.json")
  const execute = path.join(root, "execute")
  const result = path.join(root, "result")
  await fs.mkdir(workspace)
  await fs.mkdir(path.join(root, "config"))
  await Bun.write(
    path.join(root, "config", "openscience.json"),
    JSON.stringify({ sandbox: { requireProjectTrust: true } }),
  )
  await Bun.write(
    runner,
    `
import fs from "node:fs/promises"
import { KernelRuntime } from ${JSON.stringify(registry)}
	import { KernelProcessIdentity } from ${JSON.stringify(processModule)}
	import { WindowsJobLauncher } from ${JSON.stringify(launcher)}
import { AuthoritySignal } from ${JSON.stringify(authority)}
import { Instance } from ${JSON.stringify(instance)}
import { ProjectTrust } from ${JSON.stringify(trust)}
import { Session } from ${JSON.stringify(session)}
const wait = async (file, attempt = 0) => {
  if (await Bun.file(file).exists()) return
  if (attempt >= 400) throw new Error("Timed out waiting for " + file)
  await Bun.sleep(10)
  return wait(file, attempt + 1)
}
await Instance.provide({ directory: process.argv[2], fn: async () => {
  const mode = process.argv[3]
  if (mode === "setup") {
    const status = await ProjectTrust.status(Instance.project)
    if (!status.canExecuteProjectCode) await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
    console.log((await Session.create({})).id)
    return
  }
  if (mode === "revoke") {
    await fs.writeFile(${JSON.stringify(requested)}, "requested")
    const status = await ProjectTrust.status(Instance.project)
    await ProjectTrust.update(Instance.project, { trusted: false, root: status.root })
    await fs.writeFile(${JSON.stringify(acknowledged)}, "acknowledged")
    return
  }
  const kernels = new Map()
  KernelRuntime.register({
    language: "authority-race-test",
	    async get(id, options) {
      await fs.writeFile(${JSON.stringify(entered)}, "entered")
      await wait(${JSON.stringify(release)})
	      const wrapped = WindowsJobLauncher.wrap({
          file: Bun.which("sleep") || "/bin/sleep",
          args: ["30"],
          linuxOwner: options?.processOwnership?.linuxOwner,
        })
	      const child = Bun.spawn([wrapped.file, ...wrapped.args], { detached: true, stdout: "ignore", stderr: "ignore" })
	      WindowsJobLauncher.bind(child, wrapped.release)
	      const ownership = options?.processOwnership ? { ...options.processOwnership, windowsRelease: wrapped.release } : undefined
	      const identity = await KernelProcessIdentity.register(child, ownership)
	      if (!identity) throw new Error("Kernel child exited before registration")
      const kernel = {
        id,
        language: "authority-race-test",
        ready: true,
        process: identity,
        async start() {},
        async execute() { return { ok: true, outputs: [], stdout: "", stderr: "" } },
        async shutdown() { await KernelProcessIdentity.terminate(identity) },
      }
      kernels.set(id, kernel)
      return kernel
    },
    async release(id) {
      await kernels.get(id)?.shutdown()
      kernels.delete(id)
    },
    async shutdownAll() {
      await Promise.all([...kernels.values()].map((kernel) => kernel.shutdown()))
      kernels.clear()
    },
  })
  const identity = {
    projectID: Instance.project.id,
    sessionID: process.argv[4],
    name: "authority-race",
    language: "authority-race-test",
  }
  const watcher = await AuthoritySignal.watch(async (change) => {
    if (change.type !== "event" || change.event.kind !== "trust" || !change.event.denied) return
    await KernelRuntime.releaseProject(Instance.project.id)
  }, 10)
  const kernel = await KernelRuntime.get(identity)
  await fs.writeFile(${JSON.stringify(ready)}, JSON.stringify(kernel.process))
  await wait(${JSON.stringify(execute)})
  const outcome = await KernelRuntime.execute(identity, "1").then(
    () => "accepted",
    () => "denied",
  )
  await fs.writeFile(${JSON.stringify(result)}, outcome)
  const stopped = async (attempt = 0) => {
    if (!KernelProcessIdentity.matchesRecorded(kernel.process)) return
    if (attempt >= 400) throw new Error("Revoked kernel was not stopped")
    await Bun.sleep(10)
    return stopped(attempt + 1)
  }
  await stopped()
  await watcher[Symbol.asyncDispose]()
} })
`,
  )
  const env = {
    ...process.env,
    OPENSCIENCE_DATA_DIR: path.join(root, "data"),
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config-xdg"),
    XDG_DATA_HOME: path.join(root, "data-xdg"),
    XDG_STATE_HOME: path.join(root, "state-xdg"),
  }
  const wait = async (file: string, attempt = 0): Promise<void> => {
    if (await Bun.file(file).exists()) return
    if (attempt >= 400) throw new Error(`Timed out waiting for ${file}`)
    await Bun.sleep(10)
    return wait(file, attempt + 1)
  }
  const processes = new Set<ReturnType<typeof Bun.spawn>>()
  const identities: { pid: number; startedAt: number; token?: string }[] = []

  try {
    const setup = Bun.spawn([process.execPath, runner, workspace, "setup"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [setupCode, sessionID, setupError] = await Promise.all([
      setup.exited,
      new Response(setup.stdout).text(),
      new Response(setup.stderr).text(),
    ])
    expect(setupCode, setupError).toBe(0)

    const owner = Bun.spawn([process.execPath, runner, workspace, "owner", sessionID.trim()], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    processes.add(owner)
    await wait(entered)

    const revoker = Bun.spawn([process.execPath, runner, workspace, "revoke"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    processes.add(revoker)
    await wait(requested)
    await Bun.sleep(300)
    expect(await Bun.file(acknowledged).exists()).toBe(false)
    await Bun.write(release, "release")
    await wait(ready)
    const identity = (await Bun.file(ready).json()) as (typeof identities)[number]
    identities.push(identity)
    expect(identity.token).toBeDefined()

    const [revokeCode, revokeError] = await Promise.all([revoker.exited, new Response(revoker.stderr).text()])
    processes.delete(revoker)
    expect(revokeCode, revokeError).toBe(0)
    expect(await Bun.file(acknowledged).exists()).toBe(true)
    await Bun.write(execute, "execute")
    await wait(result)
    expect(await Bun.file(result).text()).toBe("denied")

    const [ownerCode, ownerError] = await Promise.all([owner.exited, new Response(owner.stderr).text()])
    processes.delete(owner)
    expect(ownerCode, ownerError).toBe(0)
    expect(KernelProcessIdentity.matchesRecorded(identity)).toBe(false)
  } finally {
    for (const proc of processes) {
      proc.kill("SIGKILL")
      await proc.exited.catch(() => undefined)
    }
    await Promise.all(identities.map((identity) => KernelProcessIdentity.terminate(identity)))
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)
