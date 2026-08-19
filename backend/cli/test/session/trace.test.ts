import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionTrace } from "../../src/session/trace"
import { SessionTraceStore } from "../../src/session/trace-store"
import { LLM } from "../../src/session/llm"
import { SessionHarness } from "../../src/session/harness"
import { SessionResearch } from "../../src/session/research"
import { Provenance } from "../../src/science/provenance/store"
import { Review } from "../../src/science/provenance/review"
import { tmpdir } from "../fixture/fixture"

test("builds one local observable harness trace without reasoning or copied outputs", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "Trace contract" })
      const started = Date.now()
      const user: MessageV2.User = {
        id: "msg_trace_user",
        sessionID: session.id,
        role: "user",
        effort: "ultra",
        time: { created: started },
        agent: "research",
        model: { providerID: "openai-codex", modelID: "gpt-5" },
        inference: { source: "chatgpt", effort: "default" },
      }
      const assistant: MessageV2.Assistant = {
        id: "msg_trace_assistant",
        sessionID: session.id,
        role: "assistant",
        time: { created: started + 10, completed: started + 500 },
        parentID: user.id,
        modelID: "gpt-5",
        providerID: "openai-codex",
        reasoningEffort: "high",
        mode: "research",
        agent: "research",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0.42,
        tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 10, write: 2 } },
        finish: "stop",
      }
      const tools: MessageV2.ToolPart[] = [
        {
          id: "part_search_original",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_search_original",
          tool: "websearch",
          state: {
            status: "completed",
            input: { query: "observable research agents" },
            output: "search output that the trace must not copy",
            title: "Web search",
            metadata: {},
            time: { start: started + 20, end: started + 100 },
          },
        },
        {
          id: "part_search_dedupe",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_search_dedupe",
          tool: "websearch",
          state: {
            status: "completed",
            input: { query: "observable research agents" },
            output: "search output that the trace must not copy",
            title: "Web search",
            metadata: {
              dedupeHit: true,
              dedupeOf: {
                messageID: assistant.id,
                partID: "part_search_original",
                callID: "call_search_original",
              },
            },
            time: { start: started + 110, end: started + 115 },
          },
        },
        {
          id: "part_kernel",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_kernel",
          tool: "python",
          state: {
            status: "completed",
            input: { code: "1 + 1" },
            output: "2",
            title: "Python execution",
            metadata: { executionCount: 1, provenanceID: "run_kernel" },
            time: { start: started + 120, end: started + 180 },
          },
        },
        {
          id: "part_child",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_child",
          tool: "task",
          state: {
            status: "completed",
            input: { subagent_type: "biology", description: "Check assay" },
            output: "bounded result",
            title: "Check assay",
            metadata: {
              sessionId: "ses_child",
              model: { providerID: "openai-codex", modelID: "gpt-5" },
              durationMs: 90,
              toolCalls: 2,
              failedToolCalls: 0,
              outcome: "partial",
              stopReason: "max_steps",
              usage: {
                cost: 0.1,
                tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
              },
            },
            time: { start: started + 190, end: started + 280 },
          },
        },
        {
          id: "part_artifact",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_artifact",
          tool: "artifact",
          state: {
            status: "completed",
            input: { action: "save_file", path: "result.csv" },
            output: "saved",
            title: "Registered artifact",
            metadata: { savedArtifact: { id: "artifact_1", versionID: "version_1" } },
            time: { start: started + 290, end: started + 320 },
          },
        },
        {
          id: "part_review",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_review",
          tool: "provenance_review",
          state: {
            status: "completed",
            input: {
              claim: "accuracy is 99%",
              issue: "untraceable-number",
              evidence: "part_kernel",
            },
            output: "recorded",
            title: "Review refutes",
            metadata: {
              id: "finding_1",
              target: "artifact_1",
              relation: "refutes",
              severity: "major",
            },
            time: { start: started + 330, end: started + 360 },
          },
        },
        {
          id: "part_failure",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_failure",
          tool: "bash",
          state: {
            status: "error",
            input: { command: "false" },
            error: "command exited 1",
            time: { start: started + 370, end: started + 380 },
          },
        },
        {
          id: "part_shell_exit",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_shell_exit",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "curl https://example.invalid" },
            output: "curl: could not resolve host",
            title: "Fetch release manifest",
            metadata: { exit: 6 },
            time: { start: started + 381, end: started + 385 },
          },
        },
        {
          id: "part_kernel_error",
          sessionID: session.id,
          messageID: assistant.id,
          type: "tool",
          callID: "call_kernel_error",
          tool: "notebook",
          state: {
            status: "completed",
            input: { code: "raise ValueError('bad input')" },
            output: "[ERROR]\nValueError: bad input",
            title: "Parse release manifest (error)",
            metadata: { ok: false, executionCount: 2 },
            time: { start: started + 386, end: started + 389 },
          },
        },
      ]
      await Session.updateMessage(user)
      await Session.updateMessage(assistant)
      for (const part of tools) await Session.updatePart(part)
      await Session.updatePart({
        id: "part_text",
        sessionID: session.id,
        messageID: assistant.id,
        type: "text",
        text: "Useful result",
        time: { start: started + 390, end: started + 420 },
      })
      await SessionTraceStore.approvalAsked({
        id: "permission_trace",
        sessionID: session.id,
        permission: "websearch",
        patterns: ["observable research agents"],
      })
      await SessionTraceStore.approvalReplied({
        sessionID: session.id,
        requestID: "permission_trace",
        reply: "once",
      })
      await SessionTraceStore.recordRetry({
        sessionID: session.id,
        messageID: assistant.id,
        attempt: 1,
        message: "provider overloaded",
        delayMs: 50,
      })
      const manifest = {
        version: 1 as const,
        profile: "research",
        mode: "primary" as const,
        provider: "openai-codex",
        model: "gpt-5",
        systemHash: "a".repeat(64),
        instructionsHash: "b".repeat(64),
        tools: [...new Set(tools.map((item) => item.tool))]
          .toSorted()
          .map((name) => ({ name, descriptionHash: "c".repeat(64), schemaHash: "d".repeat(64) })),
      }
      await SessionTraceStore.recordHarness({
        sessionID: session.id,
        messageID: assistant.id,
        parentMessageID: user.id,
        attempt: 1,
        snapshot: SessionHarness.Snapshot.parse({ ...manifest, fingerprint: SessionHarness.hash(manifest) }),
      })
      await SessionTraceStore.recordHarness({
        sessionID: session.id,
        messageID: assistant.id,
        parentMessageID: user.id,
        attempt: 2,
        snapshot: SessionHarness.Snapshot.parse({ ...manifest, fingerprint: SessionHarness.hash(manifest) }),
      })
      await SessionResearch.define(session.id, {
        objective: "Produce a checked observable result",
        domain: "general",
        template: "minimal",
        deliverables: [{ path: "result.csv", label: "Result table", required: true }],
      })

      const trace = await SessionTrace.build(session.id)
      expect(trace.summary).toMatchObject({
        cost: 0.42,
        toolCalls: 9,
        childCount: 1,
        searchCount: 2,
        dedupeHits: 1,
        approvalCount: 1,
        artifactSaves: 1,
        reviewerFindings: 1,
        failureCount: 3,
        retryCount: 1,
      })
      expect(trace.inference[0]).toMatchObject({
        provider: "openai-codex",
        model: "gpt-5",
        effort: "high",
        source: "chatgpt",
      })
      expect(trace.children[0]).toMatchObject({
        agent: "biology",
        sessionID: "ses_child",
        status: "partial",
        durationMs: 90,
        toolCalls: 2,
      })
      expect(trace.tools.find((tool) => tool.id === "part_child")?.status).toBe("partial")
      expect(trace.searches.find((search) => search.dedupeHit)).toMatchObject({ dedupeHit: true })
      expect(trace.kernels[0]).toMatchObject({ language: "python", executionCount: 1 })
      expect(trace.kernels[1]).toMatchObject({ language: "python", status: "error", executionCount: 2 })
      expect(trace.tools.find((tool) => tool.id === "part_shell_exit")?.status).toBe("error")
      expect(trace.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "part_shell_exit", message: "Fetch release manifest exited with code 6" }),
          expect.objectContaining({
            id: "part_kernel_error",
            message: "Parse release manifest reported failure",
          }),
        ]),
      )
      expect(trace.artifacts[0]).toMatchObject({
        artifactID: "artifact_1",
        versionID: "version_1",
        path: "result.csv",
      })
      expect(trace.reviewerFindings[0]).toMatchObject({
        claim: "accuracy is 99%",
        issue: "untraceable-number",
        evidence: "part_kernel",
      })
      expect(trace.privacy).toEqual({
        local: true,
        atlasRequired: false,
        hiddenReasoningStored: false,
        toolOutputsCopied: false,
        promptContentStored: false,
      })
      expect(trace.harness).toHaveLength(2)
      expect(trace.harness[0]).toMatchObject({
        messageID: assistant.id,
        parentMessageID: user.id,
        attempt: 1,
        profile: "research",
        provider: "openai-codex",
      })
      expect(trace.harness.map((item) => item.attempt)).toEqual([1, 2])
      expect(trace.harnessReport).toMatchObject({ records: 2, stable: true, valid: true })
      expect(trace.harnessReport.checks.every((item) => item.status === "pass")).toBe(true)
      expect(trace.research).toMatchObject({ configured: true, status: "blocked", missing: [] })
      expect(trace.research.gates.find((gate) => gate.id === "review")?.status).toBe("failed")
      expect(trace.research.gates.find((gate) => gate.id === "runtime")?.status).toBe("failed")
      expect(JSON.stringify(trace)).not.toContain("search output that the trace must not copy")
      expect(trace.turns[0].timeToFirstUsefulOutputMs).toBe(100)
      expect(SessionTrace.Info.parse(trace)).toEqual(trace)

      await Session.remove(session.id)
      expect(await SessionTraceStore.read(session.id)).toEqual({ approvals: {}, retries: [], harness: [] })
      expect(await SessionResearch.read(session.id)).toBeUndefined()
    },
  })
})

