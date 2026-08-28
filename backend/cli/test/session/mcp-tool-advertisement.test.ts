import { describe, expect, test } from "bun:test"
import type { StressScenario } from "../../../../evals/cadence-harness/stress-matrix"
import { tmpdir } from "../fixture/fixture"
import { spawn } from "../fixture/spawn"
import {
  STRESS_PROVIDER_ID,
  STRESS_PROVIDER_MODEL,
  STRESS_SCENARIO_MARKER,
  startStressProvider,
  stressProviderConfig,
} from "../fixture/stress-provider"

const scenarios: StressScenario[] = [
  {
    id: "mcp-normal-research",
    category: "chat",
    title: "Connected MCP in normal Research",
    prompt: "Research the connected lab records and write a concise evidence report.",
    stimulus: { kind: "inspect", target: "tools" },
    expect: { terminal: "completed", children: 0, artifacts: "none" },
  },
  {
    id: "mcp-direct-answer",
    category: "chat",
    title: "Direct answer stays thin",
    prompt: "What is a p-value?",
    stimulus: { kind: "inspect", target: "tools" },
    expect: { terminal: "completed", children: 0, artifacts: "none" },
  },
  {
    id: "mcp-wildcard-disabled",
    category: "chat",
    title: "All turn tools disabled",
    prompt: "Research the connected lab records and write a concise evidence report.",
    stimulus: { kind: "inspect", target: "tools" },
    expect: { terminal: "completed", children: 0, artifacts: "none" },
  },
  {
    id: "mcp-tool-disabled",
    category: "chat",
    title: "Connected MCP tool disabled",
    prompt: "Research the connected lab records and write a concise evidence report.",
    stimulus: { kind: "inspect", target: "tools" },
    expect: { terminal: "completed", children: 0, artifacts: "none" },
  },
  {
    id: "mcp-permission-denied",
    category: "permissions",
    title: "MCP permission denied",
    prompt: "Research the connected lab records and write a concise evidence report.",
    stimulus: { kind: "inspect", target: "tools" },
    expect: { terminal: "completed", children: 0, artifacts: "none" },
  },
  {
    id: "mcp-local-inspection",
    category: "chat",
    title: "Local inspection stays thin",
    prompt: "Inspect package.json and report its package name. Do not modify any files.",
    stimulus: { kind: "inspect", target: "tools" },
    expect: { terminal: "completed", children: 0, artifacts: "none" },
  },
]

describe("MCP tools at the provider boundary", () => {
  test("advertises configured MCP tools only on eligible Research turns", async () => {
    const local = startStressProvider(scenarios)
    const collision = new URL("../fixture/mcp-native-collision.mjs", import.meta.url).pathname
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          ...stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`),
          mcp: {
            research: {
              type: "local",
              command: [process.execPath, collision],
            },
          },
        },
      })
      const runner = `${tmp.path}/mcp-provider-boundary.ts`
      await Bun.write(
        runner,
        `
import { MCP } from ${JSON.stringify(new URL("../../src/mcp/index.ts", import.meta.url).href)}
import { Provider } from ${JSON.stringify(new URL("../../src/provider/provider.ts", import.meta.url).href)}
import { Instance } from ${JSON.stringify(new URL("../../src/project/instance.ts", import.meta.url).href)}
import { ProjectTrust } from ${JSON.stringify(new URL("../../src/project/trust.ts", import.meta.url).href)}
import { Session } from ${JSON.stringify(new URL("../../src/session/index.ts", import.meta.url).href)}
import { SessionPrompt } from ${JSON.stringify(new URL("../../src/session/prompt.ts", import.meta.url).href)}

const scenarios = ${JSON.stringify(scenarios)}

await Instance.provide({
  directory: process.argv[2],
  init: async () => {
    const trust = await ProjectTrust.status(Instance.project)
    await ProjectTrust.update(Instance.project, { trusted: true, root: trust.root })
    await Provider.invalidate()
  },
  fn: async () => {
    try {
      const status = await MCP.status()
      if (status.research?.status !== "connected") throw new Error(JSON.stringify(status))
      for (const scenario of scenarios) {
        const session = await Session.create({
          title: scenario.title,
          permission:
            scenario.id === "mcp-permission-denied"
              ? [{ permission: "mcp", pattern: "*", action: "deny" }]
              : undefined,
        })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: ${JSON.stringify(STRESS_PROVIDER_ID)}, modelID: ${JSON.stringify(STRESS_PROVIDER_MODEL)} },
          agent: "research",
          effort: "normal",
          delegation: false,
          system: ${JSON.stringify(STRESS_SCENARIO_MARKER)} + scenario.id,
          parts: [{ type: "text", text: scenario.prompt }],
          tools:
            scenario.id === "mcp-wildcard-disabled"
              ? { "*": false }
              : scenario.id === "mcp-tool-disabled"
                ? { research_echo: false }
                : undefined,
        })
      }
    } finally {
      await MCP.disposeLocal()
    }
  },
})
`,
      )

      const proc = spawn([process.execPath, runner, tmp.path], {
        cwd: tmp.path,
        stdout: "ignore",
        stderr: "pipe",
      })
      const [error, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      expect(exit, error).toBe(0)

      await local.quiet()
      const normal = local.main("mcp-normal-research")[0]
      const direct = local.main("mcp-direct-answer")[0]
      const wildcardDisabled = local.main("mcp-wildcard-disabled")[0]
      const toolDisabled = local.main("mcp-tool-disabled")[0]
      const permissionDenied = local.main("mcp-permission-denied")[0]
      const localInspection = local.main("mcp-local-inspection")[0]
      if (!normal || !direct || !wildcardDisabled || !toolDisabled || !permissionDenied || !localInspection)
        throw new Error("Missing provider request")

      expect(normal.tools).toContain("research_echo")
      const providerTools = Array.isArray(normal.body.tools)
        ? (normal.body.tools as Array<{
            function?: { name?: unknown; description?: unknown }
          }>)
        : []
      const researchSearch = providerTools.find((item) => item.function?.name === "research_search")
      expect(normal.tools.filter((name) => name === "research_search")).toHaveLength(1)
      expect(researchSearch?.function?.description).toContain("Search for current web, research, news")
      expect(researchSearch?.function?.description).not.toContain("MCP collision fixture")
      expect(direct.tools).not.toContain("research_echo")
      expect(direct.tools).toEqual([])
      expect(wildcardDisabled.tools).not.toContain("research_echo")
      expect(wildcardDisabled.tools).toEqual([])
      expect(toolDisabled.tools).not.toContain("research_echo")
      expect(permissionDenied.tools).not.toContain("research_echo")
      expect(localInspection.tools).not.toContain("research_echo")
      expect(localInspection.tools).toContain("read")
    } finally {
      local.stop()
    }
  }, 20_000)
})
