import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AuthorityProcessLedger } from "../../src/project/authority-process"
import { KernelProcessIdentity } from "../../src/science/kernel/process"

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
	      const wrapped = WindowsJobLauncher.wrap({ file: Bun.which("sleep") || "/bin/sleep", args: ["30"] })
	      const child = Bun.spawn([wrapped.file, ...wrapped.args], { detached: true, stdout: "ignore", stderr: "ignore" })
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
	      const wrapped = WindowsJobLauncher.wrap({ file: Bun.which("sleep") || "/bin/sleep", args: ["30"] })
	      const child = Bun.spawn([wrapped.file, ...wrapped.args], { detached: true, stdout: "ignore", stderr: "ignore" })
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

test("a fresh server reaps surviving kernel children after their recorded leader exits", async () => {
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
    expect(await AuthorityProcessLedger.owns(child.pid, child.identity)).toBe(process.platform !== "darwin")

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

test("a cross-process trust revocation requested before spawn cannot leave an executable kernel", async () => {
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
	      const wrapped = WindowsJobLauncher.wrap({ file: Bun.which("sleep") || "/bin/sleep", args: ["30"] })
	      const child = Bun.spawn([wrapped.file, ...wrapped.args], { detached: true, stdout: "ignore", stderr: "ignore" })
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
