import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import type { StressScenario } from "../../../../evals/cadence-harness/stress-matrix"
import { tmpdir, trustProject } from "../fixture/fixture"
import {
  STRESS_PROVIDER_ID,
  STRESS_PROVIDER_MODEL,
  STRESS_SCENARIO_MARKER,
  startStressProvider,
  stressProviderConfig,
} from "../fixture/stress-provider"

const scenarios: StressScenario[] = [
  {
    id: "delegation-schema-disabled",
    category: "delegation",
    title: "Disabled delegation provider schema",
    prompt: "Inspect the repository evidence and explain the relevant implementation path.",
    config: { delegation: false },
    stimulus: { kind: "inspect", target: "tools" },
    expect: { terminal: "completed", children: 0, artifacts: "none" },
  },
  {
    id: "delegation-schema-explicit",
    category: "delegation",
    title: "Explicit delegation provider schema",
    prompt: "Ask the explicitly attached execution agent to inspect the repository evidence.",
    config: { delegation: false, explicitAgent: "execute" },
    stimulus: { kind: "inspect", target: "tools" },
    expect: { terminal: "completed", children: 0, artifacts: "none" },
  },
  {
    id: "reminder-schema-legacy",
    category: "chat",
    title: "Legacy reminder provider role",
    prompt: "Continue the repository inspection from the earlier visible request.",
    config: { delegation: false, legacy: true },
    stimulus: { kind: "inspect", target: "messages" },
    expect: { terminal: "completed", children: 0, artifacts: "none" },
  },
]

function text(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(text).join("\n")
  if (!value || typeof value !== "object") return ""
  return Object.values(value).map(text).join("\n")
}

function role(body: { messages?: unknown }, name: string) {
  if (!Array.isArray(body.messages)) return ""
  return body.messages
    .filter(
      (message): message is Record<string, unknown> =>
        !!message && typeof message === "object" && "role" in message && message.role === name,
    )
    .map((message) => text(message.content))
    .join("\n")
}

describe("delegation at the provider boundary", () => {
  test("keeps internal reminders in system messages and applies explicit delegation to the actual tool schema", async () => {
    const local = startStressProvider(scenarios)
    try {
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`),
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          await trustProject()
          await Provider.invalidate()
        },
        fn: async () => {
          for (const scenario of scenarios) {
            const session = await Session.create({ title: scenario.title })
            if (scenario.config?.legacy) {
              const seed = await SessionPrompt.prompt({
                sessionID: session.id,
                model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
                agent: "research",
                delegation: false,
                noReply: true,
                parts: [{ type: "text", text: "Earlier visible request." }],
              })
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: seed.info.id,
                sessionID: session.id,
                type: "text",
                synthetic: true,
                text: "<system-reminder>LEGACY_INTERNAL_GUIDANCE</system-reminder>",
              })
            }
            await SessionPrompt.prompt({
              sessionID: session.id,
              model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
              agent: "research",
              effort: "normal",
              delegation: false,
              system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
              parts: [
                { type: "text", text: scenario.prompt },
                ...(scenario.config?.explicitAgent
                  ? [{ type: "agent" as const, name: String(scenario.config.explicitAgent) }]
                  : []),
              ],
            })

            const stored = await Session.messages({ sessionID: session.id })
            const user = stored.findLast((message) => message.info.role === "user")
            expect(
              user?.parts
                .filter((part) => part.type === "text" && !part.synthetic)
                .map((part) => (part.type === "text" ? part.text : "")),
            ).toEqual([scenario.prompt])
            expect(JSON.stringify(user)).not.toContain("<system-reminder>")
            expect(JSON.stringify(user)).not.toContain("Research effort:")
          }

          await local.quiet()
          const disabled = local.main("delegation-schema-disabled")[0]
          const explicit = local.main("delegation-schema-explicit")[0]
          if (!disabled || !explicit) throw new Error("Missing provider request")

          expect(disabled.tools).not.toContain("task")
          expect(explicit.tools).toContain("task")
          expect(disabled.tools).toContain("read")
          expect(explicit.tools).toContain("read")

          const legacy = local.main("reminder-schema-legacy")[0]
          if (!legacy) throw new Error("Missing legacy reminder provider request")
          expect(role(legacy.body, "user")).not.toContain("LEGACY_INTERNAL_GUIDANCE")
          expect(role(legacy.body, "system")).toContain("LEGACY_INTERNAL_GUIDANCE")

          for (const request of [disabled, explicit, legacy]) {
            const user = role(request.body, "user")
            const system = role(request.body, "system")
            expect(user).not.toContain("<system-reminder>")
            expect(user).not.toContain("Research effort:")
            expect(system).toContain("Research effort: NORMAL")
            expect(system).toContain("as many useful workers as available machine capacity permits")
            expect(system).not.toContain("<system-reminder>")
          }
        },
      })
    } finally {
      local.stop()
    }
  }, 20_000)
})
