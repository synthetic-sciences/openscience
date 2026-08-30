import z from "zod"

const dir = process.env.OPENSCIENCE_E2E_PROJECT_DIR ?? process.cwd()
const title = process.env.OPENSCIENCE_E2E_SESSION_TITLE ?? "E2E Session"
const text = process.env.OPENSCIENCE_E2E_MESSAGE ?? "Seeded for UI e2e"
const model = process.env.OPENSCIENCE_E2E_MODEL ?? "openrouter/openai/gpt-5-nano"
const parts = model.split("/")
const providerID = parts[0] ?? "openrouter"
const modelID = parts.slice(1).join("/") || "openai/gpt-5-nano"
const now = Date.now()

const Artifact = z.object({
  sessionID: z.string().min(1),
  messageID: z.string().min(1),
  kind: z.string().min(1),
  data: z.unknown(),
  tool: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  input: z.record(z.string(), z.unknown()).optional(),
})

if (process.env.OPENSCIENCE_E2E_FAKE_MODEL !== "1") {
  throw new Error("The E2E seed helper only runs inside the isolated deterministic harness")
}

const seed = async () => {
  const { Instance } = await import("../src/project/instance")
  const { InstanceBootstrap } = await import("../src/project/bootstrap")
  const { Session } = await import("../src/session")
  const { MessageV2 } = await import("../src/session/message-v2")
  const { Identifier } = await import("../src/id/id")
  const { Project } = await import("../src/project/project")

  const fixture = process.env.OPENSCIENCE_E2E_ARTIFACT
    ? Artifact.parse(JSON.parse(process.env.OPENSCIENCE_E2E_ARTIFACT))
    : undefined

  await Instance.provide({
    directory: dir,
    init: InstanceBootstrap,
    fn: async () => {
      if (fixture) {
        const message = await MessageV2.get({ sessionID: fixture.sessionID, messageID: fixture.messageID })
        if (message.info.role !== "assistant") throw new Error("Artifact fixtures must belong to an assistant message")

        const id = Identifier.descending("part")
        const callID = `call_science_${fixture.kind.replace(/[^a-z0-9]/gi, "_")}_${now}`
        const part = MessageV2.ToolPart.parse({
          id,
          sessionID: fixture.sessionID,
          messageID: fixture.messageID,
          type: "tool",
          callID,
          tool: fixture.tool ?? "__artifact__",
          state: {
            status: "completed",
            input: fixture.input ?? {},
            output: `${fixture.kind} fixture ready`,
            title: fixture.title ?? `${fixture.kind} fixture`,
            metadata: {
              title: fixture.title ?? `${fixture.kind} fixture`,
              artifact: { kind: fixture.kind, data: fixture.data },
            },
            time: { start: now, end: now },
          },
        })
        await Session.updatePart(part)
        process.stdout.write(JSON.stringify({ partID: id }))
        return
      }

      const session = await Session.create({ title })
      const messageID = Identifier.descending("message")
      const partID = Identifier.descending("part")
      const message = {
        id: messageID,
        sessionID: session.id,
        role: "user" as const,
        effort: "normal" as const,
        time: { created: now },
        agent: "build",
        model: {
          providerID,
          modelID,
        },
      }
      const part = {
        id: partID,
        sessionID: session.id,
        messageID,
        type: "text" as const,
        text,
        time: { start: now },
      }
      await Session.updateMessage(message)
      await Session.updatePart(part)
      await Project.update({ projectID: Instance.project.id, name: "E2E Project" })
    },
  })
}

await seed()
