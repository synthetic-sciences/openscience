import { expect, test } from "bun:test"
import { createServer, type IncomingMessage } from "node:http"
import { once } from "node:events"
import { createOpenScienceClient } from "@synsci/sdk/v2/client"
import { submitComposerPrompt, type ComposerPromptInput } from "./prompt-runtime"

type Recorded = { method?: string; path: string; body?: unknown; headers: IncomingMessage["headers"] }
type Reply = { status: number; body?: unknown } | "disconnect"

async function host(reply: (request: Recorded) => Reply | Promise<Reply>) {
  const requests: Recorded[] = []
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    response.setHeader("Access-Control-Allow-Headers", "*")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString()
    const recorded = {
      method: request.method,
      path: request.url!,
      headers: request.headers,
      body: raw ? (JSON.parse(raw) as unknown) : undefined,
    }
    requests.push(recorded)
    const result = await reply(recorded)
    if (result === "disconnect") {
      request.socket.destroy()
      return
    }
    response.writeHead(result.status, { "Content-Type": "application/json" })
    response.end(JSON.stringify(result.body ?? {}))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The test server did not bind a local port")
  return {
    requests,
    client: createOpenScienceClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      directory: "/lab/project",
      projectID: "project_test",
      throwOnError: true,
    }),
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}

const capabilities = {
  protocolVersion: "1.0",
  serverVersion: "test",
  idempotentPrompts: true,
  richInputs: true,
  runSnapshots: true,
  eventRetention: 100,
  crashRecovery: "interrupt",
  decisionScope: "connected_runtime",
}

const input: ComposerPromptInput = {
  sessionID: "ses_science",
  agent: "research",
  messageID: "msg_research",
  effort: "normal",
  model: { providerID: "provider_test", modelID: "model_test" },
  variant: "high",
  tier: "default",
  context: 200_000,
  delegation: true,
  delegationSettings: {
    level: "standard",
    autonomy: "balanced",
    workerModel: { providerID: "worker_test", modelID: "worker_model" },
  },
  parts: [
    { id: "prt_text", type: "text", text: "Analyze the attached calibration data." },
    { id: "prt_file", type: "file", mime: "text/csv", filename: "calibration.csv", url: "data:text/csv,value%0A1%0A2" },
    { id: "prt_agent", type: "agent", name: "statistician" },
    {
      id: "prt_conversation",
      type: "conversation",
      sourceSessionID: "ses_source",
      throughMessageID: "msg_source",
      label: "Calibration plan",
    },
  ],
}

function accepted() {
  return { status: 202, body: { sessionID: input.sessionID, runID: "run_test", status: "accepted" } }
}

test("Research sends the complete composer input to the negotiated runtime with the message ID as request ID", async () => {
  await using server = await host((request) =>
    request.method === "GET" ? { status: 200, body: capabilities } : accepted(),
  )
  await submitComposerPrompt(server.client, input)
  expect(server.requests.map((request) => [request.method, request.path])).toEqual([
    ["GET", "/runtime/capabilities"],
    ["POST", "/runtime/prompt"],
  ])
  const { agent: _, ...expected } = input
  expect(server.requests[1].body).toEqual({ ...expected, requestID: input.messageID })
  for (const request of server.requests) {
    expect(request.headers["x-openscience-directory"]).toBe("/lab/project")
    expect(request.headers["x-openscience-project"]).toBe("project_test")
  }
})

test("only a capabilities 404 selects the legacy prompt route and preserves its fields", async () => {
  await using server = await host((request) => (request.method === "GET" ? { status: 404 } : { status: 200 }))
  await submitComposerPrompt(server.client, input)
  expect(server.requests.map((request) => [request.method, request.path])).toEqual([
    ["GET", "/runtime/capabilities"],
    ["POST", `/session/${input.sessionID}/message`],
  ])
  const { sessionID: _, ...expected } = input
  expect(server.requests[1].body).toEqual(expected)
})

for (const status of [401, 403, 500, 503]) {
  test(`capabilities ${status} fails without submitting either prompt route`, async () => {
    await using server = await host(() => ({ status, body: { message: "Service unavailable" } }))
    await expect(submitComposerPrompt(server.client, input)).rejects.toMatchObject({ status })
    expect(server.requests.map((request) => request.path)).toEqual(["/runtime/capabilities"])
  })
}

for (const body of [{}, { ...capabilities, protocolVersion: "2.0" }, { ...capabilities, richInputs: false }]) {
  test(`unsupported capability document ${JSON.stringify(body)} does not downgrade`, async () => {
    await using server = await host(() => ({ status: 200, body }))
    await expect(submitComposerPrompt(server.client, input)).rejects.toThrow("runtime protocol")
    expect(server.requests).toHaveLength(1)
  })
}

for (const result of [{ status: 404 }, { status: 500 }, "disconnect"] as const) {
  test(`runtime submission ${JSON.stringify(result)} never retries through the legacy route`, async () => {
    await using server = await host((request) =>
      request.method === "GET" ? { status: 200, body: capabilities } : result,
    )
    await expect(submitComposerPrompt(server.client, input)).rejects.toBeDefined()
    expect(server.requests.map((request) => request.path)).toEqual(["/runtime/capabilities", "/runtime/prompt"])
  })
}

test("a dropped capabilities connection does not assume an older server", async () => {
  await using server = await host(() => "disconnect")
  await expect(submitComposerPrompt(server.client, input)).rejects.toThrow("runtime capabilities")
  expect(server.requests.map((request) => request.path)).toEqual(["/runtime/capabilities"])
})

test("specialized agents retain the legacy route without negotiating the Research protocol", async () => {
  await using server = await host(() => ({ status: 200 }))
  await submitComposerPrompt(server.client, { ...input, agent: "plan" })
  expect(server.requests.map((request) => request.path)).toEqual([`/session/${input.sessionID}/message`])
  expect(server.requests[0].body).toMatchObject({ agent: "plan", parts: input.parts })
})

test("cancelling capability negotiation prevents a later prompt submission", async () => {
  const submitted: string[] = []
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await using server = await host(async () => {
    requested.resolve()
    await release.promise
    return { status: 200, body: capabilities }
  })
  const controller = new AbortController()
  const result = submitComposerPrompt(server.client, input, controller.signal, () => submitted.push("submitted")).catch(
    (error) => error,
  )
  await requested.promise
  controller.abort()
  release.resolve()
  expect((await result).name).toBe("AbortError")
  expect(submitted).toEqual([])
  expect(server.requests.map((request) => request.path)).toEqual(["/runtime/capabilities"])
})

for (const status of [200, 404]) {
  test(`capabilities ${status} hands cancellation to the server exactly once immediately before submitting`, async () => {
    const order: string[] = []
    await using server = await host((request) => {
      order.push(request.method === "GET" ? "capabilities" : "prompt")
      return request.method === "GET" ? { status, body: capabilities } : accepted()
    })
    await submitComposerPrompt(server.client, input, undefined, () => order.push("handoff"))
    expect(order).toEqual(["capabilities", "handoff", "prompt"])
  })
}
