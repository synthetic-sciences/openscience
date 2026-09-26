import { describe, expect, test } from "bun:test"
import { HarnessState } from "../../../src/harness/state"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { SessionPrompt } from "../../../src/session/prompt"
import { tmpdir, trustProject } from "../../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../../fixture/stress-provider"

/** A model that sends the same incomplete `bash` call twice, then, told so, delivers. */
function server() {
  const requests: string[] = []
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-repeated",
      object: "chat.completion.chunk",
      created: 1,
      model: STRESS_PROVIDER_MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } : {}),
    })}\n\n`
  const stream = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } })
  const reply = (content: string) =>
    stream(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n")
  let incomplete = 0
  const instance = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: unknown }
      const text = JSON.stringify(body.messages)
      requests.push(text)
      if (!text.includes("Methods and deliverables")) return reply("title")
      if (text.includes("was sent twice and was not executed"))
        return reply("Understood; the result is written to out.txt.")
      if (incomplete < 2) {
        incomplete++
        return stream(
          chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_incomplete_${incomplete}`,
                  type: "function",
                  // `bash` requires `command`; a `description` alone is an incomplete call.
                  function: { name: "bash", arguments: JSON.stringify({ description: "run the analysis" }) },
                },
              ],
            },
            null,
          ) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n",
        )
      }
      return reply("Done without the redirect.")
    },
  })
  return { instance, requests }
}

describe("a repeated incomplete call", () => {
  test("is a guard trip the redirect unit answers, not the end of the run", async () => {
    const fixture = server()
    try {
      await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${fixture.instance.url.origin}/v1`) })
      await Instance.provide({
        directory: tmp.path,
        init: trustProject,
        fn: async () => {
          const session = await Session.create({ workspace: "project" })
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
            agent: "research",
            delegationSettings: { level: "standard", autonomy: "autonomous" },
            parts: [{ type: "text", text: "Run the analysis and write the result to out.txt." }],
          })
          const parts = (await Session.messages({ sessionID: session.id })).flatMap((message) => message.parts)
          const texts = parts
            .filter((part) => part.type === "text")
            .map((part) => (part.type === "text" ? part.text : ""))
          expect(texts.some((text) => text.includes("stopped two repeated incomplete bash calls"))).toBe(true)
          expect(texts.some((text) => text.includes("was sent twice and was not executed"))).toBe(true)
          expect(texts.at(-1)).toContain("the result is written to out.txt")
          expect(HarnessState.get(session.id).guardTrips).toBe(1)
          // The redirect reached the model as the runtime's message.
          expect(fixture.requests.some((text) => text.includes("was sent twice and was not executed"))).toBe(true)
        },
      })
    } finally {
      fixture.instance.stop(true)
    }
  })
})
