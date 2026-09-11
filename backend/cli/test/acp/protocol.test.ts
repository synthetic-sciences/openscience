import { expect, test } from "bun:test"
import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type SessionNotification,
} from "@agentclientprotocol/sdk"
import { createOpenScienceClient } from "@synsci/sdk/v2"
import { ACP } from "../../src/acp/agent"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { tmpdir, trustProject } from "../fixture/fixture"

function protocol(directory: string) {
  const controllers: TransformStreamDefaultController<Uint8Array>[] = []
  const stream = () =>
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        controllers.push(controller)
      },
      transform(chunk, controller) {
        controller.enqueue(chunk)
      },
    })
  const input = stream()
  const output = stream()
  const updates: SessionNotification[] = []
  const sdk = createOpenScienceClient({
    baseUrl: "http://openscience.internal",
    fetch: Server.internalFetch(),
    directory,
  })
  const agent = new AgentSideConnection(
    (connection) => new ACP.Agent(connection, { sdk, defaultModel: { providerID: "fixture", modelID: "first" } }),
    ndJsonStream(output.writable, input.readable),
  )
  const client = new ClientSideConnection(
    () => ({
      async requestPermission() {
        return { outcome: { outcome: "cancelled" } }
      },
      async sessionUpdate(update) {
        updates.push(update)
      },
    }),
    ndJsonStream(input.writable, output.readable),
  )
  return {
    client,
    sdk,
    updates,
    async [Symbol.asyncDispose]() {
      for (const controller of controllers) controller.terminate()
      await Promise.all([agent.closed, client.closed])
    },
  }
}

test("ACP SDK routes stable session and model configuration requests over JSON-RPC", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      enabled_providers: ["fixture"],
      provider: {
        fixture: {
          name: "Fixture",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:9", apiKey: "test-only" },
          models: {
            first: { name: "First", limit: { context: 8192, output: 1024 } },
            second: {
              name: "Second",
              limit: { context: 8192, output: 1024 },
              variants: { high: { reasoningEffort: "high" } },
            },
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      await using wire = protocol(tmp.path)
      const init = await wire.client.initialize({ protocolVersion: 1, clientCapabilities: {} })
      expect(init.agentCapabilities?.sessionCapabilities).toMatchObject({ list: {}, resume: {} })
      expect(init.agentCapabilities?.mcpCapabilities?.acp).not.toBe(true)
      const created = await wire.client.newSession({ cwd: tmp.path, mcpServers: [] })
      const sessionId = created.sessionId
      expect(created.configOptions).toContainEqual(
        expect.objectContaining({ id: "model", currentValue: "fixture/first" }),
      )
      const selected = await wire.client.setSessionConfigOption({
        sessionId,
        configId: "model",
        value: "fixture/second/high",
      })
      expect(selected.configOptions).toContainEqual(
        expect.objectContaining({
          id: "model",
          category: "model",
          type: "select",
          currentValue: "fixture/second/high",
          options: expect.arrayContaining([expect.objectContaining({ value: "fixture/second/high" })]),
        }),
      )
      expect(selected._meta).toMatchObject({ synsci: { modelId: "fixture/second", variant: "high" } })
      const legacy = await wire.client.request("session/set_model", { sessionId, modelId: "fixture/first" })
      expect(legacy).toMatchObject({ models: { currentModelId: "fixture/first" } })
      const raw = await wire.client.request("session/load", { sessionId, cwd: tmp.path, mcpServers: [] })
      expect(raw).toMatchObject({ models: { currentModelId: "fixture/first" } })
      await expect(wire.client.request("session/set_model", { sessionId, modelId: true })).rejects.toMatchObject({
        code: -32602,
      })
      await expect(wire.client.request("unknown/method", {})).rejects.toMatchObject({ code: -32601 })
      for (const invalid of [
        { configId: "unknown", value: "fixture/first" },
        { configId: "model", value: "fixture/missing" },
        { configId: "model", value: "fixture/second/missing" },
        { configId: "model", value: true, type: "boolean" as const },
      ]) {
        await expect(wire.client.setSessionConfigOption({ sessionId, ...invalid })).rejects.toMatchObject({
          code: -32602,
        })
      }
      const listed = await wire.client.listSessions({ cwd: tmp.path })
      expect(listed.sessions).toContainEqual(expect.objectContaining({ sessionId, cwd: tmp.path }))
      const resumed = await wire.client.resumeSession({ sessionId, cwd: tmp.path, mcpServers: [] })
      expect(resumed.configOptions?.[0].id).toBe("model")
      const loaded = await wire.client.loadSession({ sessionId, cwd: tmp.path, mcpServers: [] })
      expect(loaded.configOptions?.[0].id).toBe("model")
      await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: sessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "research",
        model: { providerID: "fixture", modelID: "second" },
        variant: "high",
      })
      const restored = await wire.client.loadSession({ sessionId, cwd: tmp.path, mcpServers: [] })
      expect(restored.configOptions?.[0]).toMatchObject({ currentValue: "fixture/second/high" })
      expect(restored._meta).toMatchObject({ synsci: { modelId: "fixture/second", variant: "high" } })
      const forked = await wire.client.unstable_forkSession({ sessionId, cwd: tmp.path, mcpServers: [] })
      expect(forked.sessionId).not.toBe(sessionId)
      expect(forked.configOptions?.[0].id).toBe("model")
      const before = await wire.client.listSessions({ cwd: tmp.path })
      await expect(
        wire.client.newSession({ cwd: tmp.path, mcpServers: [{ type: "acp", id: "unsupported", name: "Fixture" }] }),
      ).rejects.toMatchObject({ code: -32602 })
      expect((await wire.client.listSessions({ cwd: tmp.path })).sessions).toEqual(before.sessions)
    },
  })
})
