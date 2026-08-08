import { describe, expect, test } from "bun:test"
import type { SessionTraceResponse } from "@synsci/sdk/v2/client"
import { formatCost, formatDuration, traceActivity, traceCounts, traceMetrics } from "./session-trace-model"

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
  profiles: [],
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
})
