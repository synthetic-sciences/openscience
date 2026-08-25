import type { StressScenario } from "../../../../evals/cadence-harness/stress-matrix"

export const STRESS_PROVIDER_ID = "stress"
export const STRESS_PROVIDER_MODEL = "fixture-model"
export const STRESS_PROVIDER_COMPACT_MODEL = "fixture-model-compact"
export const STRESS_SCENARIO_MARKER = "OPENSCIENCE_STRESS_SCENARIO:"

type ChatRequest = {
  model?: string
  stream?: boolean
  messages?: unknown
  tools?: unknown
}

export type StressProviderRequest = {
  scenario?: string
  kind: "main" | "summary" | "child"
  body: ChatRequest
  tools: string[]
  text: string
}

type ToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textFrom).join("\n")
  if (!value || typeof value !== "object") return ""
  return Object.values(value).map(textFrom).join("\n")
}

function toolNames(body: ChatRequest) {
  if (!Array.isArray(body.tools)) return []
  return body.tools
    .map((item) =>
      item && typeof item === "object" && "function" in item
        ? (item as { function?: { name?: unknown } }).function?.name
        : undefined,
    )
    .filter((name): name is string => typeof name === "string")
}

function hasToolResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasToolResult)
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  if (record.role === "tool" || record.type === "tool-result") return true
  return Object.values(record).some(hasToolResult)
}

function responseChunk(delta: Record<string, unknown>, finishReason: string | null, inputTokens = 12) {
  return {
    id: "chatcmpl-stress",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta: finishReason ? {} : delta, finish_reason: finishReason }],
    ...(finishReason
      ? {
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: 3,
            total_tokens: inputTokens + 3,
          },
        }
      : {}),
  }
}

function stream(events: ReturnType<typeof responseChunk>[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  })
}

function textResponse(text: string, inputTokens = 12) {
  return stream([responseChunk({ role: "assistant", content: text }, null), responseChunk({}, "stop", inputTokens)])
}

function toolResponse(call: ToolCall) {
  return stream([
    responseChunk({ role: "assistant", tool_calls: [{ index: 0, ...call }] }, null),
    responseChunk({}, "tool_calls"),
  ])
}

function providerError(stimulus: { status: number; body: string; retryAfterMs?: number }) {
  const transient = stimulus.status === 429 || stimulus.status >= 500
  return Response.json(
    {
      error: {
        message: stimulus.body,
        type: transient ? "server_error" : "invalid_request_error",
        code: stimulus.body,
      },
    },
    {
      status: stimulus.status,
      headers: {
        "retry-after-ms": String(stimulus.retryAfterMs ?? 1),
      },
    },
  )
}

function finalText(scenario: StressScenario) {
  if (scenario.stimulus.kind === "reply") return scenario.stimulus.text
  const expected = scenario.expect.contains?.join(" ") ?? ""
  return [`MATRIX_SCENARIO_COMPLETED:${scenario.id}`, expected].filter(Boolean).join(" ")
}

function scenarioID(text: string) {
  const match = text.match(new RegExp(`${STRESS_SCENARIO_MARKER}([a-z0-9_.-]+)`, "i"))
  return match?.[1]
}

function summaryScenario(text: string, scenarios: Iterable<StressScenario>) {
  const prior = text.match(/Summary for ([a-z0-9_.-]+)/i)?.[1]
  if (prior) return prior
  for (const scenario of scenarios) {
    if (text.includes(scenario.prompt)) return scenario.id
  }
}

function childText(text: string) {
  const profile = text.match(/You own one (explore|execute|review) phase/)?.[1] ?? "child"
  return [
    "## Outcome",
    `Completed the bounded ${profile} fixture.`,
    "## Findings",
    "The deterministic child provider returned an isolated handoff.",
  ].join("\n\n")
}

function summaryText(id: string | undefined, source: string) {
  const preserved = ["MATRIX_COMPACT_CODEWORD", "MATRIX_OBJECTIVE"].filter((value) => source.includes(value))
  return [`Summary for ${id ?? "child"}.`, ...preserved].join(" ")
}

function responseTokens(scenario: StressScenario, count: number) {
  const context = Number(scenario.config?.context)
  if (scenario.category !== "compaction" || count !== 1 || !Number.isFinite(context) || context <= 0) return 12
  const output = Math.min(4_096, Math.floor(context / 2))
  const usable = context - output
  const threshold = Number(scenario.config?.threshold ?? 0.75)
  return Math.floor(usable * threshold) + 250
}

function toolInput(
  scenario: StressScenario,
  stimulus: Extract<StressScenario["stimulus"], { kind: "tool" }>,
  text: string,
) {
  if (typeof stimulus.input !== "object" || !stimulus.input) return stimulus.input
  if (scenario.id === "permissions.full-project") {
    const project =
      text.match(/Project files:\s*(.+?)\s+\(durable and shared across this project\)/)?.[1]?.trim() ??
      text.match(/OpenScience project directory:\s*([^\n]+)/)?.[1]?.trim()
    if (!project) return stimulus.input
    return { ...stimulus.input, filePath: `${project}/scratch.txt` }
  }
  if (scenario.id === "permissions.external-ask") {
    const file = text.match(/STRESS_EXTERNAL_FILE:([^\n]+)/)?.[1]?.trim()
    if (!file) return stimulus.input
    return { ...stimulus.input, filePath: file }
  }
  if (scenario.id === "indexing.local-private") {
    const workspace =
      text.match(/Session scratch:\s*(.+?)\s+\(temporary and isolated to this conversation\)/)?.[1]?.trim() ??
      text.match(/Session scratch directory:\s*([^\n]+)/)?.[1]?.trim()
    if (!workspace) return stimulus.input
    return { ...stimulus.input, folder: `${workspace}/fixture-repository` }
  }
  return stimulus.input
}

