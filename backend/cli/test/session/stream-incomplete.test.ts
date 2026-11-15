import { describe, expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

const marker = "STREAM_INCOMPLETE_MAIN_REQUEST"

function chunk(delta: Record<string, unknown>, finish: string | null = null, usage = false) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-incomplete",
    object: "chat.completion.chunk",
    created: 1,
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
  })}\n\n`
}
const complete = (text: string) =>
  `${chunk({ role: "assistant", content: text })}${chunk({}, "stop", true)}data: [DONE]\n\n`

describe("incompleteStep", () => {
  test.each([
    ["unknown", undefined, true],
    ["other", { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined }, true],
    ["other", { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, true],
    ["unknown", { inputTokens: 12, outputTokens: 3, totalTokens: 15 }, false],
    ["stop", undefined, false],
    ["length", undefined, false],
    ["tool-calls", undefined, false],
    ["error", undefined, false],
  ] as const)("finish %s with usage %j -> %s", (finishReason, usage, expected) => {
    expect(SessionProcessor.incompleteStep({ finishReason, usage: usage as never })).toBe(expected)
  })

  test("a cut-off reply is resubmitted only when nothing reached the page", () => {
    const error = SessionProcessor.incompleteError(new SessionProcessor.StreamIncompleteError())!
    expect(error.data).toMatchObject({ isRetryable: false, metadata: { code: "provider_stream_incomplete" } })
    expect(SessionRetry.resubmittable(error, { output: false })).toBe(true)
    expect(SessionRetry.resubmittable(error, { output: true })).toBe(false)
    expect(SessionProcessor.incompleteError(new Error("other"))).toBeUndefined()
  })
})

async function run(main: (request: number) => string, requireStreamCompletion = true) {
  let requests = 0
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json()
      if (!JSON.stringify(body).includes(marker))
        return new Response(complete("Helper title"), { headers: { "content-type": "text/event-stream" } })
      requests++
      return new Response(main(requests), { headers: { "content-type": "text/event-stream" } })
    },
  })
  const base = stressProviderConfig(`http://127.0.0.1:${server.port}/v1`)
  // The fixture is a direct (non-Ace) provider: the check applies only when
  // it opts in, as Ace-managed calls always do.
  const config = requireStreamCompletion
    ? {
        ...base,
        provider: {
          ...base.provider,
          [STRESS_PROVIDER_ID]: {
            ...base.provider[STRESS_PROVIDER_ID],
            options: { ...base.provider[STRESS_PROVIDER_ID].options, requireStreamCompletion: true },
          },
        },
      }
    : base
  await using tmp = await tmpdir({ git: true, config })
  let outcome!: Awaited<ReturnType<typeof SessionPrompt.prompt>>
  let texts: string[] = []
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      const session = await Session.create({ title: "Stream incomplete" })
      outcome = await SessionPrompt.prompt({
        sessionID: session.id,
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
        agent: "research",
        delegation: false,
        system: marker,
        parts: [{ type: "text", text: "Answer once." }],
      })
      texts = (await Session.messages({ sessionID: session.id }))
        .filter((message) => message.info.id === outcome.info.id)
        .flatMap((message) => message.parts)
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
      await Instance.dispose()
    },
  })
  return { requests, outcome, texts }
}

test("a reply cut off after output keeps the partial answer and is reported, not resent", async () => {
  // Text arrives, then the stream ends with no finish reason and no usage.
  const { requests, outcome, texts } = await run(
    () => `${chunk({ role: "assistant", content: "Partial answer." })}data: [DONE]\n\n`,
  )
  expect(requests).toBe(1)
  expect(texts.join("")).toContain("Partial answer.")
  expect(outcome.info).toMatchObject({
    role: "assistant",
    error: { name: "APIError", data: { isRetryable: false, metadata: { code: "provider_stream_incomplete" } } },
  })
})

test("a reply cut off before any output is resubmitted once and the new answer is used", async () => {
  const { requests, outcome, texts } = await run((request) =>
    request === 1 ? `${chunk({ role: "assistant" })}data: [DONE]\n\n` : complete("Complete answer."),
  )
  expect(requests).toBe(2)
  expect(texts.join("")).toContain("Complete answer.")
  expect(outcome.info.role === "assistant" && outcome.info.error).toBeFalsy()
})

test("a complete reply is untouched", async () => {
  const { requests, outcome, texts } = await run(() => complete("Whole answer."))
  expect(requests).toBe(1)
  expect(texts.join("")).toContain("Whole answer.")
  expect(outcome.info.role === "assistant" && outcome.info.error).toBeFalsy()
})

test("a provider without requireStreamCompletion is never flagged (local servers may omit the final event)", async () => {
  const { requests, outcome, texts } = await run(
    () => `${chunk({ role: "assistant", content: "Complete answer from a lenient server." })}data: [DONE]\n\n`,
    false,
  )
  expect(requests).toBe(1)
  expect(texts.join("")).toContain("Complete answer from a lenient server.")
  expect(outcome.info.role === "assistant" && outcome.info.error).toBeFalsy()
})
