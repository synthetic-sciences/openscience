import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { CommandRuntime } from "../../src/science/command/registry"
import { BashTool } from "../../src/tool/bash"
import { executionSession, tmpdir } from "../fixture/fixture"

const context = (sessionID: string) => ({
  sessionID,
  messageID: "msg_live_command",
  callID: "call_live_command",
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata() {},
  async ask() {},
})

test("bash registers only its live process in the project compute ledger", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await BashTool.init()
      const running = tool.execute(
        { command: "sleep 10", description: "Waiting for analysis input" },
        context(session.id),
      )
      const find = async (attempt = 0): Promise<ReturnType<typeof CommandRuntime.list>[number]> => {
        const command = CommandRuntime.list(Instance.project.id, session.id)[0]
        if (command) return command
        if (attempt >= 100) throw new Error("Live command did not enter the compute ledger")
        await Bun.sleep(10)
        return find(attempt + 1)
      }
      const command = await find()

      expect(command).toMatchObject({
        sessionID: session.id,
        messageID: "msg_live_command",
        callID: "call_live_command",
        description: "Waiting for analysis input",
        command: "sleep 10",
        state: "running",
        process_id: expect.any(Number),
      })
      expect(await CommandRuntime.stop(command.id, Instance.project.id, session.id)).toBe(true)
      expect((await running).output).toContain("User aborted the command")
      expect(CommandRuntime.list(Instance.project.id, session.id)).toEqual([])
    },
  })
}, 30_000)