export function stressProviderConfig(baseURL: string) {
  return {
    model: `${STRESS_PROVIDER_ID}/${STRESS_PROVIDER_MODEL}`,
    small_model: `${STRESS_PROVIDER_ID}/${STRESS_PROVIDER_MODEL}`,
    default_agent: "research",
    enabled_providers: [STRESS_PROVIDER_ID],
    billing: { llm: "byok" as const },
    provider: {
      [STRESS_PROVIDER_ID]: {
        name: "Deterministic stress provider",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "stress-local-only", baseURL },
        models: {
          [STRESS_PROVIDER_MODEL]: {
            name: "Deterministic stress model",
            tool_call: true,
            limit: { context: 128_000, output: 4_096 },
          },
          [STRESS_PROVIDER_COMPACT_MODEL]: {
            name: "Deterministic compact-context stress model",
            tool_call: true,
            // Keep the declared wire limit large enough for the real research
            // system/tool contract. Individual compaction scenarios still
            // report usage against their configured synthetic window, so
            // they exercise threshold behavior without advertising an input
            // window that the fixed harness itself cannot fit.
            limit: { context: 64_000, output: 4_096 },
          },
        },
      },
    },
  }
}

export function startStressProvider(scenarios: readonly StressScenario[]) {
  const lookup = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
  const requests: StressProviderRequest[] = []
  const counts = new Map<string, number>()
  const partial = `data: ${JSON.stringify(
    responseChunk({ role: "assistant", content: "PARTIAL_BEFORE_DISCONNECT" }, null),
  )}\n\n`
  // A tiny real TCP peer owns the disconnect fixture. It promises a larger
  // HTTP body than it sends and closes the socket, exercising the provider's
  // actual fetch/stream retry path without throwing from Bun.serve itself.
  const disconnect = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.write(
          [
            "HTTP/1.1 200 OK",
            "Content-Type: text/event-stream",
            `Content-Length: ${Buffer.byteLength(partial) + 256}`,
            "Connection: close",
            "",
            partial,
          ].join("\r\n"),
        )
        socket.end()
      },
      open() {},
      close() {},
      error() {},
    },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
        return new Response("not found", { status: 404 })
      }

      const body = (await request.json()) as ChatRequest
      const text = textFrom(body.messages)
      const summary =
        text.includes("The following is the text to summarize:") ||
        text.includes("Output exactly this Markdown structure") ||
        text.includes("You are UPDATING an existing handoff")
      const id = scenarioID(text) ?? (summary ? summaryScenario(text, lookup.values()) : undefined)
      const kind = summary ? "summary" : id ? "main" : "child"
      requests.push({ scenario: id, kind, body, tools: toolNames(body), text })

      if (summary) return textResponse(summaryText(id, text))
      if (!id && text.includes("bounded failure fixture")) {
        return providerError({ status: 400, body: "deterministic_child_failure" })
      }
      if (!id) return textResponse(childText(text))

      const scenario = lookup.get(id)
      if (!scenario) return new Response(`unknown scenario: ${id}`, { status: 400 })
      const count = (counts.get(id) ?? 0) + 1
      counts.set(id, count)

      if (scenario.stimulus.kind === "error" && count === 1) return providerError(scenario.stimulus)
      if (scenario.stimulus.kind === "disconnect" && count === 1) {
        return Response.redirect(`http://127.0.0.1:${disconnect.port}/v1/chat/completions`, 307)
      }

      if (scenario.id === "non_research.local-edit" && count === 1) {
        return toolResponse({
          id: `call_${id.replaceAll(".", "_")}_read`,
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ filePath: "scratch-note.txt" }) },
        })
      }
      if (scenario.id === "non_research.local-edit" && count === 2 && scenario.stimulus.kind === "tool") {
        return toolResponse({
          id: `call_${id.replaceAll(".", "_")}_edit`,
          type: "function",
          function: { name: scenario.stimulus.name, arguments: JSON.stringify(scenario.stimulus.input) },
        })
      }

      if (scenario.stimulus.kind === "tool") {
        const repeat = scenario.stimulus.repeat ?? 1
        if (!hasToolResult(body.messages) || count <= repeat) {
          const input = toolInput(scenario, scenario.stimulus, text)
          return toolResponse({
            id: `call_${id.replaceAll(".", "_")}_${count}`,
            type: "function",
            function: {
              name: scenario.stimulus.name,
              arguments: typeof input === "string" ? input : JSON.stringify(input),
            },
          })
        }
      }

      return textResponse(finalText(scenario), responseTokens(scenario, count))
    },
  })

  return {
    server,
    requests,
    count(id: string) {
      return counts.get(id) ?? 0
    },
    main(id: string) {
      return requests.filter((request) => request.kind === "main" && request.scenario === id)
    },
    async quiet(timeoutMs = 2_000) {
      const started = Date.now()
      const stable = { count: requests.length, since: Date.now() }
      while (Date.now() - started < timeoutMs) {
        await Bun.sleep(20)
        if (stable.count !== requests.length) {
          stable.count = requests.length
          stable.since = Date.now()
          continue
        }
        if (Date.now() - stable.since >= 80) return
      }
      throw new Error("stress provider did not become quiet")
    },
    stop() {
      server.stop(true)
      disconnect.stop(true)
    },
  }
}
