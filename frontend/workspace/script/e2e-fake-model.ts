const MODEL_ID = "e2e/echo"

type ChatRequest = {
  stream?: boolean
  messages?: unknown
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textFrom).join("\n")
  if (!value || typeof value !== "object") return ""

  const record = value as Record<string, unknown>
  if (typeof record.text === "string") return record.text
  if ("content" in record) return textFrom(record.content)
  return ""
}

function replyFor(body: ChatRequest) {
  const text = textFrom(body.messages)
  return text.match(/E2E_OK_\d+/)?.[0] ?? "E2E reply"
}

function responseChunk(reply: string, finishReason: string | null) {
  return {
    id: "chatcmpl-e2e",
    created: Math.floor(Date.now() / 1000),
    model: "echo",
    choices: [
      {
        index: 0,
        delta: finishReason ? {} : { role: "assistant", content: reply },
        finish_reason: finishReason,
      },
    ],
    ...(finishReason
      ? {
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        }
      : {}),
  }
}

export function fakeModelConfig(baseURL: string) {
  return {
    model: MODEL_ID,
    small_model: MODEL_ID,
    enabled_providers: ["e2e"],
    provider: {
      e2e: {
        name: "E2E echo model",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          echo: {
            name: "E2E echo model",
            tool_call: false,
            limit: { context: 128_000, output: 4_096 },
            // Exercise the workspace's model-variant control without relying
            // on a real provider catalog or making an external inference.
            variants: {
              fast: {},
              thorough: {},
            },
          },
        },
        options: {
          apiKey: "e2e-local-only",
          baseURL,
        },
      },
    },
  }
}

export function startFakeModelServer(port: number, hostname = "127.0.0.1") {
  return Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/health") return Response.json({ healthy: true })
      if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
        return new Response("Not found", { status: 404 })
      }

      const body = (await request.json()) as ChatRequest
      const reply = replyFor(body)

      if (!body.stream) {
        return Response.json({
          id: "chatcmpl-e2e",
          created: Math.floor(Date.now() / 1000),
          model: "echo",
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      }

      const events = [responseChunk(reply, null), responseChunk("", "stop")]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("")
      return new Response(`${events}data: [DONE]\n\n`, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      })
    },
  })
}

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (import.meta.main) {
  const port = Number(argument("--port") ?? "4097")
  const baseURL = `http://127.0.0.1:${port}/v1`
  if (process.argv.includes("--print-config")) {
    process.stdout.write(JSON.stringify(fakeModelConfig(baseURL)))
  } else {
    const server = startFakeModelServer(port)
    console.log(`E2E fake model listening on ${server.url}`)
  }
}

export { MODEL_ID as fakeModelID }
