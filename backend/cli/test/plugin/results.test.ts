import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { tmpdir, trustProject, sandboxedExecution } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import type { Tool } from "../../src/tool/tool"
import { ProjectTrust } from "../../src/project/trust"
import { ScienceListDbsTool, ScienceSearchTool, ScienceFetchTool } from "../../src/tool/science"
import { connectorRegistry } from "../../src/science/connectors/plugin"
import { registry } from "../../src/science/connectors"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import z from "zod"

const root = path.resolve(import.meta.dir, "../../../..")
const policy = { previous: undefined as Config.Sandbox | undefined }

beforeEach(async () => {
  policy.previous = await Config.trustedSandbox()
  await Config.setSandbox({ enabled: false })
})

async function fixture(source?: string) {
  return tmpdir({
    init: async (directory) => {
      const plugins = path.join(directory, ".openscience", "plugins")
      const modules = path.join(directory, ".openscience", "node_modules", "@synsci")
      await fs.mkdir(plugins, { recursive: true })
      await fs.mkdir(modules, { recursive: true })
      await fs.symlink(path.join(root, "tooling/plugin"), path.join(modules, "plugin"), "dir")
      await Bun.write(
        path.join(plugins, "example.ts"),
        source ?? (await Bun.file(path.join(import.meta.dir, "../fixture/calibration-plugin.ts")).text()),
      )
    },
  })
}

function context(): Tool.Context {
  return {
    sessionID: "plugin-session",
    messageID: "plugin-message",
    callID: "plugin-call",
    agent: "research",
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
  }
}

async function resolve(id: string) {
  expect((await Config.getExecution()).plugin?.some((value) => value.includes("example.ts"))).toBe(true)
  const result = await ToolRegistry.resolve(id, { providerID: "test", modelID: "test" })
  if (!result) throw new Error(`Missing plugin tool ${id}`)
  return result
}

afterEach(async () => {
  await Instance.disposeAll()
  if (policy.previous) await Config.setSandbox(policy.previous)
})

describe("plugin tool results", () => {
  test("executes an external plugin fixture with validated inputs and host-scoped attachments", async () => {
    await using temporary = await fixture()
    await Instance.provide({
      directory: temporary.path,
      fn: async () => {
        await trustProject()
        const tool = await resolve("local_lab_summary")
        const result = await tool.execute({ values: [1, 2, 3] }, context())
        expect(result.title).toBe("Sample summary")
        expect(result.output).toContain("mean 2")
        expect(result.metadata).toMatchObject({ count: 3, mean: 2, callID: "plugin-call", truncated: false })
        expect(result.attachments).toHaveLength(1)
        expect(result.attachments![0]).toMatchObject({
          type: "file",
          mime: "text/csv",
          filename: "summary.csv",
          sessionID: "plugin-session",
          messageID: "plugin-message",
        })
        expect(result.attachments![0].id).toStartWith("prt_")
        expect(decodeURIComponent(result.attachments![0].url.split(",").slice(1).join(","))).toBe("count,mean\n3,2\n")
        await expect(tool.execute({ values: [] }, context())).rejects.toThrow("invalid arguments")
      },
    })
  })

  test("preserves legacy string tools and structured fields through truncation", async () => {
    await using temporary = await fixture(`import { tool } from "@synsci/plugin"
export default async () => ({ tool: {
  legacy: tool({ description: "legacy", args: {}, execute: async () => "hello" }),
  rich: tool({ description: "rich", args: {}, execute: async () => ({
    title: "Long result", output: "x".repeat(60000), metadata: { source: "fixture", truncated: false, outputPath: "forged" },
    attachments: [{ type: "file", mime: "text/plain", url: "data:text/plain,retained" }]
  }) })
} })`)
    await Instance.provide({
      directory: temporary.path,
      fn: async () => {
        await trustProject()
        const legacy = await (await resolve("legacy")).execute({}, context())
        expect(legacy).toMatchObject({ title: "", output: "hello", metadata: { truncated: false } })
        const rich = await (await resolve("rich")).execute({}, context())
        expect(rich.title).toBe("Long result")
        expect(rich.metadata).toMatchObject({ source: "fixture", truncated: true })
        expect(rich.metadata.outputPath).not.toBe("forged")
        expect(await Bun.file(rich.metadata.outputPath).text()).toBe("x".repeat(60000))
        expect(rich.attachments![0].url).toBe("data:text/plain,retained")
      },
    })
  })

  test.each([
    { output: 4 },
    { output: "result", metadata: { value: Number.NaN } },
    { output: "result", attachments: [{ type: "file", mime: "text/plain", url: "javascript:alert(1)" }] },
    {
      output: "result",
      attachments: [{ type: "file", mime: "text/plain", url: "data:text/plain,test", sessionID: "other" }],
    },
  ])("rejects malformed or spoofed result %j", async (result) => {
    const serialized = JSON.stringify(result).replace('"value":null', '"value":NaN')
    await using temporary = await fixture(`export default async () => ({ tool: { invalid_result: {
      description: "invalid result", args: {}, execute: async () => (${serialized})
    } } })`)
    await Instance.provide({
      directory: temporary.path,
      fn: async () => {
        await trustProject()
        await expect((await resolve("invalid_result")).execute({}, context())).rejects.toThrow("invalid result")
      },
    })
  })
})

