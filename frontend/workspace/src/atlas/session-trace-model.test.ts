import { describe, expect, test } from "bun:test"
import type { SessionTraceResponse } from "@synsci/sdk/v2/client"
import {
  formatCost,
  formatDuration,
  fallbackObservableKernels,
  recentObservableResearch,
  traceActivity,
  traceCounts,
  traceMetrics,
} from "./session-trace-model"

const trace: SessionTraceResponse = {
  version: 1,
  session: {
    id: "ses_trace",
    title: "Protein folding survey",
    status: "idle",
    createdAt: 1_000,
    updatedAt: 9_000,
  },
  summary: {
    startedAt: 1_000,
    firstUsefulOutputAt: 2_250,
    timeToFirstUsefulOutputMs: 1_250,
    completedAt: 9_000,
    totalCompletionTimeMs: 8_000,
    cost: 0.0042,
    tokens: { input: 1_000, output: 200, reasoning: 50, cache: { read: 500, write: 0 } },
    toolCalls: 3,
    childCount: 1,
    searchCount: 2,
    dedupeHits: 1,
    approvalCount: 1,
    artifactSaves: 1,
    reviewerFindings: 1,
    failureCount: 0,
    retryCount: 1,
  },
  turns: [],
  inference: [
    {
      messageID: "msg_assistant",
      parentMessageID: "msg_user",
      agent: "research",
      model: "gpt-5",
      provider: "openai",
      effort: "medium",
      source: "byok",
      startedAt: 1_100,
      completedAt: 8_900,
      durationMs: 7_800,
      cost: 0.0042,
      tokens: { input: 1_000, output: 200, reasoning: 50, cache: { read: 500, write: 0 } },
    },
  ],
  tools: [
    {
      id: "part_tool",
      callID: "call_tool",
      messageID: "msg_assistant",
      name: "read",
      category: "tool",
      status: "completed",
      title: "Read methods.md",
      startedAt: 2_000,
      completedAt: 2_400,
      durationMs: 400,
      inputHash: "hash",
      inputKeys: ["path"],
    },
  ],
  children: [],
  searches: [
    {
      toolID: "part_search",
      messageID: "msg_assistant",
      tool: "science_search",
      query: "protein folding benchmark",
      signature: "signature",
      status: "completed",
      dedupeHit: true,
      startedAt: 3_000,
      completedAt: 3_001,
      durationMs: 1,
    },
  ],
  kernels: [],
  jobs: [],
  approvals: [
    {
      id: "approval",
      permission: "external_directory",
      patterns: ["/data"],
      requestedAt: 1_500,
      reply: "once",
      repliedAt: 1_600,
    },
  ],
  external: [],
  artifacts: [],
  reviewerFindings: [],
  failures: [],
  retries: [
    {
      id: "retry",
      messageID: "msg_assistant",
      attempt: 1,
      message: "rate limited",
      delayMs: 500,
      createdAt: 4_000,
    },
  ],
  privacy: {
    local: true,
    atlasRequired: false,
    hiddenReasoningStored: false,
    toolOutputsCopied: false,
  },
}

