import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Command } from "../../src/command"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Todo } from "../../src/session/todo"
import { tmpdir, trustProject } from "../fixture/fixture"

const names = ["init", "plan", "goal", "status", "context", "stop", "resume", "compact", "handoff", "checkpoint"]
const workflows = ["review", "verify", "reproduce", "compare", "sources", "export"]
const actions = ["init", "stop", "handoff", "checkpoint"]
const primary = ["compact", "context", "plan", "goal", "resume", "status"]
const retiredGraphSkills = ["initialize-atlas-graph", "initialize-research-graph"]

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
  test("keeps native actions built in and exposes optional workflows as toggleable skills", async () => {
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
        expect(commands.get("goal")?.category).toBe("research")
        expect(commands.get("goal")?.menu).toBeUndefined()
        expect(await commands.get("goal")?.template).toContain("persistent goal")
        expect(await commands.get("goal")?.template).toContain("$ARGUMENTS")
        expect(commands.get("status")?.menu).toBe(true)
        expect(commands.get("context")?.menu).toBe(true)
        expect(commands.get("stop")?.menu).toBe(true)
        expect(commands.get("resume")?.menu).toBe(true)
        expect(commands.get("resume")?.category).toBe("research")
        expect(commands.get("checkpoint")?.menu).toBe(true)
        expect(commands.get("checkpoint")?.category).toBe("session")
        expect(await commands.get("checkpoint")?.template).toBe("")

        expect(commands.has("goals")).toBe(false)
        for (const name of workflows) expect(commands.has(name), name).toBe(false)
        for (const name of retiredGraphSkills) expect(commands.has(name), name).toBe(false)

        for (const name of workflows) {
          const content = await Bun.file(path.join(import.meta.dir, `../../skills/research/${name}/SKILL.md`)).text()
          expect(content, name).toContain(`name: ${name}`)
          expect(content, name).toContain("category: research")
          expect(content, name).not.toContain("entry: false")
          expect(content, name).toContain(`research-workflows/references/${name}.md`)
        }

        for (const name of actions) {
          const content = await Bun.file(path.join(import.meta.dir, `../../skills/other/${name}/SKILL.md`)).text()
          expect(content, name).toContain(`name: ${name}`)
          expect(content, name).not.toContain("entry: false")
        }
        for (const name of primary) {
          const content = await Bun.file(path.join(import.meta.dir, `../../skills/other/${name}/SKILL.md`)).text()
          expect(content, name).toContain(`name: ${name}`)
          expect(content, name).not.toContain("entry: false")
        }

        const template = await commands.get("plan")?.template
        expect(template).toContain("# Research Workflow Engine")
        expect(template).toContain("# Workflow: plan")
        expect(template).toContain("<invocation>")
        expect(template?.split("\n").length ?? 0).toBeGreaterThan(60)
        expect(await commands.get("plan")?.template).toContain("Call `plan_exit` only when")
      },
    })
  })

  test("checkpoint captures durable state without a model call or overwrite", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Recovery study" })
        await seed(session.id)
        await Todo.update({
          sessionID: session.id,
          todos: [
            { id: "done", content: "Resolve the input data", status: "completed", priority: "high" },
            { id: "active", content: "Run the independent check", status: "in_progress", priority: "high" },
          ],
        })

        const first = await SessionPrompt.command({
          sessionID: session.id,
          command: "checkpoint",
          arguments: "before validation",
        })
        const text = first.parts.find((part) => part.type === "text")
        expect(first.info.role === "assistant" ? first.info.cost : -1).toBe(0)
        expect(text?.type === "text" ? text.ignored : false).toBe(true)
        const match = text?.type === "text" ? text.text.match(/`([^`]+\.md)`/) : undefined
        expect(match?.[1]).toBeDefined()

        const firstPath = path.join(tmp.path, match?.[1] ?? "missing")
        const content = await Bun.file(firstPath).text()
        expect(content).toContain("# OpenScience recovery checkpoint")
        expect(content).toContain("Investigate the result and preserve the evidence.")
        expect(content).toContain("Run the independent check")
        expect(content).toContain("## Next action")
        expect(content).toContain("Do not blindly retry")
        expect(await Bun.file(path.join(tmp.path, ".openscience/checkpoints/.gitignore")).text()).toContain("*")
        const git = Bun.spawn(["git", "status", "--short"], { cwd: tmp.path, stdout: "pipe", stderr: "pipe" })
        const [gitStatus, gitCode] = await Promise.all([new Response(git.stdout).text(), git.exited])
        expect(gitCode).toBe(0)
        expect(gitStatus).not.toContain(".openscience/checkpoints")

        const second = await SessionPrompt.command({
          sessionID: session.id,
          command: "checkpoint",
          arguments: "before validation",
        })
        const secondText = second.parts.find((part) => part.type === "text")
        const secondMatch = secondText?.type === "text" ? secondText.text.match(/`([^`]+\.md)`/) : undefined
        expect(secondMatch?.[1]).toBeDefined()
        expect(secondMatch?.[1]).not.toBe(match?.[1])
        expect(await Bun.file(firstPath).exists()).toBe(true)
      },
    })
  })

  test("checkpoint bounds a repository-controlled porcelain listing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Large worktree recovery" })
        await seed(session.id)
        const ignore = path.join(tmp.path, ".openscience/checkpoints/.gitignore")
        await fs.mkdir(path.dirname(ignore), { recursive: true })
        await fs.writeFile(ignore, "#".repeat(70 * 1024))
        await Promise.all(
          Array.from({ length: 400 }, (_, index) =>
            fs.writeFile(path.join(tmp.path, `untracked-${String(index).padStart(4, "0")}-${"x".repeat(180)}.txt`), ""),
          ),
        )

        const response = await SessionPrompt.command({
          sessionID: session.id,
          command: "checkpoint",
          arguments: "before large status",
        })
        const text = response.parts.find((part) => part.type === "text")
        const match = text?.type === "text" ? text.text.match(/`([^`]+\.md)`/) : undefined
        const content = await Bun.file(path.join(tmp.path, match?.[1] ?? "missing")).text()

        expect(content).toContain("- Dirty: yes")
        expect(content).toContain("Git status exceeded 65536 bytes; additional paths were omitted.")
        expect(Buffer.byteLength(content)).toBeLessThan(96 * 1024)
        expect(await Bun.file(ignore).text()).toEndWith("\n*\n")
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

  test("command dispatch preserves research effort and delegation controls", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Command controls" })
        await seed(session.id)
        await SessionPrompt.command({
          sessionID: session.id,
          command: "status",
          arguments: "",
          effort: "ultra",
          delegation: false,
        })
        const latest = (await Session.messages({ sessionID: session.id })).findLast(
          (message) => message.info.role === "user",
        )
        expect(latest?.info).toMatchObject({ role: "user", effort: "ultra", delegation: false })
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

        const goal = await SessionPrompt.command({
          sessionID: session.id,
          command: "goal",
          arguments: "",
        })
        const goalText = goal.parts.find((part) => part.type === "text")
        expect(goal.info.role === "assistant" ? goal.info.cost : -1).toBe(0)
        expect(goalText?.type === "text" ? goalText.ignored : false).toBe(true)
        expect(goalText?.type === "text" ? goalText.text : "").toContain("Describe the objective after `/goal`.")

        const resume = await SessionPrompt.command({
          sessionID: session.id,
          command: "resume",
          arguments: "",
        })
        const resumeText = resume.parts.find((part) => part.type === "text")
        expect(resume.info.role === "assistant" ? resume.info.cost : -1).toBe(0)
        expect(resumeText?.type === "text" ? resumeText.text : "").toContain("No research contract is active")

        const checkpoint = await SessionPrompt.command({
          sessionID: session.id,
          command: "checkpoint",
          arguments: "../../before setup",
        })
        const checkpointText = checkpoint.parts.find((part) => part.type === "text")
        expect(checkpoint.info.role === "assistant" ? checkpoint.info.providerID : "").toBe("openscience")
        expect(checkpoint.info.role === "assistant" ? checkpoint.info.modelID : "").toBe("local")
        expect(checkpoint.info.role === "assistant" ? checkpoint.info.cost : -1).toBe(0)
        expect(checkpointText?.type === "text" ? checkpointText.text : "").toContain(".openscience/checkpoints/")
        expect(checkpointText?.type === "text" ? checkpointText.text : "").not.toContain("../..")
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
