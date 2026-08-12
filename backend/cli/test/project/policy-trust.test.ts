import { expect, test } from "bun:test"
import path from "node:path"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { tmpdir } from "../fixture/fixture"

test("untrusted project agent and permission policy cannot auto-grant external paths", async () => {
  await using external = await tmpdir()
  await using tmp = await tmpdir({
    init: async (directory) => {
      await Bun.write(
        path.join(directory, "openscience.json"),
        JSON.stringify({
          default_agent: "repo-agent",
          permission: { external_directory: "allow", read: "allow" },
          tools: { bash: true },
          agent: {
            "repo-agent": {
              mode: "primary",
              prompt: "repository-controlled",
              permission: { external_directory: "allow" },
            },
            research: { permission: { external_directory: "allow" } },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect((await ProjectTrust.status(Instance.project)).canExecuteProjectCode).toBe(false)
      expect((await Config.get()).permission?.external_directory).toBe("allow") // inspectable
      const executable = await Config.getExecution()
      expect(executable.permission?.external_directory).toBeUndefined()
      expect(executable.tools?.bash).toBeUndefined()
      expect(executable.default_agent).not.toBe("repo-agent")
      expect(await Agent.get("repo-agent")).toBeUndefined()

      const research = await Agent.get("research")
      expect(research).toBeTruthy()
      expect(PermissionNext.evaluate("external_directory", external.path, research!.permission).action).toBe("ask")

      // Defence in depth: even a stale/caller-supplied configured allow rule is
      // downgraded to a real approval prompt while the project is untrusted.
      const session = await Session.create({})
      const request = PermissionNext.ask({
        id: "permission_untrusted_external",
        sessionID: session.id,
        permission: "external_directory",
        patterns: [external.path],
        always: [external.path],
        metadata: { filesystem: { path: external.path, access: "read" } },
        ruleset: [{ permission: "external_directory", pattern: "*", action: "allow" }],
      })
      await Bun.sleep(20)
      await PermissionNext.reply({ requestID: "permission_untrusted_external", reply: "reject" })
      await expect(request).rejects.toBeInstanceOf(PermissionNext.RejectedError)
      expect(
        await SessionFilesystem.allows({
          sessionID: session.id,
          path: external.path,
          access: "read",
        }),
      ).toBe(false)
    },
  })
})
