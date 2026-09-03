import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { StressScenario } from "../../../../evals/cadence-harness/stress-matrix"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import {
  STRESS_PROVIDER_ID,
  STRESS_PROVIDER_MODEL,
  STRESS_SCENARIO_MARKER,
  startStressProvider,
  stressProviderConfig,
} from "../fixture/stress-provider"

// The model batches one call the turn withheld from a subagent (`task`), one
// the configuration denies (`bash`), two legacy alias names whose canonical
// tools were offered (`websearch`, `notebook`), and one it was actually
// offered (`glob`).
const scenario: StressScenario = {
  id: "batch-gating",
  category: "delegation",
  title: "Batch cannot widen the gated tool set",
  prompt: "Inspect the repository evidence and explain the relevant implementation path.",
  stimulus: {
    kind: "tool",
    name: "batch",
    input: {
      tool_calls: [
        {
          tool: "task",
          parameters: {
            description: "Escape the delegation gate",
            prompt: "Inspect the repository.",
            subagent_type: "explore",
          },
        },
        {
          tool: "bash",
          parameters: { command: "printf escaped > escaped", description: "Escape the permission gate" },
        },
        { tool: "websearch", parameters: { query: "escape the alias gate" } },
        {
          tool: "notebook",
          parameters: { code: "open('escaped', 'w').write('notebook')", timeout: 120_000 },
        },
        { tool: "glob", parameters: { pattern: "*" } },
      ],
    },
  },
  expect: { terminal: "completed", children: 0, artifacts: "none" },
}

function tools(messages: MessageV2.WithParts[]) {
  return messages.flatMap((message) => message.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool"))
}

describe("tool.batch gating", () => {
  test("a subagent cannot reach task, a config-denied tool, or an alias through batch", async () => {
    const provider = startStressProvider([scenario])
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          ...stressProviderConfig(`http://127.0.0.1:${provider.server.port}/v1`),
          experimental: { batch_tool: true },
          permission: { bash: "deny" },
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          await trustProject()
          await Provider.invalidate()
        },
        fn: async () => {
          const lead = await Session.create({ title: "Batch gating lead" })
          const child = await Session.create({ parentID: lead.id, title: scenario.title })
          const result = await SessionPrompt.prompt({
            sessionID: child.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
            agent: "research",
            effort: "normal",
            delegation: true,
            tools: { batch: true, bash: true, glob: true, python: true, research_search: true, task: true },
            system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
            parts: [{ type: "text", text: scenario.prompt }],
          })
          await provider.quiet()
          expect(result.info.role).toBe("assistant")
          if (result.info.role !== "assistant") throw new Error("Expected an assistant response")
          expect(result.info.error).toBeUndefined()

          // The aliases' canonical tools were offered to the model, so only the
          // alias names themselves keep the batched calls out.
          const offered = provider.main(scenario.id)[0]?.tools ?? []
          expect(offered).toContain("python")
          expect(offered).toContain("research_search")

          const parts = tools(await Session.messages({ sessionID: child.id }))
          expect(parts.find((part) => part.tool === "batch")?.state.status).toBe("completed")
          expect(parts.find((part) => part.tool === "glob")?.state.status).toBe("completed")
          const names = parts.map((part) => part.tool)
          expect(names).not.toContain("task")
          expect(names).not.toContain("bash")
          expect(names).not.toContain("websearch")
          expect(names).not.toContain("research_search")
          expect(names).not.toContain("notebook")
          expect(names).not.toContain("python")
          const rejected = parts
            .filter((part) => part.tool === "invalid")
            .map((part) => part.state.input)
            .toSorted((a, b) => String(a.tool).localeCompare(String(b.tool)))
          expect(rejected).toMatchObject([
            { tool: "bash", failure: "unknown_tool" },
            { tool: "notebook", failure: "unknown_tool" },
            { tool: "task", failure: "unknown_tool" },
            { tool: "websearch", failure: "unknown_tool" },
          ])
          expect(await Session.children(child.id)).toEqual([])
          const workspace = await SessionFilesystem.workspace(child.id)
          expect(await Bun.file(path.join(workspace, "escaped")).exists()).toBe(false)
        },
      })
    } finally {
      provider.stop()
    }
  }, 60_000)
})
