import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Skill } from "../../src/skill"
import type { StressScenario } from "../../../../evals/cadence-harness/stress-matrix"
import { tmpdir, trustProject } from "../fixture/fixture"
import {
  STRESS_PROVIDER_ID,
  STRESS_PROVIDER_MODEL,
  STRESS_SCENARIO_MARKER,
  startStressProvider,
  stressProviderConfig,
} from "../fixture/stress-provider"

const BEFORE = "skills.before-add"
const AFTER = "skills.after-add"
const scenarios = [
  {
    id: BEFORE,
    category: "skills",
    title: "Session before skill addition",
    prompt: "Say ready before adding the skill.",
    stimulus: { kind: "reply", text: "READY_FOR_SKILL" },
    expect: { terminal: "completed", tools: 0, artifacts: "none" },
  },
  {
    id: AFTER,
    category: "skills",
    title: "Session after skill addition",
    prompt: "What is the bounded fixture result? /late-session-skill",
    stimulus: { kind: "tool", name: "skill", input: { name: "late-session-skill" } },
    expect: { terminal: "completed", tools: 1, artifacts: "none" },
  },
] as const satisfies readonly StressScenario[]

function tools(messages: MessageV2.WithParts[]) {
  return messages.flatMap((message) => message.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool"))
}

describe("provider-driven skill routing", () => {
  test("makes a skill added between prompts available in the same session", async () => {
    const provider = startStressProvider(scenarios)
    try {
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${provider.server.port}/v1`),
      })

      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          await trustProject()
          await Provider.invalidate()
          await Skill.invalidate()
        },
        fn: async () => {
          const session = await Session.create({ title: "Skill hot-add fixture" })
          const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }
          await SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            system: `${STRESS_SCENARIO_MARKER}${BEFORE}`,
            parts: [{ type: "text", text: scenarios[0].prompt }],
          })

          const dir = path.join(tmp.path, ".openscience", "skills", "late-session-skill")
          await fs.mkdir(dir, { recursive: true })
          await Bun.write(
            path.join(dir, "SKILL.md"),
            [
              "---",
              "name: late-session-skill",
              "description: Skill added after the session already started",
              "---",
              "# Late session skill",
              "Return the bounded fixture result.",
            ].join("\n"),
          )
          await Skill.invalidate()

          await SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            system: `${STRESS_SCENARIO_MARKER}${AFTER}`,
            parts: [{ type: "text", text: scenarios[1].prompt }],
          })
          await Session.flushPendingParts(session.id)

          const request = provider.main(AFTER)[0]
          expect(request?.tools).toContain("skill")
          expect(request?.text).toContain("<slash-skill-invocation>")
          expect(request?.text).toContain('skill({name:"late-session-skill"})')
          expect(tools(await Session.messages({ sessionID: session.id }))).toContainEqual(
            expect.objectContaining({ tool: "skill", state: expect.objectContaining({ status: "completed" }) }),
          )
        },
      })
    } finally {
      provider.stop()
    }
  })
})