test("parent readiness includes findings recorded by a delegated reviewer", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({ title: "Research owner" })
      const child = await Session.create({ parentID: parent.id, title: "Independent review" })
      const scope = { projectID: Instance.project.id, directory: Instance.directory }
      await SessionResearch.define(parent.id, {
        objective: "Produce an independently reviewed result",
        domain: "general",
        template: "minimal",
        deliverables: [{ path: "result.csv", label: "Result table", required: true }],
      })
      await Provenance.recordOwned(scope, {
        id: "delegated_target",
        kind: "artifact",
        label: "Parent result",
        meta: { sessionID: parent.id },
      })
      const finding = await Review.record({
        ...scope,
        target: "delegated_target",
        finding: { claim: "headline", issue: "unsupported", severity: "major", evidence: "result.csv:2" },
        reviewer: "reviewer",
        sessionID: child.id,
        messageID: "msg_child_review",
        callID: "call_child_review",
      })

      const open = await SessionTrace.build(parent.id)
      expect(open.reviewerFindings).toHaveLength(1)
      expect(open.reviewerFindings[0]).toMatchObject({ id: finding.node.id, status: "open", severity: "major" })
      expect(open.research.gates.find((gate) => gate.id === "review")?.status).toBe("failed")

      await Review.resolve({
        ...scope,
        finding: finding.node.id,
        actor: "research",
        reason: "Recomputed and replaced the unsupported headline result",
        sessionID: parent.id,
      })
      await Review.record({
        ...scope,
        target: "delegated_target",
        confirms: finding.node.id,
        finding: { claim: "headline", issue: "verified", severity: "info", evidence: "result.csv:2" },
        verdict: "supports",
        reviewer: "reviewer",
        sessionID: child.id,
      })

      const confirmed = await SessionTrace.build(parent.id)
      expect(confirmed.reviewerFindings.find((item) => item.id === finding.node.id)?.status).toBe("confirmed")
      expect(confirmed.research.gates.find((gate) => gate.id === "review")?.status).toBe("passed")
      await Session.remove(parent.id)
    },
  })
})

