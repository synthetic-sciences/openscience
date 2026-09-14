import { afterEach, expect, test } from "bun:test"
import { HarnessState } from "../../../src/harness/state"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { SessionPrompt } from "../../../src/session/prompt"
import { tmpdir, trustProject } from "../../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../../fixture/stress-provider"

afterEach(() => HarnessState.reset())

/** A model that always answers with plain text and stops. */
function server() {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-hooks",
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
      requests.push(await request.json())
      return new Response(
        chunk({ role: "assistant", content: "All done." }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return { instance, requests }
}

function text(request: { messages: Array<{ role: string; content: unknown }> }) {
  return JSON.stringify(request.messages)
}

/** Research turns only: title and summary generation share the fixture provider. */
function main(requests: Array<{ messages: Array<{ role: string; content: unknown }> }>) {
  return requests.filter((request) => text(request).includes("Methods and deliverables"))
}

const SPEC = "Write results/alpha.csv with columns id,score and results/beta.md summarizing the fit."

test("a final answer with named outputs missing is continued twice by the deliverables unit, then stands", async () => {
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
          parts: [{ type: "text", text: SPEC }],
        })
        const turns = main(fixture.requests)
        expect(turns).toHaveLength(3)
        expect(text(turns[0])).not.toContain("not ready")
        expect(text(turns[1])).toContain("results/alpha.csv: does not exist")
        expect(text(turns[2])).toContain("results/beta.md: does not exist")
        // The injections are durable synthetic continuations, not user text.
        const messages = await Session.messages({ sessionID: session.id })
        const harness = messages.filter(
          (message) => message.info.role === "user" && message.info.internal?.type === "continuation",
        )
        expect(harness).toHaveLength(2)
        expect(harness.every((message) => message.parts.every((part) => part.type !== "text" || part.synthetic))).toBe(
          true,
        )
      },
    })
  } finally {
    fixture.instance.stop(true)
  }
})

test("switching the deliverables unit off removes the continuation", async () => {
  const fixture = server()
  try {
    await using tmp = await tmpdir({
      git: true,
      config: { ...stressProviderConfig(`${fixture.instance.url.origin}/v1`), harness: { deliverables: false } },
    })
    await Instance.provide({
      directory: tmp.path,
      init: trustProject,
      fn: async () => {
        const session = await Session.create({ workspace: "project" })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          parts: [{ type: "text", text: SPEC }],
        })
        expect(main(fixture.requests)).toHaveLength(1)
      },
    })
  } finally {
    fixture.instance.stop(true)
  }
})

test("compute stays in <env>; time and spend ride at the tail so the system prompt is cache-stable across steps", async () => {
  const fixture = toolThenText()
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
          deadline: Date.now() + 2 * 60 * 60_000,
          parts: [{ type: "text", text: "Say hello." }],
        })
        const steps = main(fixture.requests)
        expect(steps).toHaveLength(2)
        const system = (request: { messages: Array<{ role: string; content: unknown }> }) =>
          request.messages.filter((message) => message.role === "system")
        const tail = (request: { messages: Array<{ role: string; content: unknown }> }) => request.messages.at(-1)!
        const head = JSON.stringify(system(steps[0]))
        expect(head).toMatch(/Compute: \d+ CPUs, [\d.]+ GiB/)
        expect(head).toMatch(/Knowledge cutoff: /)
        expect(head).not.toContain("Time budget:")
        expect(head).not.toContain("Spent so far")
        // The provider caches the prefix; a second step whose system prompt
        // differs by one spend figure pays for the whole context again.
        expect(JSON.stringify(system(steps[1]))).toBe(head)
        for (const step of steps) {
          const last = tail(step)
          expect(last.role).toBe("user")
          expect(String(last.content)).toMatch(
            /<system-reminder kind="status">[\s\S]*Time budget: 2h, elapsed \dm[\s\S]*Spent so far on this session[\s\S]*<\/system-reminder>/,
          )
        }
        // The tail is request-only: nothing synthetic was persisted for it.
        const messages = await Session.messages({ sessionID: session.id })
        expect(messages.filter((message) => message.info.role === "user")).toHaveLength(1)
      },
    })
  } finally {
    fixture.instance.stop(true)
  }
})

/** A model that reads a file on its first step and answers on the second, so
 * two provider requests of one turn can be compared. */
function toolThenText() {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  let calls = 0
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-tail",
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
      const body = await request.json()
      requests.push(body)
      const research = text(body).includes("Methods and deliverables")
      if (research && calls++ === 0) {
        return new Response(
          chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_glob",
                  type: "function",
                  function: { name: "glob", arguments: JSON.stringify({ pattern: "*.md" }) },
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
        chunk({ role: "assistant", content: "All done." }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return { instance, requests }
}

/** A model that keeps reading a missing file under a new name until told to
 * stop, then answers with text. Same cause, different arguments: the input
 * doom-loop guard never sees a repeat, the same-cause error guard does. */
function failingReader(root: { value: string }) {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  let calls = 0
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-guard",
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
      const body = await request.json()
      requests.push(body)
      const conversation = JSON.stringify(body.messages)
      if (!conversation.includes("Methods and deliverables")) {
        return new Response(
          chunk({ role: "assistant", content: "title" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
          {
            headers: { "content-type": "text/event-stream" },
          },
        )
      }
      // After a redirect the model changes approach: it answers with text.
      if (conversation.includes("Diagnose the root cause") || calls >= 8) {
        return new Response(
          chunk({ role: "assistant", content: "Changed approach: the file is absent." }, null) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      calls++
      const call = {
        id: `call_${calls}`,
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ filePath: `${root.value}/missing-${calls}.txt` }) },
      }
      return new Response(
        chunk({ role: "assistant", tool_calls: [{ index: 0, ...call }] }, null) +
          chunk({}, "tool_calls") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return { instance, requests, calls: () => calls }
}

test("three same-cause tool failures become one redirect instead of a stop; the redirect is a synthetic continuation", async () => {
  const root = { value: "" }
  const fixture = failingReader(root)
  try {
    await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${fixture.instance.url.origin}/v1`) })
    root.value = tmp.path
    await Instance.provide({
      directory: tmp.path,
      init: trustProject,
      fn: async () => {
        const session = await Session.create({ workspace: "project" })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          parts: [{ type: "text", text: "Read the configuration file and report its contents." }],
        })
        // Three failed reads, then the redirect, then the text answer.
        expect(fixture.calls()).toBe(3)
        const messages = await Session.messages({ sessionID: session.id })
        const redirect = messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "text" && part.synthetic && part.text.includes("Diagnose the root cause"))
        expect(redirect).toBeDefined()
        const stopped = messages
          .flatMap((message) => message.parts)
          .some((part) => part.type === "text" && part.text.includes("stopped this turn after three consecutive"))
        expect(stopped).toBe(false)
        const final = messages.at(-1)
        expect(final?.parts.some((part) => part.type === "text" && part.text.includes("Changed approach"))).toBe(true)
      },
    })
  } finally {
    fixture.instance.stop(true)
  }
})
