import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, rm } from "node:fs/promises"
import { buildPromptCorpus, extractPrompts } from "../../../../evals/cadence-harness/prepare"
import {
  assertServerIdentity,
  collectRuntimeRun,
  createRunGuard,
  captureSessions,
  campaignOutcome,
  isUserCancellation,
  isUnsafeHost,
  observableMessages,
  observableRuntimeEvent,
  parseModelKey,
  permissionDecision,
  promptRunID,
  resumeCheckpoint,
  safeValue,
  mergeFailures,
  trajectory,
  updateCampaignProgress,
} from "../../../../evals/cadence-harness/run"
import { aggregateCapturedSessionTree } from "../../../../evals/cadence-harness/tree-metrics"
import { devPrompt } from "../../../../evals/cadence-harness/dev-prompts"
import { devLabLayout, labEnvironment } from "../../../../evals/cadence-harness/dev-lab"

const root = path.join(import.meta.dir, `.cadence-runner-${process.pid}`)

afterAll(() => rm(root, { recursive: true, force: true }))

function sourcePrompt(ordinal: number, title = `Domain ${ordinal}`, body = `Prompt body ${ordinal}.`) {
  return `**P${ordinal} → ${title}**\n\n${body}`
}

function runtimeEvent(sequence: number, type: string, properties: Record<string, unknown> = {}) {
  return { sequence, sessionID: "ses_test", runID: "runtime_test", type, properties, time: 1_000 + sequence }
}

describe("cadence prompt segregation", () => {
  test("uses the report only for missing P1 and creates fixed 3/3/3/3/3/3/2 batches", () => {
    const rtf = Array.from({ length: 19 }, (_, index) => sourcePrompt(index + 2)).join("\n\n")
    const report = Array.from({ length: 20 }, (_, index) =>
      sourcePrompt(index + 1, `Report ${index + 1}`, `Report body ${index + 1}.`),
    ).join("\n\n")

    const prompts = buildPromptCorpus(rtf, report)

    expect(prompts).toHaveLength(20)
    expect(prompts[0]).toMatchObject({ id: "P1", source: "report", batchIndex: 1, batchPosition: 0 })
    expect(prompts[1]).toMatchObject({ id: "P2", source: "rtf", text: "Prompt body 2." })
    expect(prompts.map((prompt) => prompt.batchIndex)).toEqual([
      1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7,
    ])
    expect(promptRunID(prompts[0]!)).toBe("p01")
    expect(promptRunID(prompts[19]!)).toBe("p20")
  })

  test("fails closed for missing or duplicate prompt identifiers", () => {
    expect(() => extractPrompts(`${sourcePrompt(2)}\n${sourcePrompt(2)}`, "rtf")).toThrow(
      "Prompt P2 appears more than once",
    )
    expect(() => buildPromptCorpus(sourcePrompt(2), sourcePrompt(1))).toThrow(
      "Prompt P3 is missing from the segregated corpus",
    )
  })
})

