import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

test.each(["provider-executed", "cancelled", "interrupted", "legacy-interrupted", "max-steps", "error"])(
  "resuming a %s tool turn does not send another provider request",
  async (mode) => {
    let requests = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        return Response.json(
          { error: { message: "Unexpected continuation", type: "invalid_request_error" } },
          { status: 400 },
        )
      },
    })
    await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${server.url.origin}/v1`) })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: "Stopped tool turn" })
        const user = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "research",
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          noReply: true,
          parts: [{ type: "text", text: "Inspect the saved result." }],
        })
        const assistant: MessageV2.Assistant = {
          id: await MessageV2.nextMessageID(session.id),
          sessionID: session.id,
          parentID: user.info.id,
          role: "assistant",
          agent: "research",
          mode: "research",
          providerID: STRESS_PROVIDER_ID,
          modelID: STRESS_PROVIDER_MODEL,
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, completed: 2 },
          finish: mode === "max-steps" ? "max-steps" : "stop",
          ...(mode === "error"
            ? {
                error: new MessageV2.APIError({
                  message: "Provider failed after execution",
                  isRetryable: false,
                }).toObject(),
              }
            : {}),
        }
        await Session.updateMessage(assistant)
        const failed = ["cancelled", "interrupted", "legacy-interrupted"].includes(mode)
        const part: MessageV2.ToolPart = {
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          tool: "fixture",
          callID: "call_saved",
          ...(mode === "provider-executed" ? { metadata: { providerExecuted: true } } : {}),
          state: failed
            ? {
                status: "error",
                input: {},
                error:
                  mode === "legacy-interrupted"
                    ? "Tool execution was interrupted before completion. Its side effects may have completed; inspect the current state before retrying."
                    : "Tool execution aborted",
                metadata: mode === "legacy-interrupted" ? {} : { [mode]: true },
                time: { start: 1, end: 2 },
              }
            : {
                status: "completed",
                input: {},
                output: "Saved result",
                title: "Fixture",
                metadata: {},
                time: { start: 1, end: 2 },
              },
        }
        await Session.updatePart(part)

        const result = await SessionPrompt.loop(session.id)
        expect(requests).toBe(0)
        expect(result.info).toMatchObject({ id: assistant.id, finish: assistant.finish })
        expect(result.parts.find((entry) => entry.id === part.id)).toEqual(part)
        expect(SessionStatus.get(session.id)).toEqual({ type: "idle" })
      },
    })
  },
)
