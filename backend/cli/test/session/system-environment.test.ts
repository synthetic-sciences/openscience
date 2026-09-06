import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../fixture/fixture"
import { ProjectAccess } from "../../src/project/access"
import { ExecutionAuthority } from "../../src/project/execution"
import { ProjectTrust } from "../../src/project/trust"
import { Storage } from "../../src/storage/storage"

describe("session environment prompt", () => {
  test("shows connected folders and tells the agent to work in place", async () => {
    await using project = await tmpdir()
    await using source = await tmpdir()
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const access = await ProjectAccess.status(Instance.project)
        await ProjectAccess.update(Instance.project, { mode: "full", root: access.root })
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
    expect(prompt).toContain("Use the default tool working directory described by the environment")
  })

  test.each(["isolated", "project"] as const)(
    "%s workspace guidance reflects durable authority without changing trust or permissions",
    async (workspace) => {
      await using project = await tmpdir()
      await using source = await tmpdir()
      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const access = await ProjectAccess.status(Instance.project)
          await ProjectAccess.update(Instance.project, { mode: "ask", root: access.root })
          const session = await Session.create({ workspace })
          try {
            await SessionFilesystem.grant({
              sessionID: session.id,
              path: source.path,
              access: "read",
              scope: "project",
            })
            // Existing sessions may lack the new public selection field. The
            // filesystem's durable workspace record must determine the prompt.
            await Storage.update<Session.Info>(["session", Instance.project.id, session.id], (draft) => {
              delete draft.workspace
            })
            const before = await ExecutionAuthority.decide({ sessionID: session.id, capability: "shell" })
            const trust = await ProjectTrust.status(Instance.project)
            const prompt = [
              SystemPrompt.instructions(),
              ...(await SystemPrompt.environment({ api: { id: "test" }, providerID: "test" }, session.id)),
            ].join("\n")

            expect(prompt).toContain("Access mode: Ask for approval. Project actions require explicit approval.")
            expect(prompt).toContain(`- ${source.path} (read only, project scope)`)
            expect(prompt).toContain("Never expose secrets or")
            expect(prompt).toContain("Respect filesystem grants, sandbox, network policy, and project permissions")
            if (workspace === "project") {
              expect(before.workspace).toBe(project.path)
              expect(prompt).toContain(`Tool working directory: ${project.path} (project directory; durable and shared`)
              expect(prompt).toContain("its files are shared and remain when the session is deleted")
              expect(prompt).toContain("Use the project directory by default for local work")
              expect(prompt).not.toContain("temporary and isolated to this conversation")
              expect(prompt).not.toContain("Session scratch belongs only to this conversation")
              expect(prompt).not.toContain("Use Session scratch by default")
            } else {
              expect(before.workspace).not.toBe(project.path)
              expect(prompt).toContain(
                `Session scratch: ${before.workspace} (temporary and isolated to this conversation)`,
              )
              expect(prompt).toContain("Use Session scratch by default for one-off downloads")
              expect(prompt).not.toContain("Use the project directory by default for local work")
            }
            expect(await ExecutionAuthority.decide({ sessionID: session.id, capability: "shell" })).toEqual(before)
            expect(await ProjectTrust.status(Instance.project)).toEqual(trust)
          } finally {
            await Session.remove(session.id)
          }
        },
      })
    },
  )
})
