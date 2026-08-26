import { afterEach, test, expect, spyOn } from "bun:test"
import * as AI from "ai"
import { tmpdir, trustProject } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"
import { ProjectTrust } from "../../src/project/trust"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { Auth } from "../../src/auth"
import { OutboundTelemetry } from "../../src/telemetry/outbound"
import * as BillingGate from "../../src/session/billing-gate"

const restores: Array<{ mockRestore(): void }> = []

afterEach(() => {
  for (const restore of restores.splice(0)) restore.mockRestore()
})

// Helper to evaluate permission for a tool with wildcard pattern
function evalPerm(agent: Agent.Info | undefined, permission: string): PermissionNext.Action | undefined {
  if (!agent) return undefined
  return PermissionNext.evaluate(permission, "*", agent.permission).action
}

function generatedModel() {
  return {
    id: "anthropic/claude-test",
    providerID: "openrouter",
    api: { id: "anthropic/claude-test", npm: "@openrouter/ai-sdk-provider" },
    name: "Claude Test",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 100_000, output: 8_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  } as Provider.Model
}

function generationTelemetrySpies() {
  const sessionStarted = spyOn(OutboundTelemetry, "sessionStarted").mockResolvedValue(true)
  const userMessage = spyOn(OutboundTelemetry, "userMessage").mockResolvedValue(true)
  const modelRequest = spyOn(OutboundTelemetry, "modelRequest").mockResolvedValue(true)
  const modelResponse = spyOn(OutboundTelemetry, "modelResponse").mockResolvedValue(true)
  const error = spyOn(OutboundTelemetry, "error").mockResolvedValue(true)
  const sessionCompleted = spyOn(OutboundTelemetry, "sessionCompleted").mockResolvedValue(true)
  restores.push(sessionStarted, userMessage, modelRequest, modelResponse, error, sessionCompleted)
  return { sessionStarted, userMessage, modelRequest, modelResponse, error, sessionCompleted }
}

test("returns default native agents when no config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await Agent.list()
      const names = agents.map((a) => a.name)
      expect(names).toContain("research")
      expect(names).toContain("plan")
      expect(names).toContain("task")
      expect(names).toContain("explore")
      expect(names).toContain("compaction")
      expect(names).toContain("title")
    },
  })
})

test("research agent has correct default properties", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const research = await Agent.get("research")
      expect(research).toBeDefined()
      expect(research?.mode).toBe("primary")
      expect(research?.native).toBe(true)
      expect(evalPerm(research, "edit")).toBe("allow")
      expect(evalPerm(research, "bash")).toBe("allow")
    },
  })
})

test("domain agents are delegated specialists instead of competing primary modes", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect((await Agent.get("biology"))?.mode).toBe("subagent")
      expect((await Agent.get("physics"))?.mode).toBe("subagent")
      expect((await Agent.get("ml"))?.mode).toBe("subagent")
      expect((await Agent.get("biology"))?.hidden).toBe(true)
      expect((await Agent.get("physics"))?.hidden).toBe(true)
      expect((await Agent.get("ml"))?.hidden).toBe(true)
    },
  })
})

test("Research is the only built-in user-facing primary", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const visiblePrimary = (await Agent.list())
        .filter((agent) => agent.native && agent.mode !== "subagent" && agent.hidden !== true)
        .map((agent) => agent.name)
      expect(visiblePrimary).toEqual(["research"])
      expect((await Agent.get("plan"))?.hidden).toBe(true)
    },
  })
})

