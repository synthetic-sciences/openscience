import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { Global } from "../../src/global"
import { WindowsJobLauncher } from "../../src/process/windows-job-launcher"
import { AuthorityProcessLedger } from "../../src/project/authority-process"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { KernelProcessIdentity } from "../../src/science/kernel/process"
import { KernelRuntime } from "../../src/science/kernel/registry"
import type { Kernel, KernelProcess, KernelStartOptions } from "../../src/science/kernel/types"
import { Session } from "../../src/session"

const [, , workspace, mode, sessionID = "", result = ""] = process.argv

const wait = async (check: () => Promise<boolean>, label: string, attempt = 0): Promise<void> => {
  if (await check()) return
  if (attempt >= 1_000) throw new Error(`Timed out waiting for ${label}`)
  await Bun.sleep(10)
  return wait(check, label, attempt + 1)
}

await Instance.provide({
  directory: workspace,
  fn: async () => {
    if (mode === "setup") {
      const status = await ProjectTrust.status(Instance.project)
      if (!status.canExecuteProjectCode) {
        await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
      }
      console.log((await Session.create({})).id)
      return
    }

    const root = path.dirname(result)
    const spawned = path.join(root, "spawned.json")
    const release = path.join(root, "allow-register")
    const registered = path.join(root, "registered")
    const order = path.join(root, "release-order.log")
    const forks = path.join(root, "forks.log")
    const ledger = AuthorityProcessLedger.pathForTests()
    const kernels = new Map<string, Kernel>()
    KernelRuntime.register({
      language: "registration-race-test",
      async get(id: string, options?: KernelStartOptions) {
        const existing = kernels.get(id)
        if (existing) return existing
        const storm = [
          'import fs from "node:fs/promises"',
          'import { spawn } from "node:child_process"',
          'process.on("SIGTERM", () => {})',
          'process.on("SIGHUP", () => {})',
          `const file = ${JSON.stringify(forks)}`,
          `const sleep = ${JSON.stringify(Bun.which("sleep") || "/bin/sleep")}`,
          'for (let index = 0; index < 128; index++) { const child = spawn(sleep, ["30"], { detached: true, stdio: "ignore" }); child.unref(); await fs.appendFile(file, String(child.pid) + "\\n"); await Bun.sleep(1) }',
          "await new Promise(() => {})",
        ].join(";")
        const wrapped = WindowsJobLauncher.wrap({
          file: mode === "fork-storm" ? process.execPath : Bun.which("sleep") || "/bin/sleep",
          args: mode === "fork-storm" ? ["-e", storm] : ["30"],
          linuxOwner: options?.processOwnership?.linuxOwner,
        })
        const child = spawn(wrapped.file, wrapped.args, {
          detached: true,
          stdio: mode === "fork-storm" ? ["ignore", "ignore", "inherit"] : "ignore",
        })
        WindowsJobLauncher.bind(child, wrapped.release)
        const initial = KernelProcessIdentity.capture(child)
        if (!initial?.token || !options?.processOwnership) throw new Error("Missing race-test process ownership")
        await fs.writeFile(spawned, JSON.stringify({ ...initial, ownershipID: options.processOwnership.id }))
        if (mode === "race") await wait(() => Bun.file(release).exists(), release)
        const identity = await KernelProcessIdentity.register(child, {
          ...options.processOwnership,
          windowsRelease: wrapped.release,
        })
        if (!identity) throw new Error("Race-test containment leader exited before registration")
        await fs.writeFile(registered, identity.ownershipID ?? "")
        const kernel: Kernel = {
          id,
          language: "registration-race-test",
          ready: true,
          process: identity,
          async start() {},
          async execute() {
            return { ok: true, outputs: [], stdout: "", stderr: "" }
          },
          async shutdown() {
            await KernelProcessIdentity.terminate(identity)
          },
        }
        kernels.set(id, kernel)
        return kernel
      },
      async release(id: string) {
        const entries = (await Bun.file(ledger)
          .json()
          .catch(() => [])) as Array<{ id?: string }>
        const live = entries.some(
          (entry) => entry.id === (kernels.get(id)?.process as KernelProcess | undefined)?.ownershipID,
        )
        const phase = (await Bun.file(registered).exists()) ? "registered" : "pre-registration"
        await fs.appendFile(order, `${phase}:${live ? "ledger-live" : "ledger-absent"}\n`)
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
      sessionID,
      name: "registration-race",
      language: "registration-race-test",
    }
    if (mode === "coverage") {
      const kernel = await KernelRuntime.get(identity)
      const processIdentity = kernel.process as KernelProcess & { ownershipID: string }
      const operationPath = path.join(Global.Path.config, "data-root-operations")
      const marker = async () => {
        const operations = await fs.readdir(operationPath).catch(() => [])
        const markers = await Promise.all(operations.map((name) => Bun.file(path.join(operationPath, name)).json()))
        return markers.some((item) => item.pid === processIdentity.pid && item.identity === processIdentity.token)
      }
      if (!(await marker())) throw new Error("Missing child-owned data-root coverage before absent-entry revoke")
      process.kill(processIdentity.pid, "SIGTERM")
      await wait(() => Promise.resolve(!KernelProcessIdentity.matchesRecorded(processIdentity)), "containment exit")
      await fs.writeFile(ledger, "[]")
      await AuthorityProcessLedger.revoke({ id: processIdentity.ownershipID, kind: "kernel" })
      await fs.writeFile(result, JSON.stringify({ marker: await marker(), ledger: await Bun.file(ledger).json() }))
      await KernelRuntime.release(identity)
      return
    }
    if (mode === "fork-storm") {
      const kernel = await KernelRuntime.get(identity)
      const processIdentity = kernel.process as KernelProcess & { ownershipID: string }
      const pids = async () =>
        (await fs.readFile(forks, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .map(Number)
          .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
      await wait(async () => (await pids()).length >= 30, "fork storm")
      await KernelRuntime.release(identity)
      const children = await pids()
      const alive = children.filter((pid) => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      })
      const operations = await fs.readdir(path.join(Global.Path.config, "data-root-operations")).catch(() => [])
      const markers = await Promise.all(
        operations.map((name) => Bun.file(path.join(Global.Path.config, "data-root-operations", name)).json()),
      )
      await fs.writeFile(
        result,
        JSON.stringify({
          forks: children.length,
          alive,
          containmentAlive: KernelProcessIdentity.matchesRecorded(processIdentity),
          ledger: await Bun.file(ledger)
            .json()
            .catch(() => []),
          marker: markers.some(
            (marker) => marker.pid === processIdentity.pid && marker.identity === processIdentity.token,
          ),
        }),
      )
      return
    }
    const boot = KernelRuntime.get(identity)
    await wait(() => Bun.file(spawned).exists(), spawned)
    const processIdentity = (await Bun.file(spawned).json()) as KernelProcess & { ownershipID: string }
    await fs.rm(ledger, { force: true })
    const stop = KernelRuntime.release(identity)
    // This is the audited interleaving: reclaim has completed its first exact
    // ID revoke while register is still paused and the durable ledger is empty.
    await wait(async () => {
      const entries = await Bun.file(ledger)
        .json()
        .catch(() => undefined)
      return Array.isArray(entries) && !entries.length
    }, "the first missed-ledger revoke")
    await fs.writeFile(release, "register")
    const [started, stopped] = await Promise.allSettled([boot, stop])
    await wait(() => Promise.resolve(!KernelProcessIdentity.matchesRecorded(processIdentity)), "containment teardown")
    const entries = await Bun.file(ledger)
      .json()
      .catch(() => [])
    const operations = await fs.readdir(path.join(Global.Path.config, "data-root-operations")).catch(() => [])
    const markers = await Promise.all(
      operations.map((name) => Bun.file(path.join(Global.Path.config, "data-root-operations", name)).json()),
    )
    await fs.writeFile(
      result,
      JSON.stringify({
        ownershipID: processIdentity.ownershipID,
        started: started.status,
        stopped: stopped.status,
        ledger: entries,
        marker: markers.some(
          (marker) => marker.pid === processIdentity.pid && marker.identity === processIdentity.token,
        ),
        order: await fs.readFile(order, "utf8").catch(() => ""),
      }),
    )
  },
})