describe("cadence runner contracts", () => {
  test("aggregates explicit root and child metrics without hiding failure-count ambiguity", () => {
    const tree = aggregateCapturedSessionTree(
      [
        {
          sessionID: "root",
          session: { id: "root", title: "Root" },
          trace: {
            summary: { tokens: { input: 10, output: 2 }, cost: 0.1, failureCount: 2 },
            tools: [{ id: "tool-root-1" }, { id: "tool-root-2" }],
            searches: [{ id: "search-root" }],
            approvals: [{ id: "approval-root" }],
            children: [{ sessionID: "child", agent: "explore" }],
            failures: [
              { id: "shared-failure", message: "shared" },
              { id: "root-failure", message: "root" },
            ],
          },
          executions: [{ id: "exec-root", status: "completed" }],
        },
        {
          sessionID: "child",
          session: { id: "child", parentID: "root", title: "Child" },
          trace: {
            summary: { tokens: { input: 4, output: 1, cache: { read: 5 } }, cost: 0.05, failureCount: 3 },
            tools: [{ id: "tool-child" }],
            searches: [],
            approvals: [{ id: "approval-child-1" }, { id: "approval-child-2" }],
            children: [],
            failures: [
              { id: "shared-failure", message: "shared" },
              { id: "child-failure", message: "child" },
            ],
          },
          executions: [
            { id: "exec-child-1", status: "failed" },
            { id: "exec-child-2", status: "completed" },
          ],
        },
      ],
      "root",
    )

    expect(tree).toMatchObject({
      source: "captured-session-traces",
      sessionCount: 2,
      childSessionCount: 1,
      toolCalls: 3,
      searches: 1,
      approvals: 3,
      childAgentLinks: 1,
      failures: 3,
      reportedFailures: 5,
      executions: 3,
      failedExecutions: 1,
      executionSessionCount: 2,
      tokens: { total: 22, input: 14, output: 3, cacheRead: 5 },
      captureComplete: true,
    })
    expect(tree?.cost).toBeCloseTo(0.15)
    expect(tree?.sessions).toEqual([
      expect.objectContaining({ sessionId: "root", isRoot: true, failures: 2, reportedFailures: 2 }),
      expect.objectContaining({ sessionId: "child", agent: "explore", failures: 2, reportedFailures: 3 }),
    ])
  })

  test("captures provenance executions for every session in the recursive tree", async () => {
    const executionQueries: string[] = []
    const client = {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          data: { id: sessionID, ...(sessionID === "child" ? { parentID: "root" } : {}) },
        }),
        messages: async () => ({ data: [] }),
        trace: async ({ sessionID }: { sessionID: string }) => ({
          data: {
            session: { id: sessionID },
            summary: { toolCalls: sessionID === "root" ? 1 : 2 },
            tools: Array.from({ length: sessionID === "root" ? 1 : 2 }, (_, index) => ({
              id: `${sessionID}-${index}`,
            })),
            children: sessionID === "root" ? [{ sessionID: "child", agent: "explore" }] : [],
            failures: [],
          },
        }),
        children: async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "root" ? [{ id: "child" }] : [],
        }),
        filesystem: { list: async () => ({ data: [] }) },
      },
      file: { artifacts: async () => ({ data: [] }) },
      provenance: {
        executions: async ({ sessionID }: { sessionID: string }) => {
          executionQueries.push(sessionID)
          return { data: [{ id: `exec-${sessionID}`, status: "completed" }] }
        },
      },
    }
    const captureRoot = path.join(root, "recursive-capture")
    const captured = await captureSessions(client as never, "root", captureRoot)

    expect(captured.map((item) => item.sessionID)).toEqual(["root", "child"])
    expect(executionQueries).toEqual(["root", "child"])
    expect(await Bun.file(path.join(captureRoot, "root", "executions.json")).json()).toEqual([
      { id: "exec-root", status: "completed" },
    ])
    expect(await Bun.file(path.join(captureRoot, "child", "executions.json")).json()).toEqual([
      { id: "exec-child", status: "completed" },
    ])
  })

  test("classifies semantic outcomes separately from runtime lifecycle", () => {
    expect(campaignOutcome({ terminalType: "runtime.completed", finalText: "answer" })).toEqual({
      status: "completed",
    })
    expect(
      campaignOutcome({
        terminalType: "runtime.failed",
        assistantError: { data: { message: '{"error":{"code":"bio_policy"}}' } },
      }),
    ).toEqual({ status: "blocked", reason: "provider_policy" })
    expect(
      campaignOutcome({ terminalType: "runtime.failed", assistantError: { message: "boom" }, artifactCount: 1 }),
    ).toEqual({ status: "partial", reason: "error_after_usable_output" })
    expect(
      campaignOutcome({
        terminalType: "runtime.failed",
        terminalError: 'invalid_request_error: {"code":"bio_policy"}',
      }),
    ).toEqual({ status: "blocked", reason: "provider_policy" })
    expect(campaignOutcome({ terminalType: "runtime.completed" })).toEqual({
      status: "failed",
      reason: "no_usable_output",
    })
    expect(campaignOutcome({ finalText: "recovered output" })).toEqual({
      status: "partial",
      reason: "runtime_terminal_missing",
    })
    expect(campaignOutcome({ timedOut: true })).toEqual({ status: "failed", reason: "runner_timeout" })
    expect(
      campaignOutcome({
        userAborted: true,
        terminalType: "runtime.failed",
        terminalError: "The operation was aborted.",
      }),
    ).toEqual({ status: "cancelled", reason: "user_cancelled" })
    expect(
      campaignOutcome({
        timedOut: true,
        userAborted: true,
        terminalType: "runtime.failed",
        terminalError: "The operation was aborted.",
      }),
    ).toEqual({ status: "failed", reason: "runner_timeout" })
    expect(campaignOutcome({ terminalType: "runtime.failed", terminalError: "The operation was aborted." })).toEqual({
      status: "failed",
      reason: "runtime_error",
    })
    expect(
      campaignOutcome({
        terminalType: "runtime.failed",
        assistantError: {
          name: "ProviderIdleTimeoutError",
          data: { message: "The request was cancelled; retry it or check the provider/network connection." },
        },
      }),
    ).toEqual({ status: "failed", reason: "runtime_error" })
    expect(isUserCancellation({ name: "MessageAbortedError", data: { message: "The operation was aborted." } })).toBe(
      false,
    )
    expect(isUserCancellation({ name: "AbortError", message: "The operation was aborted." })).toBe(false)
    expect(isUserCancellation(runtimeEvent(9, "runtime.cancelled", { source: "user" }))).toBe(true)
    expect(isUserCancellation(runtimeEvent(9, "runtime.cancelled", { source: "runner_timeout" }))).toBe(false)
    expect(
      isUserCancellation(runtimeEvent(9, "runtime.failed", { message: "The operation was aborted." }), {
        source: "user",
        evidence: "operator_asserted_session_abort",
        sessionId: "ses_00414722bffeXpQIW64OhTF8Lu",
        runtimeRunId: "run_ffbeb8def0013v4SodA9v55RJz",
        at: "2026-08-13T16:46:30.983Z",
      }),
    ).toBe(true)
    expect(
      isUserCancellation(runtimeEvent(9, "runtime.failed", { message: "The operation was aborted." }), {
        source: "user",
        evidence: "operator_asserted_session_abort",
      }),
    ).toBe(false)
  })

  test("recovers only complete nonterminal runtime checkpoints", () => {
    expect(
      resumeCheckpoint({
        status: "running",
        startedAt: "2026-08-13T10:00:00.000Z",
        projectId: "project_existing",
        projectLabel: "Existing project",
        sessionId: "session_existing",
        runtimeRunId: "run_existing",
        runtimeAcceptedAt: 1_786_593_600_100,
        runtimeAfterSequence: 4,
      }),
    ).toEqual({
      projectId: "project_existing",
      projectLabel: "Existing project",
      sessionId: "session_existing",
      runtimeRunId: "run_existing",
      acceptedAt: 1_786_593_600_100,
      afterSequence: 4,
    })
    expect(resumeCheckpoint({ status: "running", projectId: "project_existing" })).toBeUndefined()
    expect(
      resumeCheckpoint({
        status: "completed",
        projectId: "project_existing",
        sessionId: "session_existing",
        runtimeRunId: "run_existing",
      }),
    ).toBeUndefined()
  })

  test("deduplicates the terminal runtime failure against its traced provider message", () => {
    const failures = mergeFailures(
      [{ kind: "runtime", id: "msg_abort", message: "The operation was aborted.", createdAt: 1_002 }],
      [
        { kind: "model", id: "msg_abort", message: "The operation was aborted.", createdAt: 993 },
        { kind: "tool", id: "tool_abort", message: "aborted", createdAt: 983 },
      ],
    )

    expect(failures).toHaveLength(2)
    expect(failures.map((failure) => failure.id)).toEqual(["msg_abort", "tool_abort"])
  })

  test("projects completed inference records with an error as failed", () => {
    const projected = trajectory(
      {
        inference: [
          {
            messageID: "msg_failed",
            provider: "fixture",
            model: "model",
            startedAt: 1,
            completedAt: 2,
            error: { name: "ProviderIdleTimeoutError" },
          },
        ],
      },
      [],
    )

    expect(projected.timeline[0]?.status).toBe("failed")
  })

  test("parses provider/model without truncating model paths", () => {
    expect(parseModelKey("openai-codex/gpt-5.6-sol")).toEqual({
      providerID: "openai-codex",
      modelID: "gpt-5.6-sol",
    })
    expect(parseModelKey("provider/family/model")).toEqual({ providerID: "provider", modelID: "family/model" })
    expect(() => parseModelKey("missing-separator")).toThrow("provider/model")
  })

  test("keeps permission policy scoped and rejects non-public destinations", () => {
    expect(isUnsafeHost("127.0.0.1")).toBe(true)
    expect(isUnsafeHost("172.20.0.1")).toBe(true)
    expect(isUnsafeHost("api.ncbi.nlm.nih.gov")).toBe(false)
    expect(permissionDecision({ permission: "network", metadata: { network: { host: "127.0.0.1" } } })).toMatchObject({
      reply: "reject",
    })
    expect(
      permissionDecision({ permission: "network", metadata: { network: { host: "api.ncbi.nlm.nih.gov" } } }),
    ).toMatchObject({ reply: "once" })
    expect(permissionDecision({ permission: "compute_job", metadata: { target: "local" } })).toMatchObject({
      reply: "once",
    })
    expect(permissionDecision({ permission: "compute_job", metadata: { target: "modal" } })).toMatchObject({
      reply: "reject",
    })
    expect(
      permissionDecision({
        permission: "compute_job",
        metadata: { compute_job: { job: { target_label: "ssh-gpu" } } },
      }),
    ).toMatchObject({ reply: "reject" })
    expect(
      permissionDecision(
        { permission: "modal", metadata: { compute_job: { plan: { provider: "modal" } } } },
        { managedCompute: true },
      ),
    ).toMatchObject({ reply: "once" })
    expect(
      permissionDecision(
        { permission: "modal", metadata: { compute_job: { plan: { provider: "modal" } } } },
        { managedCompute: false },
      ),
    ).toMatchObject({ reply: "reject" })
    expect(
      permissionDecision({
        permission: "mcp",
        metadata: { server: "paid-connected-service", tool: "records.create", mutating: true, paid: true },
      }),
    ).toEqual({
      reply: "reject",
      reason: "MCP actions require an explicit audited campaign allowlist; none is configured",
    })
    expect(permissionDecision({ permission: "environment_mutation", metadata: { package: "unreviewed" } })).toEqual({
      reply: "reject",
      reason: "environment mutation requires explicit campaign opt-in; none is configured",
    })
    expect(permissionDecision({ permission: "unknown" })).toMatchObject({ reply: "reject" })
  })

  test("binds a single dev prompt to exact source identity without implicit hard caps", () => {
    const p21 = devPrompt("p21")
    const p24 = devPrompt("P24")
    expect(p21).toMatchObject({ id: "P21", ordinal: 21 })
    expect(p21.sha256).toHaveLength(64)
    expect(p24.text).toContain("at most 4× H100 GPUs")
    expect(() => devPrompt("P22")).toThrow("Use P21, P23, or P24")

    const health = { sourceSha: "abc", sourceWorktreeHash: "def", runId: "run-one" }
    expect(() => assertServerIdentity(health, { sourceSha: "abc", sourceWorktreeHash: "def" })).not.toThrow()
    expect(() => assertServerIdentity(health, { sourceSha: "abc", sourceWorktreeHash: "other" })).toThrow(
      "worktree hash",
    )
  })

  test("keeps run ceilings diagnostic and opt-in", () => {
    const guard = createRunGuard({ maxEvents: 2, maxToolCalls: 1, maxChildAgents: 1 })
    expect(guard.observe(runtimeEvent(1, "message.part.updated"))).toBeUndefined()
    expect(
      guard.observe(
        runtimeEvent(2, "message.part.updated", {
          part: { type: "tool", callID: "tool-1", tool: "read" },
        }),
      ),
    ).toBeUndefined()
    expect(guard.observe(runtimeEvent(3, "message.part.updated"))).toBe("max_events:2")
  })

  test("isolates dev credentials from ambient provider and compute secrets", () => {
    const layout = devLabLayout("/tmp/dev-home", "/tmp/dev-lab")
    const env = labEnvironment(
      layout,
      { sourceSha: "abc", sourceWorktreeHash: "def", runId: "run-one" },
      {
        PATH: "/usr/bin",
        HOME: "/tmp/dev-home",
        OPENROUTER_API_KEY: "must-not-leak",
        FIRECRAWL_API_KEY: "must-not-leak",
        MODAL_TOKEN_SECRET: "must-not-leak",
      },
    )
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      OPENSCIENCE_DATA_DIR: "/tmp/dev-lab/data",
      OPENSCIENCE_ENABLE_RESEARCH_AGENT_TEST: "1",
      OPENSCIENCE_SOURCE_SHA: "abc",
      OPENSCIENCE_SOURCE_WORKTREE_HASH: "def",
      OPENSCIENCE_RUN_ID: "run-one",
    })
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY")
    expect(env).not.toHaveProperty("FIRECRAWL_API_KEY")
    expect(env).not.toHaveProperty("MODAL_TOKEN_SECRET")
  })

  test("redacts secrets and hidden reasoning without erasing observable reasoning metadata", () => {
    expect(
      safeValue({
        api_key: "secret-value",
        reasoning: 42,
        reasoningEffort: "high",
        reasoning_content: "private chain of thought",
        nested: { accessToken: "token-value" },
      }),
    ).toEqual({
      api_key: "[redacted]",
      reasoning: 42,
      reasoningEffort: "high",
      reasoning_content: "[redacted]",
      nested: { accessToken: "[redacted]" },
    })
    const hidden = observableRuntimeEvent(
      runtimeEvent(2, "message.part.updated", {
        part: {
          id: "part_reasoning",
          sessionID: "ses_test",
          messageID: "msg_test",
          type: "reasoning",
          text: "private chain of thought",
          time: { start: 1 },
        },
        delta: "private chain of thought",
      }),
    )
    expect(JSON.stringify(hidden)).not.toContain("private chain of thought")
    expect(hidden.properties.part).toMatchObject({ type: "reasoning", hidden: true })
    expect(
      observableMessages([
        {
          info: { id: "msg_test" },
          parts: [
            { type: "reasoning", text: "private chain of thought" },
            { type: "text", text: "observable answer" },
          ],
        },
      ])[0]?.parts,
    ).toEqual([{ type: "text", text: "observable answer" }])
  })

  test("recovers a terminal event from durable replay after the live stream fails", async () => {
    const captured: number[] = []
    const runtime = {
      async *events() {
        yield runtimeEvent(1, "runtime.accepted")
        throw new Error("SSE failed: 502")
      },
      async replay() {
        return {
          events: [runtimeEvent(1, "runtime.accepted"), runtimeEvent(2, "runtime.completed")],
          latestSequence: 2,
        }
      },
    }

    const result = await collectRuntimeRun({
      runtime,
      sessionID: "ses_test",
      runID: "runtime_test",
      afterSequence: 0,
      signal: new AbortController().signal,
      pollIntervalMs: 0,
      onEvent(event) {
        captured.push(event.sequence)
      },
    })

    expect(captured).toEqual([1, 2])
    expect(result.terminal?.type).toBe("runtime.completed")
    expect(result.recovered).toBe(true)
    expect(result.streamError).toContain("SSE failed: 502")
  })

  test("returns promptly when an interrupted stream has no terminal event", async () => {
    const abort = new AbortController()
    const runtime = {
      async *events() {
        yield runtimeEvent(1, "runtime.accepted")
        abort.abort()
      },
      async replay() {
        throw new Error("must not poll after abort")
      },
    }
    const result = await collectRuntimeRun({
      runtime,
      sessionID: "ses_test",
      runID: "runtime_test",
      afterSequence: 0,
      signal: abort.signal,
      pollIntervalMs: 0,
      onEvent() {},
    })
    expect(result.terminal).toBeUndefined()
  })

  test("treats a source-provenanced cancellation as a terminal runtime event", async () => {
    const runtime = {
      async *events() {
        yield runtimeEvent(4, "runtime.cancelled", { source: "user" })
      },
      async replay() {
        throw new Error("terminal stream must not poll replay")
      },
    }
    const result = await collectRuntimeRun({
      runtime,
      sessionID: "ses_test",
      runID: "runtime_test",
      afterSequence: 3,
      signal: new AbortController().signal,
      onEvent() {},
    })
    expect(result.terminal).toMatchObject({ type: "runtime.cancelled", properties: { source: "user" } })
  })

  test("updates campaign progress without resetting the original start time", async () => {
    const campaignRoot = path.join(root, "campaign")
    const prompts = [
      { id: "P1", ordinal: 1, title: "One", text: "one", sha256: "1", batchIndex: 1, batchPosition: 0 },
      { id: "P2", ordinal: 2, title: "Two", text: "two", sha256: "2", batchIndex: 1, batchPosition: 1 },
    ]
    await Promise.all([
      mkdir(path.join(campaignRoot, "runs", "p01"), { recursive: true }),
      mkdir(path.join(campaignRoot, "runs", "p02"), { recursive: true }),
    ])
    await Bun.write(
      path.join(campaignRoot, "campaign.json"),
      JSON.stringify({ id: "fixture", status: "running", startedAt: "2026-08-13T10:00:00.000Z" }),
    )
    await Bun.write(path.join(campaignRoot, "runs", "p01", "run.json"), JSON.stringify({ status: "completed" }))
    await Bun.write(path.join(campaignRoot, "runs", "p02", "run.json"), JSON.stringify({ status: "failed" }))

    const result = await updateCampaignProgress(campaignRoot, prompts)

    expect(result).toMatchObject({
      status: "failed",
      attemptedPrompts: 2,
      completedPrompts: 1,
      failedPrompts: 1,
      startedAt: "2026-08-13T10:00:00.000Z",
    })
  })

  test("persists every non-success terminal count and its final precedence", async () => {
    const campaignRoot = path.join(root, "terminal-outcomes")
    const statuses = ["completed", "partial", "blocked", "inconclusive", "cancelled"]
    const prompts = statuses.map((_, index) => ({
      id: `P${index + 1}`,
      ordinal: index + 1,
      title: `Prompt ${index + 1}`,
      text: `prompt ${index + 1}`,
      sha256: String(index + 1),
      batchIndex: 1,
      batchPosition: index,
    }))
    await Promise.all(
      statuses.map(async (runStatus, index) => {
        const directory = path.join(campaignRoot, "runs", promptRunID(prompts[index]!))
        await mkdir(directory, { recursive: true })
        await Bun.write(path.join(directory, "run.json"), JSON.stringify({ status: runStatus }))
      }),
    )

    const result = await updateCampaignProgress(campaignRoot, prompts)

    expect(result).toMatchObject({
      status: "blocked",
      attemptedPrompts: 5,
      completedPrompts: 1,
      partialPrompts: 1,
      blockedPrompts: 1,
      inconclusivePrompts: 1,
      cancelledPrompts: 1,
    })
  })
})
