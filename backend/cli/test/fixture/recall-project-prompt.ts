import assert from "node:assert/strict"
import path from "node:path"
import { HarnessState } from "../../src/harness/state"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { trustProject } from "./fixture"

type Request = { messages: { role: string; content: unknown }[]; tools?: unknown }

async function run() {
  const directory = process.argv[2]
  const phase = process.argv[3]
  assert(directory && ["record", "idle", "recall"].includes(phase))
  const requests: Request[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Request)
      const calling = phase === "recall" && requests.length <= 2
      const lastResult = requests
        .at(-1)
        ?.messages.filter((message) => message.role === "tool")
        .at(-1)
      const cursor = /nextCursor: ([a-f\d-]{36})/.exec(JSON.stringify(lastResult?.content ?? ""))?.[1]
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-recall",
          object: "chat.completion.chunk",
          created: 1,
          model: "recall-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } : {}),
        })}\n\n`
      const delta = calling
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_project_recall_${requests.length}`,
                type: "function",
                function: {
                  name: "recall",
                  arguments: JSON.stringify({
                    scope: "project",
                    pattern: "codename|dataset",
                    limit: requests.length === 1 ? 1 : 20,
                    cursor,
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: "Acknowledged." }
      return new Response(chunk(delta, null) + chunk({}, calling ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  try {
    await Bun.write(
      path.join(directory, "openscience.json"),
      JSON.stringify({
        model: "memory/recall-model",
        small_model: "memory/recall-model",
        default_agent: "research",
        agent: { title: { disable: true } },
        enabled_providers: ["memory"],
        billing: { llm: "byok" },
        provider: {
          memory: {
            name: "Recall fixture",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { apiKey: "local-only", baseURL: `http://127.0.0.1:${server.port}/v1` },
            models: {
              "recall-model": { name: "Recall fixture", tool_call: true, limit: { context: 128_000, output: 4096 } },
            },
          },
        },
      }),
    )
    await Instance.provide({
      directory,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: phase })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: "memory", modelID: "recall-model" },
          agent: "research",
          parts: [
            {
              type: "text",
              text:
                phase === "record"
                  ? "The project codename is ORION-9 and the dataset is VisDrone."
                  : phase === "recall"
                    ? "Find the codename and dataset from our earlier conversation."
                    : "Hello.",
            },
          ],
        })
        assert.equal(requests.length, phase === "recall" ? 3 : 1)
        const prefix = (request: Request) => ({
          system: request.messages.filter((message) => message.role === "system"),
          tools: request.tools,
        })
        const baseline = Bun.file(path.join(directory, "captured-prefix.json"))
        if (phase === "record") await Bun.write(baseline, JSON.stringify(prefix(requests[0])))
        else {
          const expected = await baseline.text()
          for (const request of requests) assert.equal(JSON.stringify(prefix(request)), expected)
          const first = JSON.stringify(requests[0].messages)
          assert(!first.includes("ORION-9") && !first.includes("VisDrone"))
        }
        for (const request of requests) {
          const system = JSON.stringify(prefix(request).system)
          assert(!system.includes("ORION-9") && !system.includes("VisDrone"))
        }
        const history = await Session.messages({ sessionID: session.id })
        const calls = history.flatMap((message) => message.parts).filter((part) => part.type === "tool")
        if (phase === "recall") {
          const output = JSON.stringify(requests[1].messages.filter((message) => message.role === "tool"))
          assert(output.includes("ORION-9") && output.includes("VisDrone"))
          assert(output.includes("Stopped at the match limit"))
          const more = JSON.stringify(requests[2].messages.filter((message) => message.role === "tool").at(-1)?.content)
          assert(more.includes("Searched") && more.includes("of"))
          assert(!more.includes("nextCursor:") && more.includes("VisDrone"))
          assert.equal(calls.length, 2)
          assert.equal(calls[1].state.status, "completed")
          if (calls[1].state.status === "completed") assert.equal(typeof calls[1].state.input.cursor, "string")
          assert.equal(calls[0].tool, "recall")
          assert.equal(calls[0].state.status, "completed")
        } else assert.equal(calls.length, 0)
        await Instance.dispose()
      },
    })
  } finally {
    server.stop(true)
    HarnessState.reset()
  }
  console.log(`recall-project:${phase}:ok`)
}

// Separate runtimes prove durable retrieval and release native DB handles
// before the parent removes its temporary data root.
run().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
