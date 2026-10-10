import { expect, test } from "bun:test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { stepCountIs, streamText, tool } from "ai"
import z from "zod"
import { CallLink } from "../../src/provider/call-link"
import { Provider } from "../../src/provider/provider"

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-link",
    object: "chat.completion.chunk",
    created: 1,
    model: "openai/test",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } : {}),
  })}\n\n`
}

const toolStep = () =>
  chunk(
    {
      role: "assistant",
      tool_calls: [{ index: 0, id: "call_tool_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
    },
    null,
  ) +
  chunk({}, "tool_calls") +
  "data: [DONE]\n\n"
const textStep = () => chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop") + "data: [DONE]\n\n"

async function until(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await Bun.sleep(5)
}

// The processor and onStepFinish read a step's identity from that step's own
// response headers. This drives the real AI SDK with the managed fetch wrapper
// and holds back the consumer until the next step's fetch has been sent, the
// order in which shared request state would have named the wrong call.
test("each step reads the call and hold of its own response, even when the next fetch has started", async () => {
  const sent: { call: string; hold: string }[] = []
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const hold = `hold_step${sent.length + 1}`
      sent.push({ call: request.headers.get("x-openscience-call")!, hold })
      return new Response(sent.length === 1 ? toolStep() : textStep(), {
        headers: { "content-type": "text/event-stream", "x-openscience-hold-id": hold },
      })
    },
  })
  const provider = createOpenRouter({
    apiKey: "test-local-only",
    baseURL: `${server.url.origin}/api/v1`,
    fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      Provider.fetchWithIdleWatchdog(fetch, input, init, {
        providerID: "openrouter",
        modelID: "openai/test",
        managed: true,
      })) as typeof fetch,
  })
  const onStep: ({ id: string; hold?: string } | undefined)[] = []
  const context: Provider.RequestContext = { sessionID: "ses_step", messageID: "msg_step", attempt: 1 }
  const finished = await Provider.withRequestContext(context, async () => {
    const result = streamText({
      model: provider.chat("openai/test"),
      prompt: "Use the tool, then answer.",
      tools: { lookup: tool({ description: "fixture", inputSchema: z.object({}), execute: async () => "ok" }) },
      stopWhen: stepCountIs(2),
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(5_000),
      onStepFinish(step) {
        onStep.push(CallLink.fromResponse(step.response?.headers))
      },
    })
    const steps: ({ id: string; hold?: string } | undefined)[] = []
    for await (const part of Provider.withRequestContextIterable(context, result.fullStream)) {
      if (part.type !== "finish-step") continue
      // Lag like a busy consumer: let the SDK send the next step first.
      if (steps.length === 0) {
        await until(() => sent.length === 2, 2_000)
        // The next step was already sent while this step was unread.
        expect(sent).toHaveLength(2)
      }
      steps.push(CallLink.fromResponse(part.response?.headers))
    }
    return steps
  })

  expect(sent).toHaveLength(2)
  expect(sent[0]!.call).not.toBe(sent[1]!.call)
  const expected = sent.map((item) => ({ id: item.call, hold: item.hold }))
  expect(finished).toEqual(expected)
  expect(onStep).toEqual(expected)
})
