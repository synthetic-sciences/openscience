import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ArtifactStore } from "../../src/artifact/store"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionResearch } from "../../src/session/research"
import { SessionStatus } from "../../src/session/status"
import { SessionTraceStore } from "../../src/session/trace-store"
import { Skill } from "../../src/skill"
import { RAW_TOOL_ERRORS, STRESS_MATRIX, type StressScenario } from "../../../../evals/cadence-harness/stress-matrix"
import { tmpdir, trustProject } from "../fixture/fixture"
import {
  STRESS_PROVIDER_ID,
  STRESS_PROVIDER_MODEL,
  STRESS_SCENARIO_MARKER,
  startStressProvider,
  stressProviderConfig,
} from "../fixture/stress-provider"

const MODEL = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }

const CAMPAIGN_IDS = [
  "chat.exact-reply",
  "chat.follow-up-context",
  "chat.unicode",
  "chat.concurrent-isolation",
  "non_research.explain",
  "non_research.rewrite",
  "non_research.local-read",
  "skills.prefix",
  "skills.inline",
  "skills.punctuated",
  "skills.unknown",
  "skills.disabled",
  "delegation.auto-on",
  "delegation.auto-off",
  "delegation.explicit-attachment",
  "delegation.specialist",
  "malformed_tools.empty-bash",
  "malformed_tools.unknown-tool",
  "malformed_tools.repeat-breaker",
  "retries.rate-limit",
  "retries.server-overload",
  "retries.deterministic-400",
  "retries.openrouter-502",
  "retries.stream-disconnect",
  "budgets.ordinary-ungated",
  "artifacts.optional-chat",
  "artifacts.no-invented-report",
  "permissions.full-project",
  "provider_failures.insufficient-balance",
  "provider_failures.unauthorized",
  "provider_failures.policy",
  "provider_failures.region",
  "provider_failures.model-missing",
] as const

const TRANSIENT_IDS = new Set([
  "retries.rate-limit",
  "retries.server-overload",
  "retries.openrouter-502",
  "retries.stream-disconnect",
])

const TERMINAL_IDS = new Set([
  "retries.deterministic-400",
  "provider_failures.insufficient-balance",
  "provider_failures.unauthorized",
  "provider_failures.policy",
  "provider_failures.region",
  "provider_failures.model-missing",
])

type Outcome = {
  scenario: StressScenario
  session: Session.Info
  workspace: string
  result: MessageV2.WithParts
  messages: MessageV2.WithParts[]
  trace: SessionTraceStore.State
}

function selected() {
  const lookup = new Map(STRESS_MATRIX.map((scenario) => [scenario.id, scenario]))
  return CAMPAIGN_IDS.map((id) => {
    const scenario = lookup.get(id)
    if (!scenario) throw new Error(`Missing stress scenario ${id}`)
    return scenario
  })
}

function promptParts(scenario: StressScenario): SessionPrompt.PromptInput["parts"] {
  return [
    { type: "text", text: scenario.prompt },
    ...(scenario.config?.explicitAgent
      ? [{ type: "agent" as const, name: String(scenario.config.explicitAgent) }]
      : []),
  ]
}

function aggregate(messages: MessageV2.WithParts[]) {
  return JSON.stringify(messages)
}

