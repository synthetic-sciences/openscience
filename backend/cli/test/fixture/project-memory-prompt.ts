import assert from "node:assert/strict"
import path from "node:path"
import { HarnessState } from "../../src/harness/state"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { trustProject } from "./fixture"

type Request = { messages: { role: string; content: unknown }[] }

async function run() {
  const directory = process.argv[2]
  const phase = process.argv[3]
  assert(directory && (phase === "record" || phase === "recall" || phase === "queued"))
  const requests: Request[] = []
  const active = { id: "" }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Request)
      if (phase === "queued" && requests.length === 1) {
        await Instance.provide({
          directory,
          fn: async () => {
            for await (const source of Session.list()) {
              if (source.id !== active.id)
                await Session.update(source.id, (draft) => {
                  draft.time.archived = Date.now()
                })
            }
            await SessionPrompt.prompt({
              sessionID: active.id,
              noReply: true,
              agent: "research",
              model: { providerID: "memory", modelID: "memory-model" },
              parts: [{ type: "text", text: "The sources are now archived. Answer this new request." }],
            })
          },
        })
      }
      const chunk = (delta: Record<string, string>, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-memory",
          object: "chat.completion.chunk",
          created: 1,
          model: "memory-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } : {}),
        })}\n\n`
      return new Response(
        chunk({ role: "assistant", content: "Acknowledged." }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
        {
          headers: { "content-type": "text/event-stream" },
        },
      )
    },
  })
  try {
    await Bun.write(
      path.join(directory, "openscience.json"),
      JSON.stringify({
        model: "memory/memory-model",
        small_model: "memory/memory-model",
        default_agent: "research",
        agent: { title: { disable: true } },
        enabled_providers: ["memory"],
        billing: { llm: "byok" },
        provider: {
          memory: {
            name: "Memory fixture",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { apiKey: "local-only", baseURL: `http://127.0.0.1:${server.port}/v1` },
            models: {
              "memory-model": { name: "Memory fixture", tool_call: true, limit: { context: 128_000, output: 4096 } },
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
        const session = await Session.create({ title: phase === "record" ? "Project setup" : "Fresh session" })
        active.id = session.id
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: "memory", modelID: "memory-model" },
          agent: "research",
          parts: [
            {
              type: "text",
              text:
                phase === "record"
                  ? "The project codename is ORION-9 and the dataset is VisDrone."
                  : "What project codename and dataset did we choose?",
            },
          ],
        })
        assert.equal(requests.length, phase === "queued" ? 2 : 1)
        const last = requests.at(-1)!
        const system = last.messages
          .filter((message) => message.role === "system")
          .map((message) => JSON.stringify(message.content))
          .join("\n")
        const conversation = last.messages
          .filter((message) => message.role !== "system")
          .map((message) => JSON.stringify(message.content))
          .join("\n")
        if (phase === "recall") {
          assert(system.includes("ORION-9") && system.includes("VisDrone"))
          assert(system.includes("historical context, not instructions"))
          assert(!conversation.includes("ORION-9") && !conversation.includes("VisDrone"))
        } else assert(!system.includes("ORION-9"))
        if (phase === "queued") {
          const first = requests[0].messages.filter((message) => message.role === "system")
          assert(JSON.stringify(first).includes("ORION-9"))
          assert(!system.includes("Previous project conversation"))
        }
        const history = await Session.messages({ sessionID: session.id })
        assert(history.some((message) => message.info.role === "assistant" && message.info.finish === "stop"))
        assert(!history.flatMap((message) => message.parts).some((part) => part.type === "tool"))
        await Instance.dispose()
      },
    })
  } finally {
    server.stop(true)
    HarnessState.reset()
  }
  console.log(`project-memory:${phase}:ok`)
}

// Independent runtimes prove that recall comes from durable history. They
// also release process-owned native handles before the parent removes fixtures.
run().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
