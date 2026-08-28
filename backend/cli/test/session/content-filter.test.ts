import { describe, expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

function filteredResponse() {
  const body = [
    {
      id: "chatcmpl-content-filter",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model: STRESS_PROVIDER_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 0,
        total_tokens: 12,
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  })
}

function textResponse(text: string) {
  const events = [
    {
      id: "chatcmpl-title",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model: STRESS_PROVIDER_MODEL,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl-title",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model: STRESS_PROVIDER_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
      },
    },
  ]
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  })
}

async function waitForUserSummary(sessionID: string, attempt = 0): Promise<string | undefined> {
  const messages = await Session.messages({ sessionID })
  const user = messages.find((message) => message.info.role === "user")
  const title = user?.info.role === "user" ? user.info.summary?.title : undefined
  if (title || attempt >= 100) return title
  await Bun.sleep(5)
  return waitForUserSummary(sessionID, attempt + 1)
}

describe("empty provider content-filter responses", () => {
  test("persist a visible, explicitly retryable provider error", async () => {
    const requests: unknown[] = []
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
        const body = await request.json()
        requests.push(body)
        // The product starts title/summary calls in the background on the first
        // turn. Keep those helpers successful so this test isolates the main
        // response's empty content-filter settlement and leaves no rejected
        // background promise behind for the next test file.
        return JSON.stringify(body).includes("CONTENT_FILTER_MAIN_REQUEST")
          ? filteredResponse()
          : textResponse("Filtered provider response")
      },
    })
    await using tmp = await tmpdir({
      git: true,
      config: stressProviderConfig(`http://127.0.0.1:${server.port}/v1`),
    })

    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: "Filtered provider response" })
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          delegation: false,
          system: "CONTENT_FILTER_MAIN_REQUEST",
          parts: [{ type: "text", text: "Return a deterministic response." }],
        })

        expect(
          requests.filter((request) => JSON.stringify(request).includes("CONTENT_FILTER_MAIN_REQUEST")),
        ).toHaveLength(1)
        expect(result.info).toMatchObject({
          role: "assistant",
          finish: "content-filter",
          error: {
            name: "APIError",
            data: {
              isRetryable: true,
              metadata: { action: "retry", provider_finish_reason: "content-filter" },
            },
          },
        })
        expect(result.info.role === "assistant" ? result.info.error?.data.message : "").toContain("returned no content")
        expect(result.parts.some((part) => part.type === "text" && part.text.trim())).toBe(false)

        const durable = await Session.messages({ sessionID: session.id })
        const assistant = durable.find((message) => message.info.id === result.info.id)
        expect(assistant?.info).toEqual(result.info)
        expect(await waitForUserSummary(session.id)).toBe("Filtered provider response")
      },
    })
  }, 20_000)
})
