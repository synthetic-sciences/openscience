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
        // With one connected read/write folder the session works in it, and
        // scratch is described as the place for side outputs.
        expect(prompt).toContain(`Working folder: ${source.path}`)
        expect(prompt).toContain("The Working folder is the user's own directory and the default for relative paths")
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
              SystemPrompt.header({ api: { id: "test" } }),
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

describe("knowledge cutoff line", () => {
  test("names the catalog cutoff, the gap to today, and the decisions it bites", () => {
    const today = new Date("2026-09-14T00:00:00Z")
    const line = SystemPrompt.cutoff("2026-04-30", today)
    expect(line).toStartWith("Knowledge cutoff: 2026-04-30 (per the model catalog), about 5 months before today.")
    expect(line).toContain("look up the current generation before pinning a model, version, baseline or protocol")
    expect(SystemPrompt.cutoff("2026-06", today)).toContain("about 3 months before today")
    expect(SystemPrompt.cutoff("2026-09-01", today)).toContain(", within the last month")
  })

  test("an unlisted cutoff still tells the model its training predates today", () => {
    const line = SystemPrompt.cutoff(undefined)
    expect(line).toStartWith("Knowledge cutoff: not listed for this model; assume it is months before today.")
    expect(SystemPrompt.cutoff("soon")).toStartWith("Knowledge cutoff: not listed for this model")
  })

  test("the environment block carries the line beside the date for every session", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const env = (
          await SystemPrompt.environment(
            { api: { id: "test" }, providerID: "test", knowledge: "2026-02-16" },
            session.id,
          )
        ).join("\n")
        expect(env).toMatch(/Today's date: .*\n  Knowledge cutoff: 2026-02-16 \(per the model catalog\)/)
      },
    })
  })
})
