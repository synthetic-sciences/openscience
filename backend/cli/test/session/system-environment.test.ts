import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../fixture/fixture"
import { Config } from "../../src/config/config"

describe("session environment prompt", () => {
  test("shows connected folders and tells the agent to work in place", async () => {
    await using project = await tmpdir()
    await using source = await tmpdir()
    const sandbox = await Config.trustedSandbox()
    await Config.setSandbox({ enabled: false })
    await using restore = {
      async [Symbol.asyncDispose]() {
        await Config.setSandbox(sandbox)
      },
    }
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({ title: "connected source" })
        await SessionFilesystem.grant({
          sessionID: session.id,
          path: source.path,
          access: "write",
          scope: "project",
        })

        const prompt = (await SystemPrompt.environment({ api: { id: "test" }, providerID: "test" }, session.id)).join(
          "\n",
        )

        expect(prompt).toContain(`- ${source.path} (read and write, project scope)`)
        expect(prompt).toContain("Do not ask the user to copy or clone an already-connected folder")
        expect(prompt).toContain("Access mode: Full access")
        await Session.remove(session.id)
      },
    })
  })
})