test("thin research profile is absent unless the explicit dev flag is enabled", async () => {
  const previous = process.env.OPENSCIENCE_ENABLE_RESEARCH_AGENT_TEST
  try {
    delete process.env.OPENSCIENCE_ENABLE_RESEARCH_AGENT_TEST
    await using production = await tmpdir()
    await Instance.provide({
      directory: production.path,
      fn: async () => expect(await Agent.get("researchagent-test")).toBeUndefined(),
    })

    process.env.OPENSCIENCE_ENABLE_RESEARCH_AGENT_TEST = "1"
    await using laboratory = await tmpdir()
    await Instance.provide({
      directory: laboratory.path,
      fn: async () => {
        const thin = await Agent.get("researchagent-test")
        expect(thin).toMatchObject({ name: "researchagent-test", mode: "primary", native: true })
        expect(thin?.prompt).toContain("collaborative research agent")
        expect(evalPerm(thin, "research_contract")).toBe("deny")
      },
    })
  } finally {
    if (previous === undefined) delete process.env.OPENSCIENCE_ENABLE_RESEARCH_AGENT_TEST
    else process.env.OPENSCIENCE_ENABLE_RESEARCH_AGENT_TEST = previous
  }
})

test("built-in delegation uses only Explore and Execute profiles", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const profiles = (await Promise.all([Agent.get("execute"), Agent.get("explore")])).map((agent) => agent?.name)
      expect(profiles).toEqual(["execute", "explore"])
      expect((await Agent.get("execute"))?.hidden).toBe(true)
      expect((await Agent.get("explore"))?.hidden).toBe(true)
      expect(evalPerm(await Agent.get("execute"), "edit")).toBe("allow")
      expect((await Agent.get("explore"))?.steps).toBe(12)
      expect((await Agent.get("execute"))?.steps).toBe(16)
      expect(await Agent.get("review")).toBeUndefined()
      expect(await Agent.get("reviewer")).toBeUndefined()
      expect(await Agent.get("artifact-reviewer")).toBeUndefined()
    },
  })
})

test("removed reviewer aliases cannot be restored by persisted agent config", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        review: { description: "legacy review alias" },
        reviewer: { description: "legacy reviewer" },
        "artifact-reviewer": { description: "legacy artifact reviewer" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      expect(await Agent.get("review")).toBeUndefined()
      expect(await Agent.get("reviewer")).toBeUndefined()
      expect(await Agent.get("artifact-reviewer")).toBeUndefined()
    },
  })
})

test("plan agent denies edits except .openscience/plans/*", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await Agent.get("plan")
      expect(plan).toBeDefined()
      // Wildcard is denied
      expect(evalPerm(plan, "edit")).toBe("deny")
      // But specific path is allowed
      expect(PermissionNext.evaluate("edit", ".openscience/plans/foo.md", plan!.permission).action).toBe("allow")
    },
  })
})

test("explore agent denies edit and write", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeDefined()
      expect(explore?.mode).toBe("subagent")
      expect(evalPerm(explore, "edit")).toBe("deny")
      expect(evalPerm(explore, "write")).toBe("deny")
      expect(evalPerm(explore, "webfetch")).toBe("ask")
      expect(evalPerm(explore, "network")).toBe("ask")
      expect(evalPerm(explore, "todoread")).toBe("deny")
      expect(evalPerm(explore, "todowrite")).toBe("deny")
    },
  })
})

test("task agent denies todo tools", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const task = await Agent.get("task")
      expect(task).toBeDefined()
      expect(task?.mode).toBe("subagent")
      expect(task?.hidden).toBe(true)
      expect(evalPerm(task, "todoread")).toBe("deny")
      expect(evalPerm(task, "todowrite")).toBe("deny")
    },
  })
})

test("compaction agent denies all permissions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const compaction = await Agent.get("compaction")
      expect(compaction).toBeDefined()
      expect(compaction?.hidden).toBe(true)
      expect(evalPerm(compaction, "bash")).toBe("deny")
      expect(evalPerm(compaction, "edit")).toBe("deny")
      expect(evalPerm(compaction, "read")).toBe("deny")
    },
  })
})

