import { expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Global } from "../../src/global"
import fs from "fs/promises"
import path from "path"

test("global subagent settings replace omitted fields so caller-model reset persists", async () => {
  const previous = await Config.getGlobalRaw()
  try {
    await Config.updateGlobal({
      subagents: { enabled: false, model: "openai/example", usd: 1, tokens: 100, deadlineMs: 600000 },
    })
    await Config.updateGlobal({ subagents: { enabled: false, deadlineMs: 600000 } })
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
        await Config.updateGlobal({ subagents: { enabled: false, tokens: 10000, deadlineMs: 600000 } })
        expect(state()).toBe(initial)
      },
    })
  } finally {
    await Config.replaceGlobal(previous.content)
  }
})

const sidecar = () => path.join(Global.Path.config, "subagents.json")

async function restore(previous: { content: string }) {
  await Config.replaceGlobal(previous.content)
  await fs.rm(sidecar(), { force: true })
  await Config.updateGlobal({})
}

test("bounded-run settings are saved beside the shared config, which older clients can still read", async () => {
  const previous = await Config.getGlobalRaw()
  try {
    await Config.updateGlobal({ subagents: { enabled: true, usd: 0.2, deadlineMs: 600000 } })
    const raw = await Config.getGlobalRaw()
    expect(raw.content).not.toContain("subagents")
    expect(JSON.parse(await Bun.file(sidecar()).text())).toEqual({ enabled: true, usd: 0.2, deadlineMs: 600000 })
    expect((await Config.getGlobal()).subagents).toMatchObject({ enabled: true, usd: 0.2 })
  } finally {
    await restore(previous)
  }
})

test("a block an earlier build wrote into the shared config moves to its own file on the next save", async () => {
  const previous = await Config.getGlobalRaw()
  try {
    await Config.replaceGlobal(
      JSON.stringify({ subagents: { enabled: true, tokens: 5000, deadlineMs: 600000 } }, null, 2),
    )
    expect((await Config.getGlobal()).subagents).toMatchObject({ enabled: true, tokens: 5000 })
    await Config.updateGlobal({ theme: "system" })
    const raw = await Config.getGlobalRaw()
    expect(raw.content).not.toContain("subagents")
    expect(raw.content).toContain('"theme"')
    expect(JSON.parse(await Bun.file(sidecar()).text())).toEqual({ enabled: true, tokens: 5000, deadlineMs: 600000 })
    expect((await Config.getGlobal()).subagents).toMatchObject({ enabled: true, tokens: 5000 })
  } finally {
    await restore(previous)
  }
})
