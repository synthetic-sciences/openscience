import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { DataRelocation } from "../../src/global/data-relocation"
import { Global } from "../../src/global"
import { WindowsJobLauncher } from "../../src/process/windows-job-launcher"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { KernelProcessIdentity } from "../../src/science/kernel/process"
import { KernelRuntime } from "../../src/science/kernel/registry"
import type { Kernel, KernelStartOptions } from "../../src/science/kernel/types"
import { Session } from "../../src/session"

const [, , workspace, mode, sessionID = "", signal = "", auxiliary = ""] = process.argv

const wait = async (file: string, attempt = 0): Promise<void> => {
  if (await Bun.file(file).exists()) return
  if (attempt >= 1_000) throw new Error(`Timed out waiting for ${file}`)
  await Bun.sleep(10)
  return wait(file, attempt + 1)
}

if (mode === "relocate") {
  const result = await DataRelocation.relocate(signal)
  await fs.writeFile(auxiliary, JSON.stringify(result))
} else {
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

      const kernels = new Map<string, Kernel>()
      KernelRuntime.register({
        language: "data-root-lifecycle-test",
        async get(id: string, options?: KernelStartOptions) {
          const existing = kernels.get(id)
          if (existing) return existing
          const oldRoot = await Global.Path.dataTarget
          const workerReady = path.join(path.dirname(signal), "worker.json")
          const heldFile = path.join(oldRoot, "kernel-held-open.log")
          const workerScript = [
            'import fs from "node:fs/promises"',
            "const [heldFile, ready] = process.argv.slice(1)",
            'const handle = await fs.open(heldFile, "a")',
            "await fs.writeFile(ready, JSON.stringify({ pid: process.pid }))",
            'for (;;) { await handle.write("tick\\n"); await handle.sync(); await Bun.sleep(10) }',
          ].join(";")
          const payloadScript = [
            'import fs from "node:fs/promises"',
            "const [runtime, workerScript, heldFile, ready] = process.argv.slice(1)",
            'const worker = Bun.spawn([runtime, "-e", workerScript, heldFile, ready], { stdout: "ignore", stderr: "ignore" })',
            "worker.unref()",
            "await new Promise(() => {})",
          ].join(";")
          const wrapped = WindowsJobLauncher.wrap({
            file: process.execPath,
            args: ["-e", payloadScript, process.execPath, workerScript, heldFile, workerReady],
            linuxOwner: options?.processOwnership?.linuxOwner,
          })
          const leader = spawn(wrapped.file, wrapped.args, { detached: true, stdio: "ignore" })
          WindowsJobLauncher.bind(leader, wrapped.release)
          const ownership = options?.processOwnership
            ? { ...options.processOwnership, windowsRelease: wrapped.release }
            : undefined
          const identity = await KernelProcessIdentity.register(leader, ownership)
          if (!identity) throw new Error("Kernel containment leader exited before registration")
          if (mode === "owner-crash-window") {
            await fs.writeFile(signal, JSON.stringify(identity))
            await new Promise(() => {})
          }
          await wait(workerReady)
          const kernel: Kernel = {
            id,
            language: "data-root-lifecycle-test",
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
          await kernels.get(id)?.shutdown()
          kernels.delete(id)
        },
        async shutdownAll() {
          await Promise.all([...kernels.values()].map((kernel) => kernel.shutdown()))
          kernels.clear()
        },
      })

      if (mode === "recover") {
        await KernelRuntime.restoreSession(Instance.project.id, sessionID)
        await Instance.dispose()
        return
      }

      const kernel = await KernelRuntime.get({
        projectID: Instance.project.id,
        sessionID,
        name: "data-root-lifecycle",
        language: "data-root-lifecycle-test",
      })
      const worker = (await Bun.file(path.join(path.dirname(signal), "worker.json")).json()) as { pid: number }
      await fs.writeFile(signal, JSON.stringify({ process: kernel.process, worker }))
      await new Promise(() => {})
    },
  })
}
