import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ArtifactStore } from "../../src/artifact/store"
import { Global } from "../../src/global"
import { API_BASE } from "../../src/openscience"
import { PermissionNext } from "../../src/permission/next"
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
import { OutboundTelemetry } from "../../src/telemetry/outbound"
import { RAW_TOOL_ERRORS, STRESS_MATRIX, type StressScenario } from "../../../../evals/cadence-harness/stress-matrix"
import { tmpdir, trustProject } from "../fixture/fixture"
import {
  STRESS_PROVIDER_ID,
  STRESS_PROVIDER_COMPACT_MODEL,
  STRESS_PROVIDER_MODEL,
  STRESS_SCENARIO_MARKER,
  startStressProvider,
  stressProviderConfig,
} from "../fixture/stress-provider"

const CAMPAIGN_IDS = [
  "chat.exact-reply",
  "chat.follow-up-context",
  "chat.unicode",
  "chat.concurrent-isolation",
  "non_research.explain",
  "non_research.rewrite",
  "non_research.local-read",
  "non_research.local-edit",
  "indexing.local-private",
  "skills.prefix",
  "skills.inline",
  "skills.punctuated",
  "skills.direct-inline",
  "skills.unknown",
  "skills.disabled",
  "delegation.auto-on",
  "delegation.auto-off",
  "delegation.explicit-attachment",
  "delegation.specialist",
  "delegation.child-failure",
  "delegation.child-grants",
  "malformed_tools.empty-bash",
  "malformed_tools.alias-bash",
  "malformed_tools.truncated-json",
  "malformed_tools.unknown-tool",
  "malformed_tools.repeat-breaker",
  "retries.rate-limit",
  "retries.server-overload",
  "retries.deterministic-400",
  "retries.openrouter-502",
  "retries.stream-disconnect",
  "compaction.proactive",
  "compaction.reactive-overflow",
  "compaction.handoff-objective",
  "budgets.ordinary-ungated",
  "budgets.soft-finalization",
  "budgets.hard-block",
  "budgets.explicit-resume",
  "artifacts.optional-chat",
  "artifacts.requested-only",
  "artifacts.no-invented-report",
  "permissions.allow-once",
  "permissions.deny",
  "permissions.full-project",
  "permissions.external-ask",
  "provider_failures.insufficient-balance",
  "provider_failures.unauthorized",
  "provider_failures.policy",
  "provider_failures.region",
  "provider_failures.model-missing",
] as const