test("untrusted project agent configuration stays inert", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "repo-agent",
      permission: { bash: "deny" },
      agent: {
        "repo-agent": {
          mode: "primary",
          prompt: "repository-controlled",
        },
        research: {
          prompt: "repository-controlled",
          color: "#FF0000",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
      expect(await Agent.get("repo-agent")).toBeUndefined()
      const research = await Agent.get("research")
      expect(research?.prompt).toBeUndefined()
      expect(research?.color).toBe("#d48765")
      expect(evalPerm(research, "bash")).toBe("ask")
      expect(await Agent.defaultAgent()).toBe("research")
    },
  })
})

test("custom agent from config creates new agent", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const custom = await Agent.get("my_custom_agent")
      expect(custom).toBeDefined()
      expect(custom?.model?.providerID).toBe("openai")
      expect(custom?.model?.modelID).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    },
  })
})

test("legacy docs config remains a subagent", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        docs: {
          description: "Documentation specialist",
          mode: "all",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const docs = await Agent.get("docs")
      expect(docs?.mode).toBe("subagent")
      expect(docs?.description).toBe("Documentation specialist")
    },
  })
})

test("custom agent config overrides native agent properties", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        research: {
          model: "anthropic/claude-3",
          description: "Custom research agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const research = await Agent.get("research")
      expect(research).toBeDefined()
      expect(research?.model?.providerID).toBe("anthropic")
      expect(research?.model?.modelID).toBe("claude-3")
      expect(research?.description).toBe("Custom research agent")
      expect(research?.temperature).toBe(0.7)
      expect(research?.color).toBe("#FF0000")
      expect(research?.native).toBe(true)
    },
  })
})

test("agent disable removes agent from list", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const explore = await Agent.get("explore")
      expect(explore).toBeUndefined()
      const agents = await Agent.list()
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("explore")
    },
  })
})

test("agent permission config merges with defaults", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        research: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const research = await Agent.get("research")
      expect(research).toBeDefined()
      // Specific pattern is denied
      expect(PermissionNext.evaluate("bash", "rm -rf *", research!.permission).action).toBe("deny")
      // Edit still allowed
      expect(evalPerm(research, "edit")).toBe("allow")
    },
  })
})

test("global permission config applies to all agents", async () => {
  await using tmp = await tmpdir({
    config: {
      permission: {
        bash: "deny",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const research = await Agent.get("research")
      expect(research).toBeDefined()
      expect(evalPerm(research, "bash")).toBe("deny")
    },
  })
})

test("agent steps/maxSteps config sets steps property", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        research: { steps: 50 },
        plan: { maxSteps: 100 },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const research = await Agent.get("research")
      const plan = await Agent.get("plan")
      expect(research?.steps).toBe(50)
      expect(plan?.steps).toBe(100)
    },
  })
})

test("agent mode can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { mode: "primary" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const explore = await Agent.get("explore")
      expect(explore?.mode).toBe("primary")
    },
  })
})

test("agent name can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        research: { name: "Builder" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const research = await Agent.get("research")
      expect(research?.name).toBe("Builder")
    },
  })
})

test("agent prompt can be set from config", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        research: { prompt: "Custom system prompt" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const research = await Agent.get("research")
      expect(research?.prompt).toBe("Custom system prompt")
    },
  })
})

test("unknown agent properties are placed into options", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        research: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const research = await Agent.get("research")
      expect(research?.options.random_property).toBe("hello")
      expect(research?.options.another_random).toBe(123)
    },
  })
})

test("agent options merge correctly", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        research: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const research = await Agent.get("research")
      expect(research?.options.custom_option).toBe(true)
      expect(research?.options.another_option).toBe("value")
    },
  })
})

test("multiple custom agents can be defined", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const agentA = await Agent.get("agent_a")
      const agentB = await Agent.get("agent_b")
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    },
  })
})

test("Agent.get returns undefined for non-existent agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const nonExistent = await Agent.get("does_not_exist")
      expect(nonExistent).toBeUndefined()
    },
  })
})