function toolParts(messages: MessageV2.WithParts[]) {
  return messages.flatMap((message) => message.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool"))
}

async function execute(scenario: StressScenario): Promise<Outcome> {
  const session = await Session.create({ title: `Stress: ${scenario.id}` })
  const workspace = await SessionFilesystem.workspace(session.id)
  await Bun.write(path.join(workspace, "README.md"), `# ${scenario.id}\n`)

  const input = {
    sessionID: session.id,
    model: MODEL,
    agent: "research",
    delegation: typeof scenario.config?.delegation === "boolean" ? scenario.config.delegation : undefined,
    system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
    parts: promptParts(scenario),
  } satisfies SessionPrompt.PromptInput
  const first = await SessionPrompt.prompt(input)
  const result = await (scenario.turns ?? []).reduce<Promise<MessageV2.WithParts>>(async (previous, text) => {
    await previous
    return SessionPrompt.prompt({
      sessionID: session.id,
      model: MODEL,
      agent: "research",
      delegation: input.delegation,
      system: input.system,
      parts: [{ type: "text", text }],
    })
  }, Promise.resolve(first))
  await Session.flushPendingParts(session.id)
  return {
    scenario,
    session,
    workspace,
    result,
    messages: await Session.messages({ sessionID: session.id }),
    trace: await SessionTraceStore.read(session.id),
  }
}

describe("provider-driven harness stress campaign", () => {
  test("runs dozens of isolated real SessionPrompt turns through a local OpenAI-compatible provider", async () => {
    const scenarios = selected()
    expect(scenarios).toHaveLength(33)
    const provider = startStressProvider(scenarios)

    try {
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${provider.server.port}/v1`),
      })
      await fs.mkdir(path.join(tmp.path, ".openscience", "skills", "fixture-skill"), { recursive: true })
      await Bun.write(
        path.join(tmp.path, ".openscience", "skills", "fixture-skill", "SKILL.md"),
        [
          "---",
          "name: fixture-skill",
          "description: Deterministic stress fixture skill",
          "---",
          "# Fixture skill",
          "Return only evidence observed in the isolated fixture.",
        ].join("\n"),
      )

      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          await trustProject()
          await Provider.invalidate()
          await Skill.invalidate()
        },
        fn: async () => {
          const outcomes: Outcome[] = []
          for (let index = 0; index < scenarios.length; index += 6) {
            outcomes.push(...(await Promise.all(scenarios.slice(index, index + 6).map(execute))))
          }
          await provider.quiet()

          expect(outcomes).toHaveLength(33)
          expect(new Set(outcomes.map((outcome) => outcome.session.id)).size).toBe(outcomes.length)
          expect(new Set(outcomes.map((outcome) => outcome.workspace)).size).toBe(outcomes.length)
          expect(provider.requests.filter((request) => request.kind === "main")).toHaveLength(49)
          expect(provider.requests.filter((request) => request.kind === "summary").length).toBeGreaterThanOrEqual(20)
          expect(provider.requests.filter((request) => request.kind === "child")).toHaveLength(3)
          expect(await Promise.all(outcomes.map((outcome) => SessionResearch.read(outcome.session.id)))).toEqual(
            Array.from({ length: outcomes.length }, () => undefined),
          )

          for (const outcome of outcomes) {
            const text = aggregate(outcome.messages)
            expect(SessionStatus.get(outcome.session.id)).toEqual({ type: "idle" })
            expect(text).toContain(`${STRESS_SCENARIO_MARKER}${outcome.scenario.id}`)
            for (const error of RAW_TOOL_ERRORS) expect(text).not.toContain(error)
            for (const other of CAMPAIGN_IDS) {
              if (other === outcome.scenario.id) continue
              expect(text).not.toContain(`${STRESS_SCENARIO_MARKER}${other}`)
            }
          }

          expect(Object.fromEntries([...TRANSIENT_IDS].map((id) => [id, provider.count(id)]))).toEqual({
            "retries.rate-limit": 2,
            "retries.server-overload": 2,
            "retries.openrouter-502": 2,
            "retries.stream-disconnect": 2,
          })
          for (const id of TRANSIENT_IDS) {
            const outcome = outcomes.find((item) => item.scenario.id === id)!
            expect(outcome.result.info.role).toBe("assistant")
            if (outcome.result.info.role !== "assistant") throw new Error("Expected assistant result")
            expect(outcome.result.info.error).toBeUndefined()
            expect(outcome.trace.retries).toHaveLength(1)
            expect(outcome.trace.retries[0]?.delayMs).toBe(id === "retries.stream-disconnect" ? 2_000 : 1)
          }

          for (const id of TERMINAL_IDS) {
            const outcome = outcomes.find((item) => item.scenario.id === id)!
            expect(outcome.result.info.role).toBe("assistant")
            if (outcome.result.info.role !== "assistant") throw new Error("Expected assistant result")
            expect(outcome.result.info.error).toBeDefined()
            expect(provider.count(id)).toBe(1)
            expect(outcome.trace.retries).toHaveLength(0)
          }

          const followup = provider.main("chat.follow-up-context")
          expect(followup).toHaveLength(2)
          expect(followup[1]?.text).toContain("Remember the codeword juniper")
          expect(followup[1]?.text).toContain("What codeword did I give you?")
          expect(followup[1]?.text).toContain("juniper")

          for (const id of ["skills.prefix", "skills.inline", "skills.punctuated"]) {
            const request = provider.main(id)[0]
            expect(request?.tools).toContain("skill")
            expect(request?.text).toContain("<slash-skill-invocation>")
            expect(request?.text).toContain('skill({name:"fixture-skill"})')
            const outcome = outcomes.find((item) => item.scenario.id === id)!
            expect(toolParts(outcome.messages)).toContainEqual(
              expect.objectContaining({ tool: "skill", state: expect.objectContaining({ status: "completed" }) }),
            )
          }

          expect(provider.main("skills.unknown")[0]?.text).not.toContain('skill({name:"not-installed"})')
          expect(provider.main("skills.disabled")[0]?.text).not.toContain('skill({name:"fixture-disabled"})')
          expect(provider.main("non_research.explain")[0]?.tools).toEqual([])
          expect(provider.main("delegation.auto-off")[0]?.tools).not.toContain("task")
          expect(provider.main("delegation.auto-on")[0]?.tools).toContain("task")
          expect(provider.main("delegation.explicit-attachment")[0]?.tools).toContain("task")
          expect(provider.main("delegation.specialist")[0]?.tools).toContain("task")

          for (const id of ["delegation.auto-on", "delegation.explicit-attachment", "delegation.specialist"]) {
            const outcome = outcomes.find((item) => item.scenario.id === id)!
            expect(await Session.children(outcome.session.id)).toHaveLength(1)
            expect(toolParts(outcome.messages)).toContainEqual(
              expect.objectContaining({ tool: "task", state: expect.objectContaining({ status: "completed" }) }),
            )
          }

          const malformed = outcomes.find((item) => item.scenario.id === "malformed_tools.empty-bash")!
          expect(aggregate(malformed.messages)).toContain("Recovered incomplete bash call")
          expect(toolParts(malformed.messages)).toContainEqual(
            expect.objectContaining({ tool: "invalid", state: expect.objectContaining({ status: "completed" }) }),
          )
          expect(provider.count(malformed.scenario.id)).toBe(2)

          const unknown = outcomes.find((item) => item.scenario.id === "malformed_tools.unknown-tool")!
          expect(aggregate(unknown.messages)).toContain("unavailable tool not_a_real_tool")
          expect(toolParts(unknown.messages)).toHaveLength(1)
          expect(toolParts(unknown.messages)[0]?.tool).toBe("invalid")

          const repeated = outcomes.find((item) => item.scenario.id === "malformed_tools.repeat-breaker")!
          expect(aggregate(repeated.messages)).toContain("stopped two repeated incomplete bash calls")
          expect(toolParts(repeated.messages)).toHaveLength(2)
          expect(provider.count(repeated.scenario.id)).toBe(2)

          const read = outcomes.find((item) => item.scenario.id === "non_research.local-read")!
          expect(toolParts(read.messages)).toContainEqual(
            expect.objectContaining({ tool: "read", state: expect.objectContaining({ status: "completed" }) }),
          )
          const write = outcomes.find((item) => item.scenario.id === "permissions.full-project")!
          expect(await Bun.file(path.join(tmp.path, "scratch.txt")).text()).toBe("MATRIX_WRITE")
          expect(toolParts(write.messages)).toContainEqual(
            expect.objectContaining({ tool: "write", state: expect.objectContaining({ status: "completed" }) }),
          )

          expect(await ArtifactStore.list(Instance.project.id)).toEqual([])
        },
      })
    } finally {
      provider.stop()
    }
  }, 120_000)
})
