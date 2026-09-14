import { afterEach, expect, test } from "bun:test"
import { HarnessState } from "../../src/harness/state"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

afterEach(() => HarnessState.reset())

/** A model whose whole step (thought, then one tool call) arrives in a single
 * response body, so the SDK parses and executes the call while the consumer
 * is still recording the step's opening events. */
function server() {
  const bodies: Array<Array<Record<string, unknown>>> = []
  let step = 0
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-order",
      object: "chat.completion.chunk",
      created: 1,
      model: STRESS_PROVIDER_MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } : {}),
    })}\n\n`
  const instance = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: Array<Record<string, unknown>> }
      const research = JSON.stringify(body.messages).includes("Methods and deliverables")
      if (!research) {
        return new Response(
          chunk({ role: "assistant", content: "title" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      bodies.push(body.messages)
      step += 1
      if (step === 1) {
        return new Response(
          chunk({ role: "assistant", reasoning_content: "I will run one command." }, null) +
            chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_order",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({ command: "echo ordered", description: "Echo" }),
                    },
                  },
                ],
              },
              null,
            ) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return new Response(
        chunk({ role: "assistant", content: "Done." }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return { instance, bodies }
}

test("a call the SDK executes before the consumer records it still sorts after the thought that produced it", async () => {
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
          parts: [{ type: "text", text: "Run one echo command." }],
        })
        const messages = await Session.messages({ sessionID: session.id })
        const first = messages.find((message) => message.info.role === "assistant")
        const order = first!.parts.map((part) => part.type)
        // Stored order is id order, which is what every later request replays.
        expect(order.indexOf("step-start")).toBeLessThan(order.indexOf("reasoning"))
        expect(order.indexOf("reasoning")).toBeLessThan(order.indexOf("tool"))
        // The second request replays the thought inside the message that
        // carries its tool call, not as a stray assistant message after the
        // tool result.
        const replay = fixture.bodies[1]!
        const assistant = replay.filter((message) => message.role === "assistant")
        expect(assistant).toHaveLength(1)
        expect(replay.findIndex((message) => message.role === "assistant")).toBeLessThan(
          replay.findIndex((message) => message.role === "tool"),
        )
      },
    })
  } finally {
    fixture.instance.stop(true)
  }
})
