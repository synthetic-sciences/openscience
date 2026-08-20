import { describe, expect, test } from "bun:test"
import { Command } from "../../src/command"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Todo } from "../../src/session/todo"
import { tmpdir, trustProject } from "../fixture/fixture"

const names = [
  "plan",
  "review",
  "verify",
  "status",
  "context",
  "stop",
  "compact",
  "handoff",
  "checkpoint",
  "reproduce",
  "compare",
  "sources",
  "export",
]

async function seed(sessionID: string) {
  const message: MessageV2.User = {
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "research",
    model: { providerID: "test", modelID: "model" },
    effort: "normal",
    time: { created: Date.now() },
  }
  await Session.updateMessage(message)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID,
    type: "text",
    text: "Investigate the result and preserve the evidence.",
  })
}

describe("research slash commands", () => {
  test("ships the complete catalog with source, category, usage, and argument-aware prompts", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const commands = new Map((await Command.list()).map((command) => [command.name, command]))
        for (const name of names) {
          const command = commands.get(name)
          expect(command, name).toBeDefined()
          expect(command?.source, name).toBe("builtin")
          expect(command?.category, name).toBeDefined()
          expect(command?.usage, name).toStartWith(`/${name}`)
        }

        expect(commands.get("plan")).toMatchObject({ agent: "plan", subtask: false })
        expect(commands.get("review")).toMatchObject({ agent: "reviewer", subtask: false })
        expect(commands.get("status")?.menu).toBe(true)
        expect(commands.get("context")?.menu).toBe(true)
        expect(commands.get("stop")?.menu).toBe(true)
        expect(await commands.get("verify")?.template).toContain("PASS, FAIL, or NOT TESTED")
        expect(await commands.get("checkpoint")?.template).toContain("side effect whose outcome is unknown")
        expect(await commands.get("reproduce")?.template).toContain("PARTIALLY SUPPORTED")
        expect(await commands.get("compare")?.template).toContain("fair comparison contract")
        expect(await commands.get("sources")?.template).toContain("source ledger")
        expect(await commands.get("export")?.template).toContain("reproduction commands")
      },
    })
  })

  test("status and context are deterministic zero-cost session readouts", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Long-horizon study" })
        await seed(session.id)
        await Todo.update({
          sessionID: session.id,
          todos: [
            { id: "active", content: "Validate the primary result", status: "in_progress", priority: "high" },
            { id: "next", content: "Export the report", status: "pending", priority: "medium" },
          ],
        })
        const before = MessageV2.composition(await Session.messages({ sessionID: session.id }))

        const status = await SessionPrompt.command({
          sessionID: session.id,
          command: "status",
          arguments: "",
        })
        const statusText = status.parts.find((part) => part.type === "text")
        expect(status.info.role).toBe("assistant")
        expect(status.info.role === "assistant" ? status.info.cost : -1).toBe(0)
        expect(statusText?.type === "text" ? statusText.ignored : false).toBe(true)
        expect(statusText?.type === "text" ? statusText.text : "").toContain("1 active, 1 pending")
        expect(statusText?.type === "text" ? statusText.text : "").toContain("Long-horizon study")

        const context = await SessionPrompt.command({
          sessionID: session.id,
          command: "context",
          arguments: "",
        })
        const contextText = context.parts.find((part) => part.type === "text")
        expect(context.info.role === "assistant" ? context.info.cost : -1).toBe(0)
        expect(contextText?.type === "text" ? contextText.text : "").toContain("Conversation estimate")
        expect(contextText?.type === "text" ? contextText.text : "").toContain("deterministic conversation estimate")
        expect(MessageV2.composition(await Session.messages({ sessionID: session.id })).total).toBe(before.total)
      },
    })
  })

  test("native readouts work in a brand-new session without a configured model", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Empty study" })
        const result = await SessionPrompt.command({
          sessionID: session.id,
          command: "status",
          arguments: "",
        })
        const text = result.parts.find((part) => part.type === "text")
        expect(result.info.role === "assistant" ? result.info.providerID : "").toBe("openscience")
        expect(result.info.role === "assistant" ? result.info.modelID : "").toBe("local")
        expect(text?.type === "text" ? text.ignored : false).toBe(true)
        expect(text?.type === "text" ? text.text : "").toContain("Empty study")
      },
    })
  })

  test("stop rejects unknown scopes without touching runtime state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Stop scope" })
        await seed(session.id)
        const result = await SessionPrompt.command({
          sessionID: session.id,
          command: "stop",
          arguments: "cluster",
        })
        const part = result.parts.find((item) => item.type === "text")
        expect(part?.type === "text" ? part.text : "").toBe(
          "Use `/stop`, `/stop turn`, `/stop compute`, or `/stop all`.",
        )
      },
    })
  })

  test("stop interrupts a real in-flight session command", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({
          title: "Interrupt command",
          permission: [{ permission: "bash", pattern: "*", action: "allow" }],
        })
        const running = SessionPrompt.shell({
          sessionID: session.id,
          agent: "research",
          model: { providerID: "test", modelID: "model" },
          command: "sleep 10",
        })
        for (const attempt of Array.from({ length: 200 }, (_, index) => index)) {
          if (SessionPrompt.activeController(session.id)) break
          if (attempt === 199) throw new Error("shell command never became active")
          await Bun.sleep(10)
        }

        const stopped = await SessionPrompt.command({
          sessionID: session.id,
          command: "stop",
          arguments: "turn",
        })
        const stoppedText = stopped.parts.find((part) => part.type === "text")
        expect(stoppedText?.type === "text" ? stoppedText.text : "").toBe("Stopped: active turn.")

        const result = await running
        const tool = result.parts.find((part) => part.type === "tool")
        expect(tool?.type === "tool" && tool.state.status === "completed" ? tool.state.output : "").toContain(
          "User aborted the command",
        )
        expect(SessionPrompt.activeController(session.id)).toBeUndefined()
      },
    })
  }, 15_000)
})
