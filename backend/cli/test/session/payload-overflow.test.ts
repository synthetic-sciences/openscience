import { describe, expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

const question = "Which search provider are you using: Firecrawl or regular search?"
const followup = "A genuine new request after the terminal provider rejection."
const history = `PRESERVED_OLD_EVIDENCE\n${"Previous research result. ".repeat(3_000)}`.trimEnd()
const handoff = "PAYLOAD_RECOVERY_HANDOFF: Previous research is complete. Answer the user's search-provider question."

function reply(text: string) {
  const chunk = {
    id: "chatcmpl-payload-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: STRESS_PROVIDER_MODEL,
  }
  const events = [
    { ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    {
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    },
  ]
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function fixture(mode: "recover" | "summary-fails" | "resume-fails") {
  const requests: { body: string; summary: boolean; rejected: boolean }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
        return new Response("not found", { status: 404 })
      const body = await request.text()
      // Per-message titles run independently with only the short user text;
      // they are not the oversized conversation request under test.
      if (body.includes("The following is the text to summarize:")) return reply("Fixture message title")
      const summary = body.includes("Output exactly this Markdown structure")
      const current = body.includes(question)
      const fresh = body.includes(followup)
      const rejected = summary
        ? mode === "summary-fails"
        : current && !fresh && (!body.includes("PAYLOAD_RECOVERY_HANDOFF") || mode === "resume-fails")
      requests.push({ body, summary, rejected })
      if (rejected)
        return new Response("<html><body><h1>413 Request Entity Too Large</h1></body></html>", {
          status: 413,
          headers: { "content-type": "text/html" },
        })
      return reply(summary ? handoff : fresh ? "NEW_PROMPT_ANSWER" : current ? "SEARCH_PROVIDER_ANSWER" : history)
    },
  })
  return { server, requests }
}

describe("provider payload overflow recovery", () => {
  test.each(["recover", "summary-fails", "resume-fails"] as const)(
    "%s: bounds HTTP 413 recovery and preserves the actual user request",
    async (mode) => {
      const local = fixture(mode)
      try {
        const base = stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`)
        // Exercise the actual OpenRouter SDK's HTTP error parser against a
        // loopback peer, not a mocked SessionProcessor or provider exception.
        base.provider[STRESS_PROVIDER_ID].npm = "@openrouter/ai-sdk-provider"
        await using tmp = await tmpdir({
          git: true,
          config: { ...base, compaction: { tailTurns: 1, tailTokens: 8_000 } },
        })
        await Instance.provide({
          directory: tmp.path,
          init: async () => {
            await trustProject()
            await Provider.invalidate()
          },
          fn: async () => {
            const session = await Session.create({ title: `HTTP 413 ${mode}` })
            const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }
            await SessionPrompt.prompt({
              sessionID: session.id,
              model,
              agent: "research",
              tools: { "*": false },
              parts: [{ type: "text", text: "Record the previous research results." }],
            })
            const before = local.requests.length
            const result = await SessionPrompt.prompt({
              sessionID: session.id,
              model,
              agent: "research",
              tools: { "*": false },
              parts: [{ type: "text", text: question }],
            })
            const requests = local.requests.slice(before)
            expect(requests.map((request) => [request.summary, request.rejected])).toEqual(
              mode === "summary-fails"
                ? [
                    [false, true],
                    [true, true],
                  ]
                : [
                    [false, true],
                    [true, false],
                    [false, mode === "resume-fails"],
                  ],
            )
            expect(requests[0].body).toContain(question)
            expect(requests[1].body).toContain("PRESERVED_OLD_EVIDENCE")
            const messages = await Session.messages({ sessionID: session.id })
            const current = messages.find((message) =>
              message.parts.some((part) => part.type === "text" && part.text === question),
            )
            expect(current?.info.role).toBe("user")
            expect(
              messages.some((message) => message.parts.some((part) => part.type === "text" && part.text === history)),
            ).toBe(true)
            expect(result.info.role).toBe("assistant")
            if (result.info.role !== "assistant") throw new Error("Expected assistant result")
            if (mode === "recover") {
              expect(result.info.error).toBeUndefined()
              expect(result.parts.some((part) => part.type === "text" && part.text === "SEARCH_PROVIDER_ANSWER")).toBe(
                true,
              )
            } else {
              expect(result.info.parentID).toBe(current!.info.id)
              expect(result.info.error?.data.message).toContain("assembled conversation")
              expect(result.info.error?.data.message).toContain("conversation is preserved")
            }
            if (mode !== "summary-fails") {
              expect(requests[2].body).toContain(question)
              expect(requests[2].body).toContain("PAYLOAD_RECOVERY_HANDOFF")
              expect(requests[2].body).not.toContain("PRESERVED_OLD_EVIDENCE")
              expect(Buffer.byteLength(requests[2].body)).toBeLessThan(Buffer.byteLength(requests[0].body))
            } else {
              const context = await MessageV2.filterCompacted(MessageV2.stream(session.id))
              expect(
                context.some((message) => message.parts.some((part) => part.type === "text" && part.text === history)),
              ).toBe(true)
              expect(
                context.some((message) => message.parts.some((part) => part.type === "text" && part.text === question)),
              ).toBe(true)
            }
            // Re-entering the durable loop must not redispatch a completed or
            // terminal request after a backend restart/reconnect.
            const completed = local.requests.length
            await SessionPrompt.loop(session.id)
            expect(local.requests).toHaveLength(completed)
            if (mode !== "recover") {
              const next = await SessionPrompt.prompt({
                sessionID: session.id,
                model,
                agent: "research",
                tools: { "*": false },
                parts: [{ type: "text", text: followup }],
              })
              expect(local.requests).toHaveLength(completed + 1)
              expect(next.info.role).toBe("assistant")
              if (next.info.role !== "assistant") throw new Error("Expected new prompt response")
              expect(next.info.error).toBeUndefined()
              expect(next.parts.some((part) => part.type === "text" && part.text === "NEW_PROMPT_ANSWER")).toBe(true)
            }
          },
        })
      } finally {
        local.server.stop(true)
      }
    },
    30_000,
  )
})
