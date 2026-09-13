import { expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Agent } from "../../src/agent/agent"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionHarness } from "../../src/session/harness"
import { LLM } from "../../src/session/llm"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionTraceStore } from "../../src/session/trace-store"
import { Toolset } from "../../src/session/toolset"
import { ToolRegistry } from "../../src/tool/registry"
import { ToolVisibility } from "../../src/tool/visibility"
import type { PermissionNext } from "../../src/permission/next"
import { Flag } from "../../src/flag/flag"
import { tmpdir, trustProject } from "../fixture/fixture"
import { stressProviderConfig } from "../fixture/stress-provider"

test("tool availability notices omit initial/unchanged catalogs and bound changed names", () => {
  expect(Toolset.notice(["read", "write"])).toBeUndefined()
  expect(Toolset.notice(["write", "read"], ["read", "write"])).toBeUndefined()
  expect(Toolset.active({ read: {}, invalid: {}, fixture_extension: {} })).toEqual(["read", "fixture_extension"])
  const notice = Toolset.notice(
    Array.from({ length: 500 }, (_, index) => `new_${index}`),
    Array.from({ length: 500 }, (_, index) => `old_${index}`),
  )!
  expect(notice.length).toBeLessThan(1_024)
  expect(notice).toContain("480 more")
  expect(notice).not.toContain("new_499")
  expect(notice).toContain("not filesystem or execution authority")
})

test("retries and internal compaction preserve the preceding agent snapshot", async () => {
  const make = async (messageID: string, profile: string, names: string[]) => ({
    ...(await SessionHarness.snapshot({
      agent: { name: profile, mode: "primary" },
      provider: "fixture",
      model: "fixture",
      system: [],
      tools: Object.fromEntries(names.map((name) => [name, tool({ inputSchema: jsonSchema({ type: "object" }) })])),
    })),
    messageID,
    parentMessageID: "msg_user",
    attempt: 1,
    createdAt: 1,
  })
  const records = [
    await make("msg_before", "research", ["read", "invalid"]),
    await make("msg_compact", "compaction", []),
    await make("msg_current", "research", ["read", "write", "invalid"]),
  ]
  expect(Toolset.previous(records, { messageID: "msg_current", profile: "research", mode: "primary" })).toEqual([
    "read",
  ])
  expect(Toolset.previous(records, { messageID: "msg_new", profile: "research", mode: "primary" })).toEqual([
    "read",
    "write",
  ])
})

