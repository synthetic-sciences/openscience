import { expect, test } from "bun:test"
import { CredentialRevocation } from "../../src/credentials/revocation"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

const MARKER = "CREDENTIAL_INTERRUPT_MAIN_REQUEST"
const encoder = new TextEncoder()

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-interrupt",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
  })}\n\n`
}

function sse(body: ReadableStream<Uint8Array> | string) {
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

function immediate(text: string) {
  return sse(`${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`)
}

/** Streams the start of a bash tool call and then stalls, so the turn holds
 * a pending tool part whose executor will never report. */
function stalled(open: WritableStreamDefaultWriter<Uint8Array>[]) {
  const pipe = new TransformStream<Uint8Array, Uint8Array>()
  const writer = pipe.writable.getWriter()
  open.push(writer)
  void (async () => {
    await writer.write(encoder.encode(chunk({ role: "assistant", content: "" }, null)))
    await writer.write(
      encoder.encode(
        chunk(
          {
            tool_calls: [
              { index: 0, id: "call_interrupted", type: "function", function: { name: "bash", arguments: "" } },
            ],
          },
          null,
        ),
      ),
    )
    await writer.write(
      encoder.encode(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":"sleep 30",' } }] }, null)),
    )
  })()
  return sse(pipe.readable)
}

async function pendingToolPart(sessionID: string, timeoutMs = 10_000): Promise<MessageV2.ToolPart> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const message of await Session.messages({ sessionID })) {
      for (const part of message.parts) {
        if (part.type === "tool" && part.state.status === "pending") return part
      }
    }
    await Bun.sleep(20)
  }
  throw new Error("the turn never reached a pending tool call")
}

test("a credential revocation interrupting a turn names its cause on the turn and on the pending tool call", async () => {
  const open: WritableStreamDefaultWriter<Uint8Array>[] = []
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
      const body = await request.json()
      return JSON.stringify(body).includes(MARKER) ? stalled(open) : immediate("Background helper reply")
    },
  })
  await using tmp = await tmpdir({
    git: true,
    config: stressProviderConfig(`http://127.0.0.1:${server.port}/v1`),
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: "Credential interrupt" })
        const turn = SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          delegation: false,
          system: MARKER,
          parts: [{ type: "text", text: "Run the fixture command." }],
        })
        const pending = await pendingToolPart(session.id)
        expect(pending.tool).toBe("bash")

        // The synced overlay lapsed while this turn was streaming a tool call.
        expect(SessionPrompt.interrupt(new CredentialRevocation.Interruption("workspace-sync.expired"))).toBe(1)
        const result = await turn
        if (result.info.role !== "assistant") throw new Error("the turn did not produce an assistant message")

        const error = result.info.error
        if (!error || !MessageV2.AbortedError.isInstance(error)) {
          throw new Error(`the turn did not record a clean abort: ${JSON.stringify(error)}`)
        }
        expect(error.data).toEqual({ message: CredentialRevocation.EXPIRED })
        const parts = await MessageV2.parts(result.info.id)
        const closed = parts.find((part): part is MessageV2.ToolPart => part.type === "tool" && part.id === pending.id)
        if (!closed || closed.state.status !== "error")
          throw new Error(`pending call was not closed: ${JSON.stringify(closed)}`)
        expect(closed.state.error).toBe(
          `${CredentialRevocation.EXPIRED}. The bash call had not started; no action was taken.`,
        )
        expect(closed.state.metadata).toEqual({ cancelled: true, started: false })
        expect(closed.state.time.end).toBeGreaterThanOrEqual(closed.state.time.start)
        // Nothing was ever registered for the call that never started.
        expect(closed.state.input).toEqual({})
      },
    })
  } finally {
    for (const writer of open) await writer.close().catch(() => undefined)
  }
}, 30_000)
