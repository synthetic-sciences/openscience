import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { Fusion } from "../../src/session/fusion"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import {
  STRESS_PROVIDER_COMPACT_MODEL,
  STRESS_PROVIDER_ID,
  STRESS_PROVIDER_MODEL,
  stressProviderConfig,
} from "../fixture/stress-provider"

type Body = { model?: string; tools?: Array<{ function?: { name?: string } }>; messages?: unknown }

function chunk(model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fusion",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } } : {}),
  })}\n\n`
}

const sse = (body: string) =>
  new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })

/**
 * The lead (STRESS_PROVIDER_MODEL) hands off twice to an execute worker in one
 * turn, then answers. The worker (STRESS_PROVIDER_COMPACT_MODEL) replies to
 * every assignment with a status line. Requests are told apart by the model
 * they name and by whether the `task` tool is offered.
 */
function fusionProvider(handoffs: number, options: { explicitContinuation?: boolean } = {}) {
  const seen = { lead: 0, worker: 0, workerModels: new Set<string>(), workerPrompts: [] as string[] }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Body
      const tools = (body.tools ?? []).map((tool) => tool.function?.name)
      const model = body.model ?? STRESS_PROVIDER_MODEL
      if (!tools.length)
        return sse(`${chunk(model, { role: "assistant", content: "Title" })}${chunk(model, {}, "stop")}`)
      if (!tools.includes("task")) {
        seen.worker++
        seen.workerModels.add(model)
        seen.workerPrompts.push(JSON.stringify(body.messages))
        return sse(
          `${chunk(model, { role: "assistant", content: `Status: completed\nHandoff ${seen.worker} done by ${model}.` })}${chunk(model, {}, "stop")}`,
        )
      }
      seen.lead++
      if (seen.lead <= handoffs) {
        // A lead that remembers the worker id names it explicitly; that must
        // still count as a Fusion handoff on the bound worker.
        const previous = options.explicitContinuation
          ? /Task session (ses_[A-Za-z0-9]+):/.exec(JSON.stringify(body.messages))?.[1]
          : undefined
        return sse(
          `${chunk(model, { role: "assistant", content: "" })}${chunk(
            model,
            {
              tool_calls: [
                {
                  index: 0,
                  id: `call_fusion_${seen.lead}`,
                  type: "function",
                  function: {
                    name: "task",
                    arguments: JSON.stringify({
                      description: `Handoff ${seen.lead}`,
                      prompt: `Assignment ${seen.lead}: report the status line only.`,
                      subagent_type: "execute",
                      ...(previous ? { session_id: previous } : {}),
                    }),
                  },
                },
              ],
            },
            null,
          )}${chunk(model, {}, "tool_calls")}`,
        )
      }
      return sse(
        `${chunk(model, { role: "assistant", content: "Both handoffs reviewed." })}${chunk(model, {}, "stop")}`,
      )
    },
  })
  return { server, seen }
}

const worker = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_COMPACT_MODEL }

async function runTurn(
  strategy: "fusion" | "parallel",
  handoffs: number,
  options: { explicitContinuation?: boolean } = {},
) {
  const provider = fusionProvider(handoffs, options)
  try {
    await using tmp = await tmpdir({
      git: true,
      config: stressProviderConfig(`http://127.0.0.1:${provider.server.port}/v1`),
    })
    return await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: `fusion ${strategy}` })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          delegationSettings: { level: "standard", autonomy: "balanced", strategy, workerModel: worker },
          parts: [{ type: "text", text: "Reproduce the figure, then check the numbers." }],
        })
        const children = await Session.children(session.id)
        const messages = await Session.messages({ sessionID: session.id })
        const tasks = messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool" && part.tool === "task")
          .map((part) => (part.type === "tool" && part.state.status === "completed" ? part.state : undefined))
        const binding = await Fusion.get(session.id)
        return { session, children, tasks, binding, seen: provider.seen }
      },
    })
  } finally {
    provider.server.stop(true)
  }
}

test("Fusion resumes one persistent worker on the configured model for every execute handoff", async () => {
  const run = await runTurn("fusion", 2)
  expect(run.seen.lead).toBe(3)
  expect(run.seen.worker).toBe(2)
  // The worker ran on the configured worker model, never the lead's.
  expect([...run.seen.workerModels]).toEqual([STRESS_PROVIDER_COMPACT_MODEL])
  // One child for both handoffs; the second one saw the first assignment in its history.
  expect(run.children).toHaveLength(1)
  expect(run.seen.workerPrompts[1]).toContain("Assignment 1")
  expect(run.seen.workerPrompts[1]).toContain("Assignment 2")
  expect(run.tasks).toHaveLength(2)
  for (const state of run.tasks) {
    expect(state?.metadata.sessionId).toBe(run.children[0].id)
    expect(state?.metadata.model).toEqual(worker)
    expect(state?.output).toContain("Status: completed")
  }
  expect((run.tasks[0]?.metadata.fusion as { handoff: number }).handoff).toBe(1)
  expect((run.tasks[1]?.metadata.fusion as { handoff: number }).handoff).toBe(2)
  // The durable binding names the worker and accounts for both handoffs.
  expect(run.binding).toMatchObject({
    workerSessionID: run.children[0].id,
    worker,
    generation: 1,
    handoffs: 2,
    turn: { handoffs: 2 },
  })
  expect(run.binding?.usage.tokens.input).toBe(80)
  expect(run.binding?.lastResult).toMatchObject({ callID: "call_fusion_2", outcome: "completed" })
}, 60_000)

test("ordinary parallel delegation is unchanged: each handoff spawns its own child and no binding exists", async () => {
  const run = await runTurn("parallel", 2)
  expect(run.seen.worker).toBe(2)
  expect(run.children).toHaveLength(2)
  expect(run.binding).toBeUndefined()
  for (const state of run.tasks) expect(state?.metadata.fusion).toBeUndefined()
}, 60_000)

test("an explicit session_id naming the bound worker is still a Fusion handoff", async () => {
  const run = await runTurn("fusion", 2, { explicitContinuation: true })
  expect(run.children).toHaveLength(1)
  expect(run.tasks).toHaveLength(2)
  expect((run.tasks[1]?.metadata.fusion as { handoff: number }).handoff).toBe(2)
  expect(run.binding).toMatchObject({ handoffs: 2, turn: { handoffs: 2 } })
}, 60_000)
