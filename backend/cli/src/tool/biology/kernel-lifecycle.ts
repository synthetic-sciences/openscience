import { rmSync } from "node:fs"
import type { ChildProcess } from "node:child_process"
import { AuthorityProcessLedger } from "@/project/authority-process"
import { Shell } from "@/shell/shell"

/**
 * Process lifecycle state for the legacy biology notebook kernel.
 *
 * Keep this module independent from Tool/Agent/Registry initialization. Project
 * bootstrap must be able to retire kernels while those registries are still
 * evaluating (for example, when a filesystem authority grant arrives during
 * startup) without re-entering the biology tool module and observing a TDZ.
 */
export namespace BiologyKernelLifecycle {
  export interface Kernel {
    process: ChildProcess
    projectID: string
    scriptPath: string
    configPath: string
    cachePath: string
    lastUsed: number
    generation: string
    authorityID: string
  }

  export const kernels = new Map<string, Kernel>()

  export function remove(id: string, kernel: Kernel) {
    rmSync(kernel.scriptPath, { force: true })
    rmSync(kernel.configPath, { force: true })
    rmSync(kernel.cachePath, { recursive: true, force: true })
    if (kernels.get(id) === kernel) kernels.delete(id)
    void AuthorityProcessLedger.complete(kernel.authorityID).catch(() => undefined)
  }

  export function cleanupAll() {
    for (const [id, kernel] of kernels) {
      Shell.killTreeSync(kernel.process, { detached: process.platform !== "win32" })
      remove(id, kernel)
    }
  }

  export async function releaseSession(projectID: string, sessionID: string) {
    const kernel = kernels.get(sessionID)
    if (kernel && kernel.projectID === projectID) {
      await AuthorityProcessLedger.revoke({ id: kernel.authorityID, kind: "biology" })
      remove(sessionID, kernel)
    }
    await AuthorityProcessLedger.revoke({ kind: "biology", projectID, sessionID })
  }

  export async function releaseProject(projectID: string) {
    const sessions = [...kernels].filter(([, kernel]) => kernel.projectID === projectID).map(([sessionID]) => sessionID)
    await Promise.all(sessions.map((sessionID) => releaseSession(projectID, sessionID)))
    await AuthorityProcessLedger.revoke({ kind: "biology", projectID })
  }
}

process.on("exit", BiologyKernelLifecycle.cleanupAll)
process.on("SIGTERM", BiologyKernelLifecycle.cleanupAll)
process.on("SIGINT", BiologyKernelLifecycle.cleanupAll)