test("a completed delegated review satisfies the review gate without findings", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "Clean delegated review" })
      const started = Date.now()
      const user: MessageV2.User = {
        id: "msg_clean_review_user",
        sessionID: session.id,
        role: "user",
        effort: "normal",
        time: { created: started },
        agent: "research",
        model: { providerID: "openai-codex", modelID: "gpt-5" },
      }
      const assistant: MessageV2.Assistant = {
        id: "msg_clean_review_assistant",
        sessionID: session.id,
        role: "assistant",
        time: { created: started + 10, completed: started + 100 },
        parentID: user.id,
        modelID: "gpt-5",
        providerID: "openai-codex",
        mode: "research",
        agent: "research",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      }
      await Session.updateMessage(user)
      await Session.updateMessage(assistant)
      await Session.updatePart({
        id: "part_clean_review",
        sessionID: session.id,
        messageID: assistant.id,
        type: "tool",
        callID: "call_clean_review",
        tool: "task",
        state: {
          status: "completed",
          input: { subagent_type: "review", description: "Review all result artifacts" },
          output: "No substantive findings.",
          title: "Independent review",
          metadata: { sessionId: "ses_clean_review", outcome: "completed" },
          time: { start: started + 20, end: started + 90 },
        },
      })
      await SessionResearch.define(session.id, {
        objective: "Produce an independently reviewed result",
        domain: "general",
        template: "minimal",
        deliverables: [],
      })

      const trace = await SessionTrace.build(session.id)
      expect(trace.children[0]).toMatchObject({ agent: "review", status: "completed" })
      expect(trace.reviewerFindings).toHaveLength(0)
      expect(trace.research.gates.find((gate) => gate.id === "review")?.status).toBe("passed")
      await Session.remove(session.id)
    },
  })
})

test("accepts Modal jobs as external compute activity", () => {
  const parsed = SessionTrace.Job.parse({
    id: "job_modal",
    name: "GPU analysis",
    target: "modal",
    targetLabel: "Modal A100",
    status: "running",
    createdAt: new Date().toISOString(),
    artifactCount: 0,
  })

  expect(parsed.target).toBe("modal")
})

test("reads only named reasoning controls from final provider options", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ reasoningEffort: "high" }, "high"],
    [{ effort: "max" }, "max"],
    [{ reasoning: { effort: "medium" } }, "medium"],
    [{ reasoningConfig: { maxReasoningEffort: "low" } }, "low"],
    [{ thinkingConfig: { thinkingLevel: "xhigh" } }, "xhigh"],
  ]

  for (const [options, expected] of cases) {
    expect(LLM.resolvedReasoningEffort(options)).toBe(expected)
  }
  expect(LLM.resolvedReasoningEffort({ thinking: { type: "enabled", budgetTokens: 16_000 } })).toBeUndefined()
})