test("fresh Approve mode auto-allows safe sandboxed work and asks at external boundaries", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const research = await Agent.get("research")
      expect(evalPerm(research, "edit")).toBe("allow")
      expect(evalPerm(research, "bash")).toBe("allow")
      expect(evalPerm(research, "network")).toBe("ask")
      expect(evalPerm(research, "websearch")).toBe("ask")
      expect(evalPerm(research, "mcp")).toBe("ask")
      expect(evalPerm(research, "external_directory")).toBe("ask")
      expect(evalPerm(research, "compute_job")).toBe("ask")
      expect(PermissionNext.evaluate("read", ".env", research!.permission).action).toBe("ask")
    },
  })
})

test("persisted Ask mode overrides built-in subagent convenience allows", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
      Agent.invalidate()
      expect(await ProjectTrust.status(Instance.project)).toMatchObject({ source: "persisted", state: "revoked" })
      const research = await Agent.get("research")
      const explore = await Agent.get("explore")
      expect(evalPerm(research, "edit")).toBe("ask")
      expect(evalPerm(explore, "edit")).toBe("deny")
      for (const permission of ["bash", "network", "webfetch", "websearch"]) {
        expect(evalPerm(research, permission)).toBe("ask")
        expect(evalPerm(explore, permission)).toBe("ask")
      }
      expect(evalPerm(research, "external_directory")).toBe("ask")
      expect(evalPerm(explore, "external_directory")).toBe("deny")
    },
  })
})

test("explicit Full mode removes file command and internet approval prompts", async () => {
  const previous = await Config.trustedSandbox()
  await Config.setSandbox({ enabled: false })
  try {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await Agent.get("research")
        for (const permission of ["edit", "bash", "network", "webfetch", "websearch", "external_directory"]) {
          expect(evalPerm(research, permission)).toBe("allow")
        }
        expect(PermissionNext.evaluate("read", ".env", research!.permission).action).toBe("allow")
      },
    })
  } finally {
    await Config.setSandbox(previous)
  }
})

test("legacy tools config converts to permissions", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        research: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const research = await Agent.get("research")
      expect(evalPerm(research, "bash")).toBe("deny")
      expect(evalPerm(research, "read")).toBe("deny")
    },
  })
})

test("legacy tools config maps write/edit/patch/multiedit to edit permission", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        research: {
          tools: {
            write: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const research = await Agent.get("research")
      expect(evalPerm(research, "edit")).toBe("deny")
    },
  })
})

test("a global external_directory deny also protects the tool-output broker", async () => {
  const { Truncate } = await import("../../src/tool/truncation")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: "deny",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const research = await Agent.get("research")
      expect(PermissionNext.evaluate("external_directory", Truncate.DIR, research!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("external_directory", Truncate.GLOB, research!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("external_directory", "/some/other/path", research!.permission).action).toBe(
        "deny",
      )
    },
  })
})

test("a per-agent external_directory deny also protects the tool-output broker", async () => {
  const { Truncate } = await import("../../src/tool/truncation")
  await using tmp = await tmpdir({
    config: {
      agent: {
        research: {
          permission: {
            external_directory: "deny",
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const research = await Agent.get("research")
      expect(PermissionNext.evaluate("external_directory", Truncate.DIR, research!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("external_directory", Truncate.GLOB, research!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("external_directory", "/some/other/path", research!.permission).action).toBe(
        "deny",
      )
    },
  })
})

test("explicit Truncate.DIR deny is respected", async () => {
  const { Truncate } = await import("../../src/tool/truncation")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: {
          "*": "deny",
          [Truncate.DIR]: "deny",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const research = await Agent.get("research")
      expect(PermissionNext.evaluate("external_directory", Truncate.DIR, research!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("external_directory", Truncate.GLOB, research!.permission).action).toBe("deny")
    },
  })
})

test("defaultAgent returns first primary visible agent when no default_agent config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.defaultAgent()
      expect(agent).toBe("research")
    },
  })
})

test("defaultAgent respects default_agent config set to plan", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "plan",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const agent = await Agent.defaultAgent()
      expect(agent).toBe("plan")
    },
  })
})

