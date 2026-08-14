import { expect, test } from "bun:test"
import { rmSync } from "fs"
import os from "os"
import path from "path"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Sandbox } from "../../src/sandbox/sandbox"
import { KernelRuntime, type KernelIdentity } from "../../src/science/kernel/registry"
import type { KernelStartOptions } from "../../src/science/kernel/types"
import { Session } from "../../src/session"
import { pythonKernels } from "../../src/tool/notebook"
import { tmpdir } from "../fixture/fixture"

test("kernel spawn keeps the sandbox policy authorized before a global policy flip", async () => {
  if (!Sandbox.available()) return
  expect(Bun.which("python3") ?? Bun.which("python")).toBeTruthy()

  await using tmp = await tmpdir({ git: true })
  const outside = path.join(os.homedir(), `.openscience-kernel-policy-race-${crypto.randomUUID()}`)
  rmSync(outside, { force: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
      const session = await Session.create({})
      const identity: KernelIdentity = {
        projectID: Instance.project.id,
        sessionID: session.id,
        name: "authority-policy-race",
        language: "python",
      }
      const authorizedPolicy = {
        enabled: true,
        network: "deny" as const,
        allowWrite: [],
        onUnavailable: "error" as const,
        requireProjectTrust: false,
      }
      const mutableConfig = Config as { trustedSandbox: typeof Config.trustedSandbox }
      const originalPolicyResolver = mutableConfig.trustedSandbox
      const originalKernelGet = pythonKernels.get
      let spawnBoundaryEntered = false
      let policyReadsAfterAuthorization = 0
      let captured: KernelStartOptions["sandboxPolicy"]

      mutableConfig.trustedSandbox = async () => {
        if (!spawnBoundaryEntered) return authorizedPolicy
        policyReadsAfterAuthorization++
        return { ...authorizedPolicy, enabled: false }
      }
      pythonKernels.get = async (sessionID, options) => {
        captured = options?.sandboxPolicy
        // KernelRuntime invokes the manager only after its final
        // ExecutionAuthority.require. Simulate the machine-wide setting
        // changing at this exact boundary, before Python is spawned.
        spawnBoundaryEntered = true
        return originalKernelGet.call(pythonKernels, sessionID, options)
      }

      try {
        const result = await KernelRuntime.execute(
          identity,
          `from pathlib import Path\nPath(${JSON.stringify(outside)}).write_text("escaped")`,
          { timeout: 30_000 },
        )

        expect(captured).toMatchObject({
          enabled: true,
          network: "deny",
          onUnavailable: "error",
        })
        expect(Object.isFrozen(captured)).toBe(true)
        expect(Object.isFrozen(captured?.allowWrite)).toBe(true)
        expect(policyReadsAfterAuthorization).toBe(0)
        expect(result.ok).toBe(false)
        expect(await Bun.file(outside).exists()).toBe(false)
        expect(KernelRuntime.status(identity)).toMatchObject({
          active: true,
          authority: { mode: "sandboxed", sandbox: { enabled: true, enforced: true } },
          environment: { sandbox: { requested: true, enforced: true, network: "deny" } },
        })
      } finally {
        pythonKernels.get = originalKernelGet
        mutableConfig.trustedSandbox = originalPolicyResolver
        await KernelRuntime.removeSession(identity.projectID, identity.sessionID)
        rmSync(outside, { force: true })
      }
    },
  })
})