test("actual provider requests and durable snapshots agree after model, mask and permission changes", async () => {
  const captured: Array<{ tools?: Array<{ function: { name: string } }>; messages: unknown }> = []
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions")
      captured.push(await request.json())
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-toolset",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      return new Response(
        chunk({ role: "assistant", content: "FIXTURE_COMPLETE" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const config = stressProviderConfig(`${server.url.origin}/v1`)
  await using tmp = await tmpdir({
    git: true,
    config: {
      ...config,
      provider: {
        stress: {
          ...config.provider.stress,
          models: {
            "gpt-snapshot": { name: "GPT fixture", tool_call: true, limit: { context: 128_000, output: 4_096 } },
            "claude-snapshot": { name: "Claude fixture", tool_call: true, limit: { context: 128_000, output: 4_096 } },
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: trustProject,
    fn: async () => {
      const session = await Session.create({ title: "Tool availability fixture" })
      const research = await Agent.get("research")
      if (!research) throw new Error("missing fixture agent")
      const invoke = async (
        modelID: string,
        masked = false,
        messageID = Identifier.ascending("message"),
        attempt = 1,
      ) => {
        const model = await Provider.getModel("stress", modelID)
        const agent: Agent.Info = {
          ...research,
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            ...(masked ? [{ permission: "read", pattern: "*", action: "deny" } as const] : []),
          ],
        }
        const definitions = await ToolRegistry.tools({ providerID: "stress", modelID }, agent, (id) =>
          ["read", "write", "edit", "apply_patch"].includes(id),
        )
        const tools = Object.fromEntries(
          definitions.map((item) => [
            item.id,
            tool({
              description: item.description,
              inputSchema: SessionPrompt.toolInputSchema(model, item),
            }),
          ]),
        )
        tools.fixture_extension = tool({
          description: "HIDDEN_EXTENSION_DESCRIPTION",
          inputSchema: jsonSchema({ type: "object" }),
        })
        tools.invalid = tool({ description: "INTERNAL_REPAIR_ONLY", inputSchema: jsonSchema({ type: "object" }) })
        const user: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          agent: agent.name,
          effort: "normal",
          time: { created: Date.now() },
          model: { providerID: model.providerID, modelID: model.id },
          tools: { fixture_extension: false, ...(masked ? { write: false } : {}) },
        }
        const stream = await LLM.stream({
          user,
          sessionID: session.id,
          model,
          agent,
          system: [],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Continue the existing assignment." }],
          tools,
          trace: { messageID, attempt },
          route: "fixture",
          retries: 0,
        })
        const errors = []
        for await (const event of stream.fullStream) if (event.type === "error") errors.push(event.error)
        expect(errors).toEqual([])
        const request = captured.at(-1)!
        const names = (request.tools ?? []).map((entry) => entry.function.name).toSorted()
        const record = (await SessionTraceStore.read(session.id)).harness.at(-1)!
        expect(record.messageID).toBe(messageID)
        expect(record.model).toBe(modelID)
        expect(record.tools.map((entry) => entry.name).filter((name) => name !== "invalid")).toEqual(names)
        expect(JSON.stringify(request)).not.toContain("HIDDEN_EXTENSION_DESCRIPTION")
        expect(JSON.stringify(request)).not.toContain("INTERNAL_REPAIR_ONLY")
        return { names, messages: JSON.stringify(request.messages), messageID }
      }
      try {
        const first = await invoke("gpt-snapshot")
        expect(first.names).toEqual(["apply_patch", "read"])
        expect(first.messages).not.toContain("Tool availability changed")
        const switched = await invoke("claude-snapshot")
        expect(switched.names).toEqual(["edit", "read", "write"])
        expect(switched.messages).toContain('Added tools: [\\"edit\\", \\"write\\"]')
        expect(switched.messages).toContain('Removed tools: [\\"apply_patch\\"]')
        expect((await invoke("claude-snapshot")).messages).not.toContain("Tool availability changed")
        const masked = await invoke("claude-snapshot", true)
        expect(masked.names).toEqual(["edit"])
        expect(masked.messages).toContain('Removed tools: [\\"read\\", \\"write\\"]')
        const restored = await invoke("claude-snapshot")
        const retried = await invoke("claude-snapshot", false, restored.messageID, 2)
        expect(restored.messages).toContain('Added tools: [\\"read\\", \\"write\\"]')
        expect(retried.messages).toBe(restored.messages)
        expect(captured).toHaveLength(6)
      } finally {
        await Session.remove(session.id)
        await Instance.dispose()
      }
    },
  })
})

test("research is offered exactly the default set by permission, with no keyword selection", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const research = await Agent.get("research")
      if (!research) throw new Error("missing research agent")
      const ids = async (
        modelID: string,
        options: { unlocked?: Set<string>; ruleset?: PermissionNext.Ruleset } = {},
      ) => {
        const permission = options.ruleset ?? research.permission
        const tools = await ToolRegistry.tools(
          { providerID: "anthropic", modelID },
          research,
          (id) => ToolVisibility.enabled(id, { permission }),
          undefined,
          options.unlocked,
        )
        return tools.map((tool) => tool.id).toSorted()
      }
      // question needs a client that can ask; research_search needs a search provider.
      const base = [
        "artifact",
        "bash",
        "compute_job",
        "glob",
        "grep",
        "invalid",
        "literature",
        "python",
        "read",
        "recall",
        "skill",
        "task",
        "todowrite",
        "webfetch",
      ]
      const interactive = ["app", "cli", "desktop"].includes(Flag.OPENSCIENCE_CLIENT) ? ["question"] : []
      expect(await ids("claude-fable-5.1")).toEqual([...base, "edit", "write", ...interactive].toSorted())
      expect(await ids("gpt-5.6-sol")).toEqual([...base, "apply_patch", ...interactive].toSorted())
      // A loaded skill unlocks its tools for the rest of the task epoch.
      const messages: MessageV2.WithParts[] = [
        {
          info: {
            id: "msg_a",
            sessionID: "ses_x",
            role: "assistant",
            parentID: "msg_u",
            mode: "research",
            agent: "research",
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "m",
            providerID: "p",
            time: { created: 1 },
          },
          parts: [
            {
              id: "prt_skill",
              sessionID: "ses_x",
              messageID: "msg_a",
              type: "tool",
              tool: "skill",
              callID: "call_skill",
              state: {
                status: "completed",
                input: { name: "r-analysis" },
                title: "r-analysis",
                output: "",
                metadata: { allowedTools: ["r"] },
                time: { start: 1, end: 2 },
              },
            },
          ],
        },
      ]
      const activation = ToolVisibility.activation(messages)
      expect([...activation.tools]).toEqual(["r"])
      expect(await ids("claude-fable-5.1", { unlocked: activation.tools })).toContain("r")
      // The session ruleset can hide a default tool: a headless run denies question.
      const denied = [...research.permission, { permission: "question", pattern: "*", action: "deny" as const }]
      expect(await ids("claude-fable-5.1", { ruleset: denied })).not.toContain("question")
      // A specialist's own allow rules opt its domain tools in without a skill.
      const biology = await Agent.get("biology")
      const biologyTools = (
        await ToolRegistry.tools({ providerID: "anthropic", modelID: "claude" }, biology!, (id) =>
          ToolVisibility.enabled(id, { permission: biology!.permission }),
        )
      ).map((tool) => tool.id)
      expect(biologyTools).toContain("query_uniprot")
      expect(biologyTools).toContain("science_fetch")
      expect(biologyTools).not.toContain("task")
      expect(biologyTools).not.toContain("todowrite")
      expect(biologyTools).not.toContain("question")
    },
  })
})