test("defaultAgent respects default_agent config set to custom agent with mode all", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "my_custom",
      agent: {
        my_custom: {
          description: "My custom agent",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const agent = await Agent.defaultAgent()
      expect(agent).toBe("my_custom")
    },
  })
})

test("defaultAgent throws when default_agent points to subagent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "explore",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      await expect(Agent.defaultAgent()).rejects.toThrow('default agent "explore" is a subagent')
    },
  })
})

test("defaultAgent throws when default_agent points to hidden agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "compaction",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      await expect(Agent.defaultAgent()).rejects.toThrow('default agent "compaction" is hidden')
    },
  })
})

test("defaultAgent throws when default_agent points to non-existent agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "does_not_exist",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      await expect(Agent.defaultAgent()).rejects.toThrow('default agent "does_not_exist" not found')
    },
  })
})

test("defaultAgent does not silently replace disabled research with plan mode", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        research: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      await expect(Agent.defaultAgent()).rejects.toThrow("no primary visible agent found")
    },
  })
})

test("defaultAgent throws when all primary visible agents are disabled", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        research: { disable: true },
        biology: { disable: true },
        physics: { disable: true },
        ml: { disable: true },
        plan: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      await expect(Agent.defaultAgent()).rejects.toThrow("no primary visible agent found")
    },
  })
})

test("agent configuration generation emits one canonical ephemeral model trace and disables AI SDK telemetry", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = generatedModel()
      const telemetry = generationTelemetrySpies()
      const getModel = spyOn(Provider, "getModel").mockResolvedValue(model)
      const getLanguage = spyOn(Provider, "getLanguage").mockResolvedValue({} as never)
      const credential = spyOn(BillingGate, "resolveCredentialSource").mockResolvedValue("byok")
      const auth = spyOn(Auth, "get").mockImplementation(async () => undefined as never)
      const generate = spyOn(AI, "generateObject").mockResolvedValue({
        object: { identifier: "reviewer", whenToUse: "Review a result", systemPrompt: "Check every claim." },
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        finishReason: "stop",
      } as never)
      restores.push(getModel, getLanguage, credential, auth, generate)

      const output = await Agent.generate({
        description: "Create a careful reviewer",
        model: { providerID: "requested-provider", modelID: "requested-model" },
      })

      expect(output).toEqual({
        identifier: "reviewer",
        whenToUse: "Review a result",
        systemPrompt: "Check every claim.",
      })
      expect(generate).toHaveBeenCalledTimes(1)
      expect(generate.mock.calls[0]?.[0]).toMatchObject({
        experimental_telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
        temperature: 0.3,
      })
      const started = telemetry.sessionStarted.mock.calls[0]?.[0]
      const user = telemetry.userMessage.mock.calls[0]?.[0]
      const request = telemetry.modelRequest.mock.calls[0]?.[0]
      const response = telemetry.modelResponse.mock.calls[0]?.[0]
      expect(started?.sessionID).toMatch(/^agent-config:/)
      expect(started?.session).toMatchObject({ purpose: "agent_config_generation", ephemeral: true })
      expect(user).toMatchObject({
        sessionID: started?.sessionID,
        message: { role: "user", purpose: "agent_config_generation" },
        parts: [{ type: "text", text: "Create a careful reviewer" }],
      })
      expect(request).toMatchObject({
        sessionID: started?.sessionID,
        messageID: user?.messageID,
        attempt: 1,
        route: "byok",
        provider: "openrouter",
        model: "anthropic/claude-test",
        parameters: { purpose: "agent_config_generation", structuredOutput: true, streaming: false },
      })
      expect(response).toMatchObject({
        sessionID: started?.sessionID,
        messageID: user?.messageID,
        route: "byok",
        provider: "openrouter",
        model: "anthropic/claude-test",
        parts: [{ type: "json", value: output }],
      })
      expect(telemetry.error).not.toHaveBeenCalled()
      expect(telemetry.sessionCompleted).toHaveBeenCalledWith({
        sessionID: started?.sessionID,
        reason: "completed",
        session: { purpose: "agent_config_generation", source: "cli", ephemeral: true },
      })
    },
  })
})

