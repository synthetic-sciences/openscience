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
        expect(prompt).toContain(`Project files: ${project.path} (durable and shared across this project)`)
        expect(prompt).toContain(`Session scratch: ${await SessionFilesystem.workspace(session.id)}`)
        expect(prompt).toContain("Results: immutable project-wide deliverables")
        expect(prompt).toContain("may aggregate multiple connected folders and files")
        expect(prompt).toContain("a normal workspace file is not a Result")
        expect(prompt).toContain("Use Session scratch by default for one-off downloads")
        expect(prompt).toContain("Do not create a new project subfolder for an ordinary answer")
        expect(prompt).toContain("Use the human project name in conversation, not UUID directory components")
        expect(prompt).toContain(
          "Do not expose scratch, managed-project, or connected-folder paths in a generic greeting",
        )
        expect(prompt).toContain("Access mode: Full access")
        await Session.remove(session.id)
      },
    })
  })

  test("core prompt requires durable state without model-invented research ceilings", () => {
    const prompt = SystemPrompt.instructions()

    expect(prompt).toContain("You are OpenScience, a local-first Research agent.")
    expect(prompt).toContain("Before costly multi-stage work, define and maintain `research_contract`")
    expect(prompt).toContain("save required Results")
    expect(prompt).toContain("Never set a `max_*` field unless the user gave that exact numeric limit")
    expect(prompt).toContain("Create user-visible provenance records only when explicitly requested")
  })
})
