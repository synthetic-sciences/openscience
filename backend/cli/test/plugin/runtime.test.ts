import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createOpenScienceClient, createOpenScienceRuntime } from "@synsci/sdk/v2"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

type ProviderRequest = {
  tools?: Array<{ function: { name: string } }>
  messages?: Array<{ role: string; content: unknown }>
}

const root = path.resolve(import.meta.dir, "../../../..")

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-external-plugin",
    object: "chat.completion.chunk",
    created: 1,
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

test("an external scientific plugin executes through the public Research API and keeps its rich result over HTTP", async () => {
  const previous = await Config.getGlobalRaw()
  await using cleanup = {
    async [Symbol.asyncDispose]() {
      await Instance.disposeAll()
      await Config.replaceGlobal(previous.content)
    },
  }
  await using external = await tmpdir({
    init: async (directory) => {
      const modules = path.join(directory, "node_modules", "@synsci")
      await fs.mkdir(modules, { recursive: true })
      await fs.symlink(path.join(root, "tooling/plugin"), path.join(modules, "plugin"), "dir")
      await Bun.write(path.join(directory, "package.json"), JSON.stringify({ type: "module" }))
      await Bun.write(
        path.join(directory, "index.ts"),
        Bun.file(path.join(import.meta.dir, "../fixture/calibration-plugin.ts")),
      )
    },
  })
  // The reviewed package lives outside the project and is configured by the
  // trusted host. The standard execution sandbox stays enabled throughout.
  await Config.updateGlobal({
    plugin: [pathToFileURL(path.join(external.path, "index.ts")).href],
    sandbox: { enabled: true },
  })
  const requests: ProviderRequest[] = []
  using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as ProviderRequest
      requests.push(body)
      const available = body.tools?.some((tool) => tool.function.name === "local_lab_summary")
      const completed = body.messages?.some((message) => message.role === "tool")
      const delta =
        available && !completed
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_external_summary",
                  type: "function",
                  function: {
                    name: "local_lab_summary",
                    arguments: JSON.stringify({ values: [1, 2, 3] }),
                  },
                },
              ],
            }
          : {
              role: "assistant",
              content: completed ? "The plugin returned mean 2 and a CSV summary." : "External tool was not offered.",
            }
      return new Response(
        chunk(delta) + chunk({}, available && !completed ? "tool_calls" : "stop") + "data: [DONE]\n\n",
        {
          headers: { "content-type": "text/event-stream" },
        },
      )
    },
  })
  await using project = await tmpdir({ git: true, config: stressProviderConfig(`${provider.url.origin}/v1`) })
  await Instance.provide({
    directory: project.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      expect((await Config.trustedSandbox()).enabled).toBe(true)
      const session = await Session.create({ title: "External scientific tool fixture" })
      using api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => Server.App().fetch(request) })
      const options = { baseUrl: api.url.origin, directory: project.path, projectID: Instance.project.id }
      const runtime = createOpenScienceRuntime(options)
      const client = createOpenScienceClient({ ...options, throwOnError: true })
      const accepted = await runtime.prompt({
        sessionID: session.id,
        requestID: "external-scientific-tool",
        effort: "normal",
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
        delegation: false,
        parts: [
          {
            type: "text",
            text: "Calculate the calibration statistics for [1, 2, 3] using local_lab_summary and return its CSV.",
          },
        ],
      })
      const run = await runtime.wait({
        sessionID: session.id,
        runID: accepted.runID,
        intervalMs: 10,
        signal: AbortSignal.timeout(10_000),
      })
      expect(run.state).toBe("completed")
      expect(
        requests.some((request) => request.tools?.some((tool) => tool.function.name === "local_lab_summary")),
      ).toBe(true)
      expect(
        requests.some((request) =>
          request.messages?.some(
            (message) => message.role === "tool" && JSON.stringify(message.content).includes("mean 2"),
          ),
        ),
      ).toBe(true)
      const messages = (await client.session.messages({ sessionID: session.id })).data!
      const results = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && part.tool === "local_lab_summary")
      expect(results).toHaveLength(1)
      const result = results[0]
      if (result.type !== "tool" || result.state.status !== "completed")
        throw new Error("The external tool did not complete")
      expect(result.state.title).toBe("Sample summary")
      expect(result.state.output).toContain("mean 2")
      expect(result.state.metadata).toMatchObject({
        count: 3,
        mean: 2,
        callID: "call_external_summary",
        truncated: false,
      })
      expect(result.state.attachments).toHaveLength(1)
      const attachment = result.state.attachments![0]
      expect(attachment).toMatchObject({
        type: "file",
        mime: "text/csv",
        filename: "summary.csv",
        sessionID: session.id,
        messageID: result.messageID,
      })
      expect(attachment.id).toStartWith("prt_")
      expect(decodeURIComponent(attachment.url.split(",").slice(1).join(","))).toBe("count,mean\n3,2\n")
      expect(
        (await runtime.replay({ sessionID: session.id })).events.some(
          (event) =>
            event.type === "message.part.updated" && JSON.stringify(event.properties).includes("call_external_summary"),
        ),
      ).toBe(true)
      expect((await Config.trustedSandbox()).enabled).toBe(true)
      const denied = await Session.create({
        title: "Denied plugin fixture",
        permission: [{ permission: "local_lab_summary", pattern: "*", action: "deny" }],
      })
      const before = requests.length
      const deniedReceipt = await runtime.prompt({
        sessionID: denied.id,
        requestID: "denied-external-tool",
        effort: "normal",
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
        delegation: false,
        message: "Calculate calibration statistics using local_lab_summary.",
      })
      expect(
        (
          await runtime.wait({
            sessionID: denied.id,
            runID: deniedReceipt.runID,
            intervalMs: 10,
            signal: AbortSignal.timeout(10_000),
          })
        ).state,
      ).toBe("completed")
      expect(
        requests
          .slice(before)
          .every((request) => !request.tools?.some((tool) => tool.function.name === "local_lab_summary")),
      ).toBe(true)
      expect(
        (await client.session.messages({ sessionID: denied.id }))
          .data!.flatMap((message) => message.parts)
          .some((part) => part.type === "tool" && part.tool === "local_lab_summary"),
      ).toBe(false)
      await Session.remove(denied.id)
      await Session.remove(session.id)
    },
  })
  await Config.replaceGlobal(previous.content)
  await Instance.provide({
    directory: project.path,
    fn: async () => {
      expect(await ToolRegistry.customIDs()).not.toContain("local_lab_summary")
    },
  })
}, 30_000)
