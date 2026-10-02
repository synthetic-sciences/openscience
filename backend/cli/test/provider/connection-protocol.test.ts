import { expect, test } from "bun:test"
import { generateText } from "ai"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test.each(["chat", "responses"] as const)("OpenAI custom endpoint sends the selected %s protocol", async (api) => {
  const requests: { path: string; key: string | null; body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        key: request.headers.get("authorization"),
        body: await request.json(),
      })
      return Response.json({ error: { message: "offline protocol capture" } }, { status: 400 })
    },
  })
  await using tmp = await tmpdir({
    config: { provider: { openai: { options: { apiKey: "fixture", baseURL: `${server.url}v1`, api } } } },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Provider.invalidate()
        await generateText({
          model: await Provider.getLanguage(await Provider.getModel("openai", "gpt-4o")),
          prompt: "Protocol fixture",
          maxRetries: 0,
        }).catch(() => undefined)
        expect(requests).toHaveLength(1)
        expect(requests[0].path).toBe(api === "chat" ? "/v1/chat/completions" : "/v1/responses")
        expect(requests[0].key).toBe("Bearer fixture")
        expect(requests[0].body[api === "chat" ? "messages" : "input"]).toBeArray()
      },
    })
  } finally {
    Provider.invalidate()
    server.stop(true)
  }
})
