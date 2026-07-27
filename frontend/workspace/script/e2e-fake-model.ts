const MODEL_ID = "e2e/echo"

export const E2E_TOOL_SENTINELS = {
  question: "E2E_TOOL_QUESTION",
  permission: "E2E_TOOL_PERMISSION",
} as const

type ChatRequest = {
  model?: string
  stream?: boolean
  messages?: unknown
  tools?: unknown
  service_tier?: string
}

type ToolCall = {
  id: string
  type: "function"
  function: {
    name: "question" | "read"
    arguments: string
  }
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
  if (text.includes("E2E_TIER_COMMAND")) {
    return `E2E_TIER_COMMAND_${body.model ?? "unknown"}_${body.service_tier ?? "standard"}`
  }
  return [...text.matchAll(/E2E_OK_\d+/g)].at(-1)?.[0] ?? "E2E reply"
}

function findSentinel(body: ChatRequest) {
  const text = textFrom(body.messages)
  const match = text.match(/\bE2E_TOOL_(QUESTION|PERMISSION)_[A-Za-z0-9_-]+\b/)
  if (!match) return undefined
  return {
    value: match[0],
    kind: match[1] === "QUESTION" ? E2E_TOOL_SENTINELS.question : E2E_TOOL_SENTINELS.permission,
  }
}

function hasToolResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasToolResult)
  if (!value || typeof value !== "object") return false

  const record = value as Record<string, unknown>
  if (record.role === "tool" || record.type === "tool-result") return true
  return Object.values(record).some(hasToolResult)
}

function requestedToolNames(body: ChatRequest) {
  if (!Array.isArray(body.tools)) return []
  return body.tools
    .map((item) =>
      item && typeof item === "object" && "function" in item
        ? (item as { function?: { name?: unknown } }).function?.name
        : undefined,
    )
    .filter((name): name is string => typeof name === "string")
}

function toolCallFor(body: ChatRequest): { call: ToolCall; sentinel: string } | undefined {
  const sentinel = findSentinel(body)
  if (!sentinel || hasToolResult(body.messages)) return undefined

  const name = sentinel.kind === E2E_TOOL_SENTINELS.question ? "question" : "read"
  if (!requestedToolNames(body).includes(name)) return undefined

  const id = `call_${sentinel.value.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`
  if (sentinel.kind === E2E_TOOL_SENTINELS.question) {
    return {
      sentinel: sentinel.value,
      call: {
        id,
        type: "function",
        function: {
          name: "question",
          arguments: JSON.stringify({
            questions: [
              {
                header: "E2E choice",
                question: "How should the deterministic E2E request continue?",
                options: [
                  { label: "Continue", description: "Reply to the real pending question" },
                  { label: "Stop", description: "Choose the alternate response" },
                ],
                multiple: false,
              },
            ],
          }),
        },
      },
    }
  }

  return {
    sentinel: sentinel.value,
    call: {
      id,
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ filePath: "package.json", limit: 1 }),
      },
    },
  }
}

function responseChunk(delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id: "chatcmpl-e2e",
    created: Math.floor(Date.now() / 1000),
    model: "echo",
    choices: [
      {
        index: 0,
        delta: finishReason ? {} : delta,
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
    enabled_providers: ["e2e", "openai"],
    command: {
      "e2e-tier-override": {
        description: "Exercise command model and service mode isolation",
        template: "E2E_TIER_COMMAND",
        model: "e2e/echo-other",
      },
    },
    // Ordinary echo prompts never call tools. The sentinel-only read call below
    // uses this specific override so packaged E2E can exercise the real pending
    // permission lifecycle without making writes or broadening user defaults.
    permission: {
      read: {
        "*/package.json": "ask",
      },
    },
    provider: {
      e2e: {
        name: "E2E echo model",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          echo: {
            name: "E2E echo model",
            tool_call: true,
            limit: { context: 128_000, output: 4_096 },
            // Exercise the workspace's model-variant control without relying
            // on a real provider catalog or making an external inference.
            variants: {
              fast: {},
              thorough: {},
            },
            experimental: {
              modes: {
                fast: {
                  provider: {
                    body: {
                      service_tier: "priority",
                    },
                  },
                },
              },
            },
          },
          "echo-other": {
            name: "E2E alternate model",
            tool_call: true,
            limit: { context: 128_000, output: 4_096 },
            variants: {
              fast: {},
              thorough: {},
            },
            experimental: {
              modes: {
                fast: {
                  provider: {
                    body: {
                      service_tier: "priority",
                    },
                  },
                },
              },
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
      const tool = toolCallFor(body)
      const sentinel = findSentinel(body)
      const reply = sentinel && hasToolResult(body.messages) ? `${sentinel.value}_DONE` : replyFor(body)

      if (!body.stream) {
        if (tool) {
          return Response.json({
            id: "chatcmpl-e2e",
            created: Math.floor(Date.now() / 1000),
            model: "echo",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: null, tool_calls: [tool.call] },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        }
        return Response.json({
          id: "chatcmpl-e2e",
          created: Math.floor(Date.now() / 1000),
          model: "echo",
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      }

      const events = tool
        ? [
            responseChunk({ role: "assistant", tool_calls: [{ index: 0, ...tool.call }] }, null),
            responseChunk({}, "tool_calls"),
          ]
        : [responseChunk({ role: "assistant", content: reply }, null), responseChunk({}, "stop")]
      const bodyText = events.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
      return new Response(`${bodyText}data: [DONE]\n\n`, {
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
