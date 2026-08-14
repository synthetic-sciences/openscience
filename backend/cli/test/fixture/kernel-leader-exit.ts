import fs from "node:fs/promises"
import { spawn } from "node:child_process"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { KernelProcessIdentity } from "../../src/science/kernel/process"
import { KernelRuntime } from "../../src/science/kernel/registry"
import type { Kernel, KernelProcess, KernelStartOptions } from "../../src/science/kernel/types"
import { WindowsJobLauncher } from "../../src/process/windows-job-launcher"
import { Session } from "../../src/session"

const [, , workspace, mode, sessionID = "", ready = "", childFile = "", releaseFile = ""] = process.argv

const wait = async (file: string, attempt = 0): Promise<void> => {
  if (await Bun.file(file).exists()) return
  if (attempt >= 500) throw new Error(`Timed out waiting for ${file}`)
  await Bun.sleep(10)
  return wait(file, attempt + 1)
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

    const kernels = new Map<string, Kernel>()
    KernelRuntime.register({
      language: "leader-exit-test",
      async get(id: string, options?: KernelStartOptions) {
        const existing = kernels.get(id)
        if (existing) return existing
        const command = [
          "-e",
          [
            'import fs from "node:fs/promises"',
            "const [childFile, releaseFile] = process.argv.slice(1)",
            'const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })',
            "child.unref()",
            "await fs.writeFile(childFile, String(child.pid))",
            "while (!(await Bun.file(releaseFile).exists())) await Bun.sleep(10)",
          ].join(";"),
          childFile,
          releaseFile,
        ]
        const wrapped = WindowsJobLauncher.wrap({
          file: process.execPath,
          args: command,
          linuxOwner: options?.processOwnership?.linuxOwner,
        })
        const leader = spawn(wrapped.file, wrapped.args, { detached: true, stdio: "ignore" })
        WindowsJobLauncher.bind(leader, wrapped.release)
        const ownership = options?.processOwnership
          ? { ...options.processOwnership, windowsRelease: wrapped.release }
          : undefined
        const identity = await KernelProcessIdentity.register(leader, ownership)
        if (!identity) throw new Error("Kernel leader exited before registration")
        await wait(childFile)
        const kernel: Kernel = {
          id,
          language: "leader-exit-test",
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

    if (mode === "owner") {
      const status = await ProjectTrust.status(Instance.project)
      if (!status.canExecuteProjectCode) {
        await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
      }
      const kernel = await KernelRuntime.get({
        projectID: Instance.project.id,
        sessionID,
        name: "leader-exit",
        language: "leader-exit-test",
      })
      const processIdentity = kernel.process as KernelProcess
      await fs.writeFile(
        ready,
        JSON.stringify({
          process: processIdentity,
          childPID: Number(await fs.readFile(childFile, "utf8")),
        }),
      )
      await new Promise(() => {})
    }

    if (mode === "remove") await KernelRuntime.removeSession(Instance.project.id, sessionID)
  },
})
