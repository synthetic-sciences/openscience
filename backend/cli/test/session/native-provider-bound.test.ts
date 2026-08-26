import { describe, expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"

type Adapter = "anthropic" | "google"
type Body = Record<string, unknown>
type Captured = {
  adapter: Adapter
  body: Body
  scenario?: string
  summary: boolean
}

const adapters = ["anthropic", "google"] as const
const marker = "OPENSCIENCE_NATIVE_WIRE_SCENARIO:"
const modelIDs = {
  anthropic: "claude-3-5-sonnet",
  google: "gemini-2.0-flash",
} as const

function flatten(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(flatten).join("\n")
  if (!value || typeof value !== "object") return ""
  return Object.values(value).map(flatten).join("\n")
}

function userText(adapter: Adapter, body: Body) {
  const messages = adapter === "anthropic" ? body.messages : body.contents
  if (!Array.isArray(messages)) return ""
  return messages
    .filter(
      (message): message is Record<string, unknown> =>
        !!message && typeof message === "object" && message.role === "user",
    )
    .map((message) => flatten(adapter === "anthropic" ? message.content : message.parts))
    .join("\n")
}

function systemText(adapter: Adapter, body: Body) {
  return flatten(adapter === "anthropic" ? body.system : body.systemInstruction)
}

function toolNames(adapter: Adapter, body: Body) {
  if (!Array.isArray(body.tools)) return []
  if (adapter === "anthropic") {
    return body.tools
      .map((tool: unknown) => (tool && typeof tool === "object" && "name" in tool ? tool.name : undefined))
      .filter((name: unknown): name is string => typeof name === "string")
  }
  return body.tools.flatMap((group) => {
    if (!group || typeof group !== "object" || !("functionDeclarations" in group)) return []
    if (!Array.isArray(group.functionDeclarations)) return []
    return group.functionDeclarations
      .map((tool: unknown) => (tool && typeof tool === "object" && "name" in tool ? tool.name : undefined))
      .filter((name: unknown): name is string => typeof name === "string")
  })
}

function anthropicResponse(output: string, model: string) {
  const events = [
    {
      type: "message_start",
      message: { id: "msg_native_fixture", model, usage: { input_tokens: 12 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: output } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: "message_stop" },
  ]
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

function googleResponse(output: string) {
  const value = {
    candidates: [{ content: { role: "model", parts: [{ text: output }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
  }
  return new Response(`data: ${JSON.stringify(value)}\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

function fixture() {
  const requests: Captured[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response("not found", { status: 404 })
      const body = (await request.json()) as Body
      const adapter = new URL(request.url).pathname.includes("/anthropic/") ? "anthropic" : "google"
      const content = flatten(body)
      const scenario = content.match(new RegExp(`${marker}([a-z0-9_-]+)`, "i"))?.[1]
      const summary = content.includes("Output exactly this Markdown structure")
      requests.push({ adapter, body, scenario, summary })
      const output = summary
        ? [
            "## Objective",
            "- Verify native provider continuation parity.",
            "## Constraints & Decisions",
            "- Preserve adapter semantics.",
            "## Work State",
            "### Done (verified)",
            "- ADAPTER_HANDOFF_CODEWORD",
            "### In progress",
            "- (none)",
            "### Blocked / open",
            "- (none)",
            "### Delegated evidence",
            "- (none)",
            "## Next Move",
            "1. Continue with KEEP_TAIL.",
            "## Key Files & Artifacts",
            "- (none)",
          ].join("\n")
        : "NATIVE_ADAPTER_RESPONSE"
      return adapter === "anthropic" ? anthropicResponse(output, modelIDs.anthropic) : googleResponse(output)
    },
  })
  return {
    server,
    requests,
    async quiet() {
      const state = { count: requests.length, since: Date.now() }
      for (const _ of Array.from({ length: 100 })) {
        await Bun.sleep(20)
        if (state.count !== requests.length) {
          state.count = requests.length
          state.since = Date.now()
          continue
        }
        if (Date.now() - state.since >= 80) return
      }
      throw new Error("Native provider fixture did not become quiet")
    },
  }
}

function config(adapter: Adapter, baseURL: string) {
  const providerID = `wire-${adapter}`
  const modelID = modelIDs[adapter]
  return {
    model: `${providerID}/${modelID}`,
    small_model: `${providerID}/${modelID}`,
    default_agent: "research",
    enabled_providers: [providerID],
    billing: { llm: "byok" as const },
    compaction: { tailTurns: 1, tailTokens: 8_000 },
    provider: {
      [providerID]: {
        name: `${adapter} native wire fixture`,
        npm: adapter === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/google",
        env: [],
        options: { apiKey: "native-local-only", baseURL },
        models: {
          [modelID]: {
            name: `${adapter} native fixture model`,
            tool_call: true,
            limit: { context: 128_000, output: 4_096 },
          },
        },
      },
    },
  }
}

function requestFor(requests: Captured[], adapter: Adapter, scenario: string) {
  const matches = requests.filter((request) => request.adapter === adapter && request.scenario === scenario)
  // Prefer the main tool-bearing request if another internal provider call
  // ever intentionally carries the same scenario marker.
  const result = matches.find((request) => toolNames(adapter, request.body).length > 0) ?? matches[0]
  if (!result) throw new Error(`Missing ${adapter} request for ${scenario}`)
  return result
}

describe("native provider system and continuation boundaries", () => {
  test("Anthropic and Gemini preserve system-only reminders, tool controls, and compacted continuation context", async () => {
    const local = fixture()
    try {
      for (const adapter of adapters) {
        const providerID = `wire-${adapter}`
        const modelID = modelIDs[adapter]
        await using tmp = await tmpdir({
          git: true,
          config: config(adapter, `http://127.0.0.1:${local.server.port}/${adapter}/v1`),
        })
        await Instance.provide({
          directory: tmp.path,
          init: async () => {
            await trustProject()
            await Provider.invalidate()
          },
          fn: async () => {
            const model = { providerID, modelID }
            const disabled = await Session.create({ title: `${adapter} delegation disabled` })
            await SessionPrompt.prompt({
              sessionID: disabled.id,
              model,
              agent: "research",
              effort: "normal",
              delegation: false,
              system: `${marker}disabled-${adapter}`,
              parts: [{ type: "text", text: "Inspect the repository evidence and explain the implementation path." }],
            })

            const explicit = await Session.create({ title: `${adapter} explicit delegation` })
            await SessionPrompt.prompt({
              sessionID: explicit.id,
              model,
              agent: "research",
              effort: "normal",
              delegation: false,
              system: `${marker}explicit-${adapter}`,
              parts: [
                { type: "text", text: "Ask the explicitly attached execution agent to inspect the evidence." },
                { type: "agent", name: "execute" },
              ],
            })

            const context = await Session.create({ title: `${adapter} compaction continuation` })
            await SessionPrompt.prompt({
              sessionID: context.id,
              model,
              agent: "research",
              delegation: false,
              system: `${marker}context-first-${adapter}`,
              parts: [{ type: "text", text: "FIRST_CONTEXT PRECOMPACT_SECRET" }],
            })
            await SessionPrompt.prompt({
              sessionID: context.id,
              model,
              agent: "research",
              delegation: false,
              system: `${marker}context-second-${adapter}`,
              parts: [{ type: "text", text: "SECOND_CONTEXT KEEP_TAIL" }],
            })
            await SessionPrompt.command({
              sessionID: context.id,
              command: "compact",
              arguments: "",
              agent: "research",
              delegation: false,
            })
            await SessionPrompt.prompt({
              sessionID: context.id,
              model,
              agent: "research",
              delegation: false,
              system: `${marker}context-after-${adapter}`,
              parts: [{ type: "text", text: "AFTER_COMPACTION" }],
            })
          },
        })
        await local.quiet()

        for (const scenario of ["disabled", "explicit", "context-first", "context-second", "context-after"]) {
          expect(
            local.requests.filter(
              (request) => request.adapter === adapter && request.scenario === `${scenario}-${adapter}`,
            ),
          ).toHaveLength(1)
        }

        const disabled = requestFor(local.requests, adapter, `disabled-${adapter}`)
        const explicit = requestFor(local.requests, adapter, `explicit-${adapter}`)
        expect(toolNames(adapter, disabled.body)).not.toContain("task")
        expect(toolNames(adapter, explicit.body)).toContain("task")
        expect(toolNames(adapter, disabled.body)).toContain("read")
        expect(toolNames(adapter, explicit.body)).toContain("read")

        for (const request of [disabled, explicit]) {
          expect(userText(adapter, request.body)).not.toContain("Research effort:")
          expect(userText(adapter, request.body)).not.toContain("<system-reminder>")
          expect(systemText(adapter, request.body)).toContain("Research effort: NORMAL")
          expect(systemText(adapter, request.body)).toContain(
            "as many useful workers as available machine capacity permits",
          )
          expect(systemText(adapter, request.body)).not.toContain("<system-reminder>")
        }

        const second = requestFor(local.requests, adapter, `context-second-${adapter}`)
        expect(userText(adapter, second.body)).toContain("FIRST_CONTEXT PRECOMPACT_SECRET")
        expect(userText(adapter, second.body)).toContain("SECOND_CONTEXT KEEP_TAIL")
        expect(userText(adapter, second.body)).not.toContain("Research effort:")
        expect(userText(adapter, second.body)).not.toContain("<system-reminder>")
        expect(systemText(adapter, second.body)).toContain("Research effort: NORMAL")
        expect(systemText(adapter, second.body)).not.toContain("<system-reminder>")
        expect(flatten(second.body)).toContain("NATIVE_ADAPTER_RESPONSE")

        const summary = local.requests.find((request) => request.adapter === adapter && request.summary)
        if (!summary) throw new Error(`Missing ${adapter} compaction request`)
        expect(userText(adapter, summary.body)).toContain("FIRST_CONTEXT PRECOMPACT_SECRET")
        expect(userText(adapter, summary.body)).toContain("Output exactly this Markdown structure")

        const after = requestFor(local.requests, adapter, `context-after-${adapter}`)
        const compacted = userText(adapter, after.body)
        expect(compacted).toContain("SECOND_CONTEXT KEEP_TAIL")
        expect(compacted).toContain("AFTER_COMPACTION")
        expect(flatten(after.body)).toContain("ADAPTER_HANDOFF_CODEWORD")
        expect(compacted).not.toContain("FIRST_CONTEXT PRECOMPACT_SECRET")
        expect(compacted).not.toContain("Research effort:")
        expect(compacted).not.toContain("<system-reminder>")
        expect(systemText(adapter, after.body)).toContain("Research effort: NORMAL")
        expect(systemText(adapter, after.body)).not.toContain("<system-reminder>")
      }
    } finally {
      local.server.stop(true)
    }
  }, 30_000)
})