const RETRY_IDS = new Set([
  "retries.rate-limit",
  "retries.server-overload",
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

function model(scenario: StressScenario) {
  return {
    providerID: STRESS_PROVIDER_ID,
    modelID: scenario.config?.context ? STRESS_PROVIDER_COMPACT_MODEL : STRESS_PROVIDER_MODEL,
  }
}

function permissions(scenario: StressScenario): PermissionNext.Ruleset | undefined {
  const rules = [
    ...(scenario.config?.read === "ask" ? [{ permission: "read", pattern: "*", action: "ask" as const }] : []),
    ...(scenario.config?.externalDirectory === "ask"
      ? [{ permission: "external_directory", pattern: "*", action: "ask" as const }]
      : []),
  ]
  return rules.length ? rules : undefined
}

async function permission(sessionID: string): Promise<PermissionNext.Request> {
  for (const _ of Array.from({ length: 300 })) {
    const pending = (await PermissionNext.list()).find((item) => item.sessionID === sessionID)
    if (pending) return pending
    await Bun.sleep(10)
  }
  throw new Error(`Permission request did not appear for ${sessionID}`)
}

async function prepareContract(scenario: StressScenario, sessionID: string) {
  if (scenario.config?.researchContract !== true) return
  const configured = Number(scenario.config.modelCalls)
  const modelCalls = Number.isInteger(configured) && configured > 0 ? configured : 128
  await SessionResearch.define(sessionID, {
    objective: `Deterministically verify ${scenario.id}`,
    domain: "general",
    template: "minimal",
    limits: { modelCalls: scenario.config.exhausted ? 1 : modelCalls },
  })
  if (scenario.config.exhausted !== true) return
  await SessionResearch.runtimePreflight(sessionID)
  const decision = await SessionResearch.runtimePreflight(sessionID)
  if (decision.decision !== "block") throw new Error(`Failed to exhaust ${scenario.id}`)
}

function aggregate(messages: MessageV2.WithParts[]) {
  return JSON.stringify(messages)
}

function toolParts(messages: MessageV2.WithParts[]) {
  return messages.flatMap((message) => message.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool"))
}

async function execute(scenario: StressScenario, externalFile: string): Promise<Outcome> {
  const session = await Session.create({ title: `Stress: ${scenario.id}`, permission: permissions(scenario) })
  const workspace = await SessionFilesystem.workspace(session.id)
  await Promise.all([
    Bun.write(path.join(workspace, "README.md"), `# ${scenario.id}\n`),
    Bun.write(path.join(workspace, "scratch-note.txt"), "fixture-owned note\n"),
    Bun.write(path.join(workspace, "fixture.txt"), "MATRIX_PERMISSION_FIXTURE\n"),
    Bun.write(path.join(workspace, "result.csv"), "name,value\nfixture,1\n"),
    fs
      .mkdir(path.join(workspace, "fixture-repository"), { recursive: true })
      .then(() => Bun.write(path.join(workspace, "fixture-repository", "README.md"), "private fixture source\n")),
  ])
  if (scenario.id === "indexing.local-private") {
    const folder = path.join(workspace, "fixture-repository")
    const git = Bun.which("git")
    if (!git) throw new Error("Git is required for the local-indexing fixture")
    const init = Bun.spawn([git, "init", "--quiet"], { cwd: folder, stdout: "ignore", stderr: "pipe" })
    if ((await init.exited) !== 0) throw new Error(await new Response(init.stderr).text())
    const add = Bun.spawn([git, "add", "README.md"], { cwd: folder, stdout: "ignore", stderr: "pipe" })
    if ((await add.exited) !== 0) throw new Error(await new Response(add.stderr).text())
  }
  await prepareContract(scenario, session.id)

  const input = {
    sessionID: session.id,
    model: model(scenario),
    agent: "research",
    delegation: typeof scenario.config?.delegation === "boolean" ? scenario.config.delegation : undefined,
    system: `${STRESS_SCENARIO_MARKER}${scenario.id}\nSTRESS_EXTERNAL_FILE:${externalFile}`,
    parts: promptParts(scenario),
  } satisfies SessionPrompt.PromptInput
  const pending = SessionPrompt.prompt(input)
  const requested = scenario.config?.permissionReply
  if (typeof requested === "string") {
    const request = await permission(session.id)
    await PermissionNext.reply({ requestID: request.id, reply: PermissionNext.Reply.parse(requested) })
  }
  const first = await pending
  const result = await (scenario.turns ?? []).reduce<Promise<MessageV2.WithParts>>(async (previous, text) => {
    await previous
    return SessionPrompt.prompt({
      sessionID: session.id,
      model: input.model,
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
    expect(scenarios).toHaveLength(50)
    const provider = startStressProvider(scenarios)
    const fetch = globalThis.fetch
    const session = path.join(Global.Path.data, "openscience-session.json")
    const atlas: Array<{ url: string; authorization: string; body?: Record<string, unknown> }> = []

    try {
      await fs.mkdir(Global.Path.data, { recursive: true })
      await Bun.write(session, JSON.stringify({ api_key: "thk_test", user_id: "stress-user" }))
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url === `${API_BASE}/api/v1/telemetry/batches`) {
          // This test exercises the real SessionPrompt pipeline, including its
          // trace hooks, but must not turn a deliberately local stress campaign
          // into an ever-growing offline telemetry queue. A successful local
          // collector keeps the queue bounded exactly as the service does.
          return Response.json({})
        }
        if (!url.startsWith(`${API_BASE}/api/v1/sources`)) return fetch(input, init)
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        atlas.push({
          url,
          authorization: headers.get("authorization") ?? "",
          ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
        })
        return Response.json({ source_id: "src_local_fixture", type: "local_folder" }, { status: 201 })
      }) as typeof globalThis.fetch
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${provider.server.port}/v1`),
      })
      await using external = await tmpdir({
        init: (directory) => Bun.write(path.join(directory, "file.txt"), "MATRIX_EXTERNAL_FIXTURE\n"),
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
            outcomes.push(
              ...(await Promise.all(
                scenarios
                  .slice(index, index + 6)
                  .map((scenario) => execute(scenario, path.join(external.path, "file.txt"))),
              )),
            )
          }
          expect(await OutboundTelemetry.drain({ timeoutMs: 5_000 })).toMatchObject({
            captured: true,
            flushed: true,
            timedOut: false,
            pendingEvents: 0,
          })
          await provider.quiet()

          expect(outcomes).toHaveLength(50)
          expect(new Set(outcomes.map((outcome) => outcome.session.id)).size).toBe(outcomes.length)
          expect(new Set(outcomes.map((outcome) => outcome.workspace)).size).toBe(outcomes.length)
          for (const scenario of scenarios) {
            if (scenario.id === "budgets.hard-block") {
              expect(provider.count(scenario.id)).toBe(0)
              continue
            }
            expect(provider.count(scenario.id)).toBeGreaterThan(0)
          }
          expect(provider.requests.filter((request) => request.kind === "summary").length).toBeGreaterThanOrEqual(20)
          expect(provider.requests.filter((request) => request.kind === "child")).toHaveLength(5)
          const contracts = await Promise.all(outcomes.map((outcome) => SessionResearch.read(outcome.session.id)))
          for (const [index, contract] of contracts.entries()) {
            expect(!!contract).toBe(outcomes[index]?.scenario.config?.researchContract === true)
          }

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

          expect(Object.fromEntries([...RETRY_IDS].map((id) => [id, provider.count(id)]))).toEqual({
            "retries.rate-limit": 2,
            "retries.server-overload": 2,
            "retries.stream-disconnect": 2,
          })
          for (const id of RETRY_IDS) {
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

          for (const id of ["skills.prefix", "skills.inline", "skills.punctuated", "skills.direct-inline"]) {
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

          for (const id of [
            "delegation.auto-on",
            "delegation.explicit-attachment",
            "delegation.specialist",
            "delegation.child-failure",
            "delegation.child-grants",
          ]) {
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

          const alias = outcomes.find((item) => item.scenario.id === "malformed_tools.alias-bash")!
          const aliasPart = toolParts(alias.messages).find((part) => part.tool === "bash")
          expect(aliasPart?.state.status).toBe("completed")
          if (aliasPart?.state.status !== "completed") throw new Error("Expected completed Bash alias")
          expect(aliasPart.state.output).toContain(alias.workspace)

          const truncated = outcomes.find((item) => item.scenario.id === "malformed_tools.truncated-json")!
          expect(aggregate(truncated.messages)).toContain("incomplete read call")
          expect(toolParts(truncated.messages)).toContainEqual(
            expect.objectContaining({ tool: "invalid", state: expect.objectContaining({ status: "completed" }) }),
          )

          const read = outcomes.find((item) => item.scenario.id === "non_research.local-read")!
          expect(toolParts(read.messages)).toContainEqual(
            expect.objectContaining({ tool: "read", state: expect.objectContaining({ status: "completed" }) }),
          )
          const edit = outcomes.find((item) => item.scenario.id === "non_research.local-edit")!
          expect(toolParts(edit.messages)).toContainEqual(
            expect.objectContaining({ tool: "read", state: expect.objectContaining({ status: "completed" }) }),
          )
          expect(toolParts(edit.messages)).toContainEqual(
            expect.objectContaining({ tool: "edit", state: expect.objectContaining({ status: "completed" }) }),
          )
          expect((await Bun.file(path.join(edit.workspace, "scratch-note.txt")).text()).trimEnd()).toBe(
            "fixture-owned note\nMATRIX_EDIT",
          )
          const write = outcomes.find((item) => item.scenario.id === "permissions.full-project")!
          expect(await Bun.file(path.join(tmp.path, "scratch.txt")).text()).toBe("MATRIX_WRITE")
          expect(toolParts(write.messages)).toContainEqual(
            expect.objectContaining({ tool: "write", state: expect.objectContaining({ status: "completed" }) }),
          )

          const failed = outcomes.find((item) => item.scenario.id === "delegation.child-failure")!
          const failedTask = toolParts(failed.messages).find((part) => part.tool === "task")
          expect(failedTask?.state.status).toBe("completed")
          if (failedTask?.state.status !== "completed") throw new Error("Expected bounded child failure handoff")
          expect(failedTask.state.metadata).toMatchObject({ outcome: "error", stopReason: "provider_error" })
          expect(aggregate(failed.messages)).toContain("limitation")
          const [failedChild] = await Session.children(failed.session.id)
          if (!failedChild) throw new Error("Expected failed child session")
          const failedChildMessages = await Session.messages({ sessionID: failedChild.id })
          expect(failedChildMessages.some((message) => message.info.role === "assistant" && !!message.info.error)).toBe(
            true,
          )

          const grants = outcomes.find((item) => item.scenario.id === "delegation.child-grants")!
          const [grantChild] = await Session.children(grants.session.id)
          if (!grantChild) throw new Error("Expected grant-isolation child session")
          const childWorkspace = await SessionFilesystem.workspace(grantChild.id)
          const childGrants = await SessionFilesystem.list(grantChild.id)
          expect(childGrants).toContainEqual(
            expect.objectContaining({ path: childWorkspace, access: "write", source: "workspace" }),
          )
          expect(childGrants).toContainEqual(
            expect.objectContaining({ path: grants.workspace, access: "read", source: "handoff" }),
          )
          for (const outcome of outcomes) {
            if (outcome.session.id === grants.session.id) continue
            expect(childGrants.some((grant) => grant.path === outcome.workspace)).toBe(false)
          }
          expect((await Session.get(grantChild.id)).permission).toContainEqual(
            expect.objectContaining({ permission: "task", action: "deny" }),
          )

          for (const id of [
            "retries.openrouter-502",
            "compaction.proactive",
            "compaction.reactive-overflow",
            "compaction.handoff-objective",
          ]) {
            const outcome = outcomes.find((item) => item.scenario.id === id)!
            const carriers = outcome.messages.filter(
              (message) => message.info.role === "user" && message.info.internal?.type === "compaction",
            )
            expect(carriers.length).toBeGreaterThanOrEqual(1)
            expect(
              provider.requests.some(
                (request) => request.kind === "summary" && request.scenario === outcome.scenario.id,
              ),
            ).toBe(true)
            expect(provider.count(id)).toBeGreaterThanOrEqual(2)
            expect(outcome.trace.retries).toHaveLength(0)
          }
          expect(provider.main("compaction.proactive").at(-1)?.text).toContain("MATRIX_COMPACT_CODEWORD")
          expect(provider.main("compaction.handoff-objective").at(-1)?.text).toContain("MATRIX_OBJECTIVE")

          const soft = outcomes.find((item) => item.scenario.id === "budgets.soft-finalization")!
          expect(provider.main(soft.scenario.id)).toHaveLength(3)
          expect(provider.main(soft.scenario.id)[1]?.text).toContain("finalization boundary")
          expect(await SessionResearch.read(soft.session.id)).toMatchObject({
            budget: { runtimeFinalizing: false, runtimeFinalizationCalls: 2, runtimeExhausted: true },
          })

          const hard = outcomes.find((item) => item.scenario.id === "budgets.hard-block")!
          expect(provider.count(hard.scenario.id)).toBe(0)
          expect(aggregate(hard.messages)).toContain("hard runtime limit")
          expect(await SessionResearch.read(hard.session.id)).toMatchObject({ budget: { runtimeExhausted: true } })

          const resumed = outcomes.find((item) => item.scenario.id === "budgets.explicit-resume")!
          expect(provider.count(resumed.scenario.id)).toBe(1)
          expect(await SessionResearch.read(resumed.session.id)).toMatchObject({
            budget: { runtimeEpoch: 2, runtimeExhausted: true, runtimeModelCalls: 1 },
          })
          expect(aggregate(resumed.messages)).toContain("MATRIX_EPOCH_2")

          for (const id of ["permissions.allow-once", "permissions.deny", "permissions.external-ask"]) {
            const outcome = outcomes.find((item) => item.scenario.id === id)!
            const approvals = Object.values(outcome.trace.approvals)
            expect(approvals).toHaveLength(1)
            expect(approvals[0]?.reply).toBe(id === "permissions.deny" ? "reject" : "once")
          }
          const allowed = outcomes.find((item) => item.scenario.id === "permissions.allow-once")!
          expect(toolParts(allowed.messages)).toContainEqual(
            expect.objectContaining({ tool: "read", state: expect.objectContaining({ status: "completed" }) }),
          )
          const denied = outcomes.find((item) => item.scenario.id === "permissions.deny")!
          expect(toolParts(denied.messages)).toContainEqual(
            expect.objectContaining({ tool: "read", state: expect.objectContaining({ status: "error" }) }),
          )
          const outside = outcomes.find((item) => item.scenario.id === "permissions.external-ask")!
          expect(Object.values(outside.trace.approvals)[0]).toMatchObject({
            permission: "external_directory",
            reply: "once",
          })
          expect(await SessionFilesystem.list(outside.session.id)).toContainEqual(
            expect.objectContaining({ path: external.path, access: "read", scope: "once", source: "permission" }),
          )

          const indexed = outcomes.find((item) => item.scenario.id === "indexing.local-private")!
          expect(toolParts(indexed.messages)).toContainEqual(
            expect.objectContaining({ tool: "atlas", state: expect.objectContaining({ status: "completed" }) }),
          )
          expect(atlas).toHaveLength(1)
          expect(atlas[0]).toMatchObject({
            authorization: "Bearer thk_test",
            body: {
              type: "local_folder",
              add_as_global_source: false,
              files: [{ path: "README.md", content: "private fixture source\n" }],
            },
          })
          expect(atlas[0]?.url).toBe(`${API_BASE}/api/v1/sources`)
          expect(Object.values(indexed.trace.approvals)).toContainEqual(
            expect.objectContaining({ permission: "atlas", reply: "once" }),
          )

          const artifacts = await ArtifactStore.list(Instance.project.id)
          expect(artifacts).toHaveLength(1)
          expect(artifacts[0]?.title).toBe("result.csv")
          expect(typeof artifacts[0]?.current.sessionID).toBe("string")
          const requested = outcomes.find((item) => item.scenario.id === "artifacts.requested-only")!
          expect(artifacts[0]?.current.sessionID).toBe(requested.session.id)
          expect(toolParts(requested.messages)).toContainEqual(
            expect.objectContaining({ tool: "artifact", state: expect.objectContaining({ status: "completed" }) }),
          )
        },
      })
    } finally {
      globalThis.fetch = fetch
      await fs.unlink(session).catch(() => undefined)
      provider.stop()
    }
  }, 180_000)
})