describe("session trace presentation", () => {
  test("formats short, long, and low-cost work without hiding precision", () => {
    expect(formatDuration(420)).toBe("420ms")
    expect(formatDuration(8_200)).toBe("8.2s")
    expect(formatDuration(125_000)).toBe("2m 5s")
    expect(formatCost(0.0042)).toContain("0.0042")
  })

  test("summarizes time, cost, tokens, and every trust count", () => {
    expect(traceMetrics(trace).map((item) => item.label)).toEqual(["first output", "total time", "model cost"])
    expect(traceMetrics(trace)[2].detail).toBe("1.8k tokens")
    expect(traceCounts(trace).find((item) => item.label === "searches")).toEqual({
      label: "searches",
      value: 2,
      note: "1 reused",
    })
    expect(traceCounts(trace).map((item) => item.label)).toContain("approvals")
    expect(traceCounts(trace).map((item) => item.label)).toContain("failures")
  })

  test("builds a chronological observable timeline without hashes, patterns, or tool output", () => {
    const activity = traceActivity(trace)
    expect(activity.map((item) => item.kind)).toEqual(["model", "approval", "tool", "search", "retry"])
    expect(activity.find((item) => item.kind === "search")?.detail).toContain("reused local result")
    expect(activity.find((item) => item.kind === "approval")?.detail).toBe("approved: once")
    expect(JSON.stringify(activity)).not.toContain("inputHash")
    expect(JSON.stringify(activity)).not.toContain("/data")
    expect(JSON.stringify(activity)).not.toContain("patterns")
    expect(JSON.stringify(activity)).not.toContain("output")
  })

  test("projects only recent delegated, search, browser, and external research activity", () => {
    const activity = recentObservableResearch(
      {
        ...trace,
        children: [
          {
            toolID: "part_child",
            agent: "explore",
            model: { providerID: "provider-internal", modelID: "model-internal" },
            status: "completed",
            startedAt: 6_000,
            completedAt: 6_800,
            durationMs: 800,
            toolCalls: 4,
            failedToolCalls: 0,
          },
        ],
        tools: [
          ...trace.tools,
          {
            id: "part_search",
            callID: "call_search",
            messageID: "msg_assistant",
            name: "science_search",
            category: "search",
            status: "completed",
            startedAt: 3_000,
            completedAt: 3_001,
            durationMs: 1,
            inputHash: "search-hash",
            inputKeys: ["query"],
          },
          {
            id: "part_fetch",
            callID: "call_fetch",
            messageID: "msg_assistant",
            name: "science_fetch",
            category: "external",
            status: "completed",
            title: "Opened the benchmark paper",
            startedAt: 5_000,
            completedAt: 5_400,
            durationMs: 400,
            inputHash: "fetch-hash",
            inputKeys: ["id"],
          },
          {
            id: "part_browser",
            callID: "call_browser",
            messageID: "msg_assistant",
            name: "browser_open",
            category: "tool",
            status: "running",
            title: "Reading methods",
            startedAt: 7_000,
            durationMs: 2_000,
            inputHash: "browser-hash",
            inputKeys: ["url"],
          },
          {
            id: "part_shell",
            callID: "call_shell",
            messageID: "msg_assistant",
            name: "bash",
            category: "tool",
            status: "completed",
            startedAt: 8_000,
            completedAt: 8_500,
            durationMs: 500,
            inputHash: "shell-hash",
            inputKeys: ["command"],
          },
        ],
      },
      4,
    )

    expect(activity.map((item) => item.id)).toEqual([
      "shell:part_shell",
      "source:part_browser",
      "child:part_child",
      "source:part_fetch",
    ])
    expect(activity.find((item) => item.kind === "agent")?.detail).toBe("4 actions completed · 800ms")
    expect(activity.find((item) => item.kind === "shell")?.detail).toContain("Local shell")
    expect(JSON.stringify(activity)).not.toContain("provider-internal")
    expect(JSON.stringify(activity)).not.toContain("inputHash")
  })

  test("keeps completed shell commands observable after the live process exits", () => {
    const activityTrace: SessionTraceResponse = {
      ...trace,
      tools: [
        ...trace.tools,
        {
          id: "tool_shell_done",
          callID: "call_shell_done",
          messageID: "message_shell",
          name: "bash",
          category: "tool",
          status: "completed",
          title: "Checking model outputs",
          startedAt: trace.session.updatedAt - 250,
          completedAt: trace.session.updatedAt - 50,
          durationMs: 200,
          inputHash: "shell",
          inputKeys: ["command"],
        },
      ],
    }

    expect(recentObservableResearch(activityTrace)).toContainEqual(
      expect.objectContaining({
        id: "shell:tool_shell_done",
        kind: "shell",
        label: "Checking model outputs",
        status: "completed",
      }),
    )
  })

  test("leaves running shell work to the authoritative local command registry", () => {
    const activityTrace: SessionTraceResponse = {
      ...trace,
      tools: [
        ...trace.tools,
        {
          id: "tool_shell_live",
          callID: "call_shell_live",
          messageID: "message_shell_live",
          name: "bash",
          category: "tool",
          status: "running",
          title: "Running tests",
          startedAt: trace.session.updatedAt - 50,
          durationMs: 50,
          inputHash: "shell-live",
          inputKeys: ["command"],
        },
      ],
    }

    expect(recentObservableResearch(activityTrace).map((item) => item.id)).not.toContain("shell:tool_shell_live")
  })

  test("caps the calm activity list after sorting newest first", () => {
    const activity = recentObservableResearch(
      {
        ...trace,
        children: [
          { toolID: "older", agent: "review", status: "completed", startedAt: 2_000 },
          { toolID: "newer", agent: "execute", status: "running", startedAt: 8_000 },
        ],
      },
      2,
    )

    expect(activity.map((item) => item.id)).toEqual(["child:newer", "search:part_search"])
  })

  test("uses canonical Python and R trace events only when durable history is empty", () => {
    const activityTrace: SessionTraceResponse = {
      ...trace,
      tools: [
        ...trace.tools,
        {
          id: "kernel_python",
          callID: "call_python",
          messageID: "message_python",
          name: "notebook",
          category: "kernel",
          status: "completed",
          title: "Fitting the model",
          startedAt: 7_000,
          completedAt: 7_500,
          durationMs: 500,
          inputHash: "python",
          inputKeys: ["code"],
        },
        {
          id: "kernel_r",
          callID: "call_r",
          messageID: "message_r",
          name: "rkernel",
          category: "kernel",
          status: "completed",
          title: "Loading the data",
          startedAt: 6_000,
          completedAt: 6_250,
          durationMs: 250,
          inputHash: "r",
          inputKeys: ["code"],
        },
        {
          id: "generic_tool",
          callID: "call_generic",
          messageID: "message_generic",
          name: "read",
          category: "tool",
          status: "completed",
          title: "Reading a file",
          startedAt: 8_000,
          completedAt: 8_100,
          durationMs: 100,
          inputHash: "generic",
          inputKeys: ["path"],
        },
        {
          id: "kernel_stop",
          callID: "call_stop",
          messageID: "message_stop",
          name: "notebook",
          category: "kernel",
          status: "completed",
          title: "Stopped Python · analysis",
          startedAt: 9_000,
          completedAt: 9_100,
          durationMs: 100,
          inputHash: "stop",
          inputKeys: ["action"],
        },
      ],
      kernels: [
        {
          toolID: "kernel_stop",
          messageID: "message_stop",
          language: "python",
          status: "completed",
          startedAt: 9_000,
          completedAt: 9_100,
          durationMs: 100,
        },
        {
          toolID: "kernel_r",
          messageID: "message_r",
          language: "r",
          status: "completed",
          startedAt: 6_000,
          completedAt: 6_250,
          durationMs: 250,
          provenanceID: "prov-r",
        },
        {
          toolID: "kernel_python",
          messageID: "message_python",
          language: "python",
          status: "completed",
          startedAt: 7_000,
          completedAt: 7_500,
          durationMs: 500,
          executionCount: 1,
          provenanceID: "prov-python",
        },
      ],
    }

    expect(fallbackObservableKernels(activityTrace, 0).map((item) => item.label)).toEqual([
      "Fitting the model",
      "Loading the data",
    ])
    expect(JSON.stringify(fallbackObservableKernels(activityTrace, 0))).not.toContain("Reading a file")
    expect(fallbackObservableKernels(activityTrace, 1)).toEqual([])
  })
})
