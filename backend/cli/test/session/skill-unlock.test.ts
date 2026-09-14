import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { HarnessState } from "../../src/harness/state"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

afterEach(() => HarnessState.reset())

/** A model that loads the autoresearch skill on its first step and answers
 * with text on every other step, so two turns can be compared. */
function skillLoader() {
  const requests: Array<{ tools: string[]; text: string }> = []
  let loaded = false
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-skill",
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
      const body = (await request.json()) as { messages: unknown; tools?: Array<{ function: { name: string } }> }
      const text = JSON.stringify(body.messages)
      const tools = (body.tools ?? []).map((tool) => tool.function.name)
      requests.push({ tools, text })
      const research = text.includes("Methods and deliverables")
      if (research && !loaded) {
        loaded = true
        return new Response(
          chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_skill",
                  type: "function",
                  function: { name: "skill", arguments: JSON.stringify({ name: "study-driver" }) },
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
        chunk({ role: "assistant", content: "Noted." }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return { instance, requests }
}

test("a skill's tools stay on offer in later turns for as long as its text is in the context", async () => {
  const fixture = skillLoader()
  try {
    await using tmp = await tmpdir({
      git: true,
      config: stressProviderConfig(`${fixture.instance.url.origin}/v1`),
      init: async (dir) => {
        // A project skill that unlocks the study tools, the way the bundled
        // autoresearch skill does; the test stays hermetic without the bundle.
        await Bun.write(
          path.join(dir, ".openscience", "skill", "study-driver", "SKILL.md"),
          [
            "---",
            "name: study-driver",
            "description: Drives a study with the study and experiments tools.",
            "allowed-tools: [study, experiments]",
            "---",
            "",
            "# Study driver",
            "",
            "Create the study with `study create`, then queue ideas.",
            "",
          ].join("\n"),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: trustProject,
      fn: async () => {
        const session = await Session.create({ workspace: "project" })
        const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }
        await SessionPrompt.prompt({
          sessionID: session.id,
          model,
          agent: "research",
          parts: [{ type: "text", text: "Set up an autoresearch study for this metric." }],
        })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model,
          agent: "research",
          parts: [{ type: "text", text: "Use the latest models." }],
        })
        const research = fixture.requests.filter((request) => request.text.includes("Methods and deliverables"))
        expect(research.length).toBeGreaterThanOrEqual(3)
        // Before the load: the default set, no study tools.
        expect(research[0].tools).not.toContain("study")
        // After the load, in the same turn and in the next one.
        for (const request of research.slice(1)) {
          expect(request.tools).toContain("study")
          expect(request.tools).toContain("experiments")
        }
      },
    })
  } finally {
    fixture.instance.stop(true)
  }
})