test("OAuth configuration generation traces the streamObject response without provider telemetry", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const output = { identifier: "planner", whenToUse: "Plan work", systemPrompt: "Plan carefully." }
      const model = { ...generatedModel(), id: "gpt-test", providerID: "openai" }
      const telemetry = generationTelemetrySpies()
      const getModel = spyOn(Provider, "getModel").mockResolvedValue(model)
      const getLanguage = spyOn(Provider, "getLanguage").mockResolvedValue({} as never)
      const credential = spyOn(BillingGate, "resolveCredentialSource").mockResolvedValue("oauth-free")
      const auth = spyOn(Auth, "get").mockResolvedValue({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: Date.now() + 60_000,
      })
      const generate = spyOn(AI, "generateObject")
      const stream = spyOn(AI, "streamObject").mockReturnValue({
        object: Promise.resolve(output),
        usage: Promise.resolve({ inputTokens: 20, outputTokens: 10, totalTokens: 30 }),
        finishReason: Promise.resolve("stop"),
        fullStream: (async function* () {
          yield { type: "finish" }
        })(),
      } as never)
      restores.push(getModel, getLanguage, credential, auth, generate, stream)

      expect(
        await Agent.generate({
          description: "Create a planning agent",
          model: { providerID: "openai", modelID: "gpt-test" },
        }),
      ).toEqual(output)

      expect(generate).not.toHaveBeenCalled()
      expect(stream).toHaveBeenCalledTimes(1)
      expect(stream.mock.calls[0]?.[0]).toMatchObject({
        experimental_telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
      })
      expect(telemetry.modelRequest.mock.calls[0]?.[0]).toMatchObject({
        route: "subscription",
        provider: "openai",
        model: "gpt-test",
        parameters: { purpose: "agent_config_generation", streaming: true },
      })
      expect(telemetry.modelResponse.mock.calls[0]?.[0]).toMatchObject({
        route: "subscription",
        provider: "openai",
        model: "gpt-test",
        parts: [{ type: "json", value: output }],
      })
      expect(telemetry.error).not.toHaveBeenCalled()
    },
  })
})

test("agent configuration generation records provider errors under the model request span", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = generatedModel()
      const telemetry = generationTelemetrySpies()
      const getModel = spyOn(Provider, "getModel").mockResolvedValue(model)
      const getLanguage = spyOn(Provider, "getLanguage").mockResolvedValue({} as never)
      const credential = spyOn(BillingGate, "resolveCredentialSource").mockResolvedValue("managed")
      const auth = spyOn(Auth, "get").mockImplementation(async () => undefined as never)
      const failure = new Error("provider failed")
      const generate = spyOn(AI, "generateObject").mockRejectedValue(failure)
      restores.push(getModel, getLanguage, credential, auth, generate)

      await expect(
        Agent.generate({
          description: "Create a careful reviewer",
          model: { providerID: "requested-provider", modelID: "requested-model" },
        }),
      ).rejects.toThrow("provider failed")

      const request = telemetry.modelRequest.mock.calls[0]?.[0]
      expect(telemetry.modelResponse).not.toHaveBeenCalled()
      expect(telemetry.error).toHaveBeenCalledTimes(1)
      expect(telemetry.error.mock.calls[0]?.[0]).toMatchObject({
        sessionID: request?.sessionID,
        messageID: request?.messageID,
        attempt: 1,
        parentSpanID: `${request?.messageID}:model:1:request`,
        route: "managed",
        provider: "openrouter",
        model: "anthropic/claude-test",
        error: failure,
        context: { purpose: "agent_config_generation", phase: "model_generation" },
      })
      expect(telemetry.sessionCompleted.mock.calls[0]?.[0]).toMatchObject({
        sessionID: request?.sessionID,
        reason: "error",
      })
    },
  })
})
