import { expect, test } from "bun:test"
import path from "node:path"
import { createOpenScienceRuntime } from "@synsci/sdk/v2"
import { Instance } from "../../src/project/instance"
import { ProjectAccess } from "../../src/project/access"
import { Provider } from "../../src/provider/provider"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionProcessor } from "../../src/session/processor"
import { CommandRuntime } from "../../src/science/command/registry"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }

function chunk(delta: unknown, finish: string | null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-delegation",
    object: "chat.completion.chunk",
    created: 1,
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
  })}\n\n`
}

function reply(tool?: { name: string; args: unknown; id: string }) {
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: tool.id,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.args) },
          },
        ],
      }
    : { role: "assistant", content: "FIXTURE_COMPLETE" }
  return new Response(chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Delegation fixture did not reach the expected state")
    await Bun.sleep(10)
  }
}

for (const cancellation of ["runtime", "session", "runtime-shell"] as const) {
  test(`public ${cancellation} cancellation reaches a live child and its progress is visible before completion`, async () => {
    let childRequests = 0
    let childStopped = false
    let file = ""
    using provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { tools?: Array<{ function?: { name?: string } }> }
        if (body.tools?.some((tool) => tool.function?.name === "task")) {
          return reply({
            name: "task",
            id: "call_delegate",
            args: {
              description: "Read the fixture",
              prompt: `Read ${file}, then report.`,
              subagent_type: cancellation === "runtime-shell" ? "data" : "explore",
              session_id: null,
            },
          })
        }
        if (!body.tools?.length) return reply()
        childRequests++
        if (childRequests === 1 && cancellation === "runtime-shell") {
          return reply({
            name: "bash",
            id: "call_child_shell",
            args: { command: "echo CHILD_PROCESS_READY; sleep 30", description: "Cancellable local shell fixture" },
          })
        }
        if (childRequests === 1) return reply({ name: "read", id: "call_child_read", args: { filePath: file } })
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(chunk({ role: "assistant", content: "Child still working." }, null)),
              )
            },
            cancel() {
              childStopped = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    await using tmp = await tmpdir({
      git: true,
      config: { ...stressProviderConfig(`${provider.url.origin}/v1`), permission: { "*": "allow" } },
    })
    file = path.join(tmp.path, "evidence.txt")
    await Bun.write(file, "Observed fixture evidence.")
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await ProjectAccess.update(Instance.project, { mode: "full", root: tmp.path })
        await Provider.invalidate()
      },
      fn: async () => {
        const parent = await Session.create({
          title: "Delegation cancellation fixture",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        using api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => Server.App().fetch(request) })
        const runtime = createOpenScienceRuntime({ baseUrl: api.url.origin, directory: tmp.path })
        const accepted = await runtime.prompt({
          sessionID: parent.id,
          requestID: "delegate",
          model,
          effort: "normal",
          delegation: true,
          parts: [
            { type: "text", text: "Delegate this bounded inspection." },
            { type: "agent", name: cancellation === "runtime-shell" ? "data" : "explore" },
          ],
        })
        try {
          await until(() => childRequests >= (cancellation === "runtime-shell" ? 1 : 2))
          const children = await Session.children(parent.id)
          expect(children).toHaveLength(1)
          expect(SessionPrompt.activeController(children[0]!.id)?.aborted).toBe(false)
          await until(async () =>
            (await Session.messages({ sessionID: parent.id }))
              .flatMap((message) => message.parts)
              .some(
                (part) =>
                  part.type === "tool" &&
                  part.tool === "task" &&
                  part.state.status === "running" &&
                  part.state.metadata?.summary?.some(
                    (item: { tool: string; state: { status: string } }) =>
                      item.tool === (cancellation === "runtime-shell" ? "bash" : "read") &&
                      item.state.status === (cancellation === "runtime-shell" ? "running" : "completed"),
                  ),
              ),
          )
          if (cancellation === "runtime-shell") {
            await until(async () =>
              (await Session.messages({ sessionID: children[0]!.id }))
                .flatMap((message) => message.parts)
                .some(
                  (part) =>
                    part.type === "tool" &&
                    part.tool === "bash" &&
                    part.state.status === "running" &&
                    String(part.state.metadata?.output).includes("CHILD_PROCESS_READY"),
                ),
            )
            expect(CommandRuntime.list(parent.projectID, children[0]!.id)).toHaveLength(1)
          }
          expect(childStopped).toBe(false)
          if (cancellation !== "session") await runtime.cancel({ sessionID: parent.id, runID: accepted.runID })
          else {
            const response = await fetch(
              `${api.url.origin}/session/${parent.id}/abort?directory=${encodeURIComponent(tmp.path)}`,
              { method: "POST" },
            )
            expect(response.ok).toBe(true)
          }
          expect(
            (
              await runtime.wait({
                sessionID: parent.id,
                runID: accepted.runID,
                intervalMs: 10,
                signal: AbortSignal.timeout(10_000),
              })
            ).state,
          ).toBe("cancelled")
          await until(
            () =>
              (cancellation === "runtime-shell"
                ? CommandRuntime.list(parent.projectID, children[0]!.id).length === 0
                : childStopped) && !SessionPrompt.activeController(children[0]!.id),
          )
          expect(childRequests).toBe(cancellation === "runtime-shell" ? 1 : 2)
          const childMessages = await Session.messages({ sessionID: children[0]!.id })
          expect(
            childMessages
              .flatMap((message) => message.parts)
              .some(
                (part) =>
                  part.type === "tool" &&
                  part.tool === (cancellation === "runtime-shell" ? "bash" : "read") &&
                  (part.state.status === "completed" ||
                    (cancellation === "runtime-shell" && part.state.status === "error")),
              ),
          ).toBe(true)
        } catch (error) {
          for (const session of [parent, ...(await Session.children(parent.id))]) {
            console.error(
              JSON.stringify({
                sessionID: session.id,
                childRequests,
                tools: (await Session.messages({ sessionID: session.id }))
                  .flatMap((message) => message.parts)
                  .filter((part) => part.type === "tool"),
              }),
            )
          }
          throw error
        } finally {
          SessionPrompt.cancel(parent.id)
          for (const child of await Session.children(parent.id)) SessionPrompt.cancel(child.id)
        }
      },
    })
  }, 30_000)
}

test("serial task failures get one redirect after the third error instead of a stop", async () => {
  let requests = 0
  using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { tools?: Array<{ function?: { name?: string } }> }
      if (!body.tools?.some((tool) => tool.function?.name === "task")) return reply()
      requests++
      if (requests > 5) return reply()
      return reply({
        name: "task",
        id: `call_invalid_${requests}`,
        args: {
          description: `Inspect source ${requests}`,
          prompt: `Inspect branch ${requests}`,
          subagent_type: "explore",
          session_id: `ses_invented_${requests}`,
        },
      })
    },
  })
  await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${provider.url.origin}/v1`) })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      const session = await Session.create({ title: "Error guard fixture" })
      await SessionPrompt.controlled({
        sessionID: session.id,
        model,
        agent: "research",
        effort: "normal",
        delegation: true,
        parts: [
          { type: "text", text: "Delegate inspection." },
          { type: "agent", name: "explore" },
        ],
      })
      const parts = (await Session.messages({ sessionID: session.id })).flatMap((message) => message.parts)
      const errors = parts.filter(
        (part) => part.type === "tool" && part.tool === "task" && part.state.status === "error",
      )
      // Three same-cause failures trip the guard; the redirect unit turns the
      // first trip into a strategy-change message instead of a stop, so the
      // model gets two more calls before it changes approach on its own.
      expect(requests).toBe(6)
      expect(errors).toHaveLength(5)
      expect(await Session.children(session.id)).toHaveLength(0)
      expect(
        parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("Diagnose the root cause")),
      ).toBe(true)
      expect(
        parts.some((part) => part.type === "text" && part.text.includes(SessionProcessor.toolErrorStopMessage("task"))),
      ).toBe(false)
    },
  })
}, 30_000)
