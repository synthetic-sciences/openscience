import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

/** An OpenAI-compatible provider that answers every request with the same
 *  tool call until `calls` have gone out, then with text. */
function repeatingProvider(calls: number, tool: string, args: Record<string, unknown>) {
  let issued = 0
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-gate",
      object: "chat.completion.chunk",
      created: 1,
      model: STRESS_PROVIDER_MODEL,
      choices: [{ index: 0, delta: finish ? {} : delta, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } : {}),
    })}\n\n`
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      // Title and summary requests share the endpoint; only a request that
      // offers the tool is the research turn.
      const offered = await request
        .json()
        .then((body: { tools?: Array<{ function?: { name?: string } }> }) =>
          (body.tools ?? []).some((item) => item.function?.name === tool),
        )
        .catch(() => false)
      const body =
        offered && issued < calls
          ? [
              chunk({ role: "assistant", content: "" }, null),
              chunk(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_gate_${++issued}`,
                      type: "function",
                      function: { name: tool, arguments: JSON.stringify(args) },
                    },
                  ],
                },
                null,
              ),
              chunk({}, "tool_calls"),
            ]
          : [chunk({ role: "assistant", content: "done" }, null), chunk({}, "stop")]
      return new Response(`${body.join("")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return { server, issued: () => issued }
}

test("a third identical tool call is stopped before it runs, not after", async () => {
  const provider = repeatingProvider(3, "glob", { pattern: "*.md" })
  try {
    await using tmp = await tmpdir({
      git: true,
      config: {
        ...stressProviderConfig(`http://127.0.0.1:${provider.server.port}/v1`),
        // The doom-loop prompt is answered by policy so the run cannot hang.
        permission: { doom_loop: "deny" },
      },
    })
    await Bun.write(`${tmp.path}/README.md`, "# fixture\n")
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: "doom loop gate" })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          delegation: false,
          parts: [{ type: "text", text: "List the markdown files, repeatedly." }],
        }).catch(() => undefined)

        const messages = await Session.messages({ sessionID: session.id })
        const calls = messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool" && part.tool === "glob")
          .map((part) => (part.type === "tool" ? part.state : undefined))
        // The SDK starts execute() as soon as it parses a call; the guard used
        // to run from the stream position, after the tool had already run.
        expect(calls.map((state) => state?.status)).toEqual(["completed", "completed", "error"])
        const denied = calls[2]
        expect(denied?.status === "error" ? denied.error : "").toContain("doom_loop")
        expect(denied?.status === "error" ? "output" in denied : false).toBe(false)
      },
    })
  } finally {
    provider.server.stop(true)
  }
}, 60_000)