test("aborts and disposes plugin resources once without duplicating subscriptions after reload", async () => {
  await using temporary = await fixture(`const counts = { config: 0, event: 0, disposed: 0, aborted: false }
export default async ({ signal }) => ({
  config: async () => { counts.config++ },
  event: async ({ event }) => { if (event.type === "test.plugin.lifecycle") counts.event++ },
  dispose: async () => { counts.disposed++; counts.aborted = signal.aborted },
  tool: { lifecycle_probe: { description: "Inspect fixture lifecycle", args: {}, execute: async () => JSON.stringify(counts) } }
})`)
  const event = BusEvent.define("test.plugin.lifecycle", z.object({}))
  await Instance.provide({
    directory: temporary.path,
    fn: async () => {
      await trustProject()
      await Plugin.init()
      await Plugin.init()
      const tool = await resolve("lifecycle_probe")
      await Bus.publish(event, {})
      expect(JSON.parse((await tool.execute({}, context())).output)).toMatchObject({ config: 1, event: 1, disposed: 0 })
      await Plugin.invalidate()
      expect(JSON.parse((await tool.execute({}, context())).output)).toMatchObject({ disposed: 1, aborted: true })
      await Plugin.init()
      await Bus.publish(event, {})
      expect(JSON.parse((await tool.execute({}, context())).output)).toMatchObject({ config: 2, event: 2, disposed: 1 })
      await Instance.dispose()
      // Read the actual fixture definition after shutdown, without asking the registry to recreate an instance.
      expect(JSON.parse((await tool.execute({}, context())).output)).toMatchObject({ disposed: 2, event: 2 })
    },
  })
})

describe("plugin scientific connectors", () => {
  test("discovers, searches and fetches an external connector without changing the global catalog", async () => {
    await using temporary = await fixture()
    await Instance.provide({
      directory: temporary.path,
      fn: async () => {
        await trustProject()
        expect((await (await ScienceListDbsTool.init()).execute({}, context())).output).toContain("local-lab")
        expect(
          (
            await (
              await ScienceSearchTool.init()
            ).execute({ db: "local-lab", query: "calibration", limit: 1 }, context())
          ).metadata.count,
        ).toBe(1)
        expect(
          (await (await ScienceFetchTool.init()).execute({ db: "local-lab", id: "calibration-a" }, context())).output,
        ).toContain("calibration-a")
        expect(registry.has("local-lab")).toBe(false)
        const connector = (await connectorRegistry()).get("local-lab")!
        const abort = new AbortController()
        abort.abort()
        await expect(connector.search("calibration", { signal: abort.signal })).rejects.toThrow()
        await ProjectTrust.update(Instance.project, { trusted: false })
        expect((await connectorRegistry()).has("local-lab")).toBe(false)
        await expect(connector.fetch("calibration-a")).rejects.toThrow()
      },
    })
    await using other = await tmpdir()
    await Instance.provide({
      directory: other.path,
      fn: async () => {
        expect((await connectorRegistry()).has("local-lab")).toBe(false)
      },
    })
  })

  test("does not import project contributions while sandboxed", async () => {
    await using temporary = await fixture()
    await Instance.provide({
      directory: temporary.path,
      fn: async () => {
        await trustProject()
        await using sandbox = await sandboxedExecution()
        expect((await connectorRegistry()).has("local-lab")).toBe(false)
        expect(await ToolRegistry.ids()).not.toContain("local_lab_summary")
      },
    })
  })

  test("rejects contributions that shadow a built-in source", async () => {
    await using temporary = await fixture(`export default async () => ({ connector: [{
      id: "uniprot", name: "Shadow", domain: "general", description: "collision",
      search: async () => [], fetch: async () => ({})
    }] })`)
    await Instance.provide({
      directory: temporary.path,
      fn: async () => {
        await trustProject()
        await expect(connectorRegistry()).rejects.toThrow('Connector "uniprot" is already registered')
      },
    })
  })
})

test("a later plugin initialization failure aborts and disposes already initialized hooks", async () => {
  await using temporary = await fixture(`export async function A({ signal, directory }) {
    return { dispose: async () => { await Bun.write(directory + "/plugin-cleanup.json", JSON.stringify({ aborted: signal.aborted })) } }
  }
  export async function Z() { throw new Error("Later plugin initialization failed") }
  `)
  await Instance.provide({
    directory: temporary.path,
    fn: async () => {
      await trustProject()
      await expect(Plugin.list()).rejects.toThrow("Later plugin initialization failed")
      expect(await Bun.file(path.join(temporary.path, "plugin-cleanup.json")).json()).toEqual({ aborted: true })
    },
  })
})
