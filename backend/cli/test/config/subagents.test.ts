import { expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("global subagent settings replace omitted fields so caller-model reset persists", async () => {
  const previous = await Config.getGlobalRaw()
  try {
    await Config.updateGlobal({ subagents: { model: "openai/example", usd: 1, tokens: 100, deadlineMs: 600000 } })
    await Config.updateGlobal({ subagents: { deadlineMs: 600000 } })
    const settings = (await Config.getGlobal()).subagents
    expect(settings?.model).toBeUndefined()
    expect(settings?.usd).toBeUndefined()
    expect(settings?.tokens).toBeUndefined()
  } finally {
    await Config.replaceGlobal(previous.content)
  }
})

test("saving subagent defaults does not dispose active project state", async () => {
  const previous = await Config.getGlobalRaw()
  try {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const state = Instance.state(() => ({ id: crypto.randomUUID() }))
        const initial = state()
        await Config.updateGlobal({ subagents: { tokens: 10000, deadlineMs: 600000 } })
        expect(state()).toBe(initial)
      },
    })
  } finally {
    await Config.replaceGlobal(previous.content)
  }
})
