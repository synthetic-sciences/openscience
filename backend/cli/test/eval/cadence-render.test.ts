import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, rm } from "node:fs/promises"
import {
  loadCampaignReport,
  renderCampaignDashboard,
  renderCampaignHtml,
} from "../../../../evals/cadence-harness/render"

const root = path.join(import.meta.dir, `.cadence-render-${process.pid}`)

afterAll(() => rm(root, { recursive: true, force: true }))

async function fixture() {
  const run = path.join(root, "runs", "p01")
  const batch = path.join(root, "batches", "batch-01")
  await Promise.all([mkdir(path.join(run, "artifacts"), { recursive: true }), mkdir(batch, { recursive: true })])
  await Bun.write(
    path.join(root, "campaign.json"),
    JSON.stringify({
      id: "cadence-20",
      title: "Cadence harness campaign",
      plannedPrompts: 20,
      status: "running",
      model: "gpt-test",
      provider: "fixture",
      effort: "normal",
    }),
  )
  await Bun.write(
    path.join(run, "run.json"),
    JSON.stringify({
      id: "p01-run",
      promptId: "P1",
      title: "Oncology <script>alert(1)</script>",
      batchId: "batch-01",
      status: "completed",
      startedAt: "2026-08-13T10:00:00.000Z",
      completedAt: "2026-08-13T10:02:00.000Z",
      sessionId: "ses_fixture",
      artifacts: [{ path: "artifacts/report.html", type: "html" }, { path: "../../outside.txt" }],
      hiddenReasoning: "NEVER_RENDER_THIS_REASONING",
    }),
  )
  await Bun.write(path.join(run, "prompt.md"), "Use <script>bad()</script> data")
  await Bun.write(path.join(run, "final.md"), "# Result\n\n<img src=x onerror=bad()>\n\nBearer abcdefghijklmnop")
  await Bun.write(path.join(run, "artifacts", "report.html"), "<h1>deliverable</h1>")
  await Bun.write(
    path.join(run, "trace.json"),
    JSON.stringify({
      summary: {
        totalCompletionTimeMs: 120_000,
        timeToFirstUsefulOutputMs: 800,
        cost: 0.125,
        tokens: { input: 1_000, output: 500, reasoning: 250, cache: { read: 100, write: 0 } },
        inferenceCalls: 2,
        toolCalls: 2,
        toolCallsPerInference: 1,
        toolExecutionMs: 400,
        toolCriticalPathMs: 300,
        toolMaxConcurrency: 2,
        toolParallelism: 1.333,
        toolContractBytes: 45_561,
        contractBytes: 50_000,
        searchCount: 1,
        childCount: 1,
        retryCount: 1,
        failureCount: 1,
      },
      inference: [{ provider: "fixture", model: "gpt-test", effort: "normal" }],
      tools: [
        { name: "WebFetch", status: "completed", durationMs: 300 },
        {
          name: "Shell",
          status: "error",
          durationMs: 100,
          message: "Authorization: super-secret-value",
          input: "NEVER_RENDER_RAW_INPUT",
        },
      ],
      failures: [{ title: "Denied", message: "api_key=super-secret-value" }],
      hiddenReasoning: "NEVER_RENDER_TRACE_REASONING",
    }),
  )
  await Bun.write(
    path.join(run, "trajectory.json"),
    JSON.stringify({
      timeline: [{ type: "analysis", name: "Planning data acquisition", status: "completed" }],
      reasoning: "NEVER_RENDER_TRAJECTORY_REASONING",
    }),
  )
  await Bun.write(
    path.join(run, "events.ndjson"),
    `${JSON.stringify({ type: "tool.completed", name: "WebFetch", status: "completed", timestamp: "2026-08-13T10:00:02.000Z", payload: "NEVER_RENDER_EVENT_PAYLOAD" })}\n`,
  )
  await Bun.write(path.join(run, "executions.json"), JSON.stringify([]))
  await Bun.write(
    path.join(batch, "batch.json"),
    JSON.stringify({ id: "batch-01", title: "Batch 1", status: "completed", runIds: ["p01-run"] }),
  )
  await Bun.write(path.join(batch, "analysis.md"), "The first batch exposed a general authority-boundary failure.")
  await Bun.write(
    path.join(batch, "improvements.json"),
    JSON.stringify({
      implemented: [
        {
          id: "authority-contract",
          title: "Clarify execution authority",
          area: "tools",
          generalizable: true,
          evidence: ["P1 failed before writing a downloaded file"],
        },
      ],
    }),
  )
}

describe("cadence harness dashboard", () => {
  test("renders partial campaign data with safe observable-only details", async () => {
    await fixture()
    const report = await loadCampaignReport({ root, now: new Date("2026-08-13T12:00:00.000Z") })
    const html = renderCampaignHtml(report, path.join(root, "dashboard", "index.html"))

    expect(report.totals).toMatchObject({ planned: 20, observed: 1, completed: 1, tokens: 1_850 })
    expect(report.status).toBe("pending")
    expect(report.runs[0]?.metrics).toMatchObject({
      durationMs: 120_000,
      failures: 1,
      inferenceCalls: 2,
      toolCalls: 2,
      toolCriticalPathMs: 300,
      toolMaxConcurrency: 2,
      toolContractBytes: 45_561,
    })
    expect(report.improvements[0]?.title).toBe("Clarify execution authority")
    expect(html).toContain("Cadence harness campaign")
    expect(html).toContain("Use &lt;script&gt;bad()&lt;/script&gt; data")
    expect(html).toContain("&lt;img src=x onerror=bad()&gt;")
    expect(html).toContain("Bearer [redacted]")
    expect(html).toContain("api_key=[redacted]")
    expect(html).toContain("report.html")
    expect(html).toContain("Inference calls")
    expect(html).toContain("Tool critical path")
    expect(html).toContain("44.5 KB")
    expect(html).not.toContain("NEVER_RENDER")
    expect(html).not.toContain("outside.txt")
    expect(html).not.toContain("super-secret-value")
    expect(html).not.toContain('href="../runs/p01/trace.json"')
    expect(html).not.toContain('href="../runs/p01/prompt.md"')
  })

  test("deduplicates a provider failure repeated by run and trace capture", async () => {
    const duplicateRoot = path.join(root, "duplicate-failure")
    const run = path.join(duplicateRoot, "runs", "p01")
    await mkdir(run, { recursive: true })
    const failure = {
      kind: "model",
      id: "msg_provider_error",
      message: "Provider request failed",
      createdAt: 1_786_000_000_000,
    }
    await Bun.write(
      path.join(run, "run.json"),
      JSON.stringify({ promptId: "P1", status: "failed", failureCount: 1, failures: [failure] }),
    )
    await Bun.write(path.join(run, "trace.json"), JSON.stringify({ summary: { failureCount: 1 }, failures: [failure] }))

    const report = await loadCampaignReport({
      root: duplicateRoot,
      now: new Date("2026-08-13T12:00:00.000Z"),
    })

    expect(report.runs[0]?.failures).toHaveLength(1)
    expect(report.runs[0]?.metrics.failures).toBe(1)
  })

  test("renders recursive session totals and a per-session breakdown while preserving root metrics", async () => {
    const treeRoot = path.join(root, "session-tree")
    const run = path.join(treeRoot, "runs", "p01")
    const raw = path.join(run, "raw", "sessions")
    await Promise.all([
      mkdir(path.join(raw, "root"), { recursive: true }),
      mkdir(path.join(raw, "child"), { recursive: true }),
    ])
    await Bun.write(
      path.join(run, "run.json"),
      JSON.stringify({
        promptId: "P1",
        title: "Tree capture",
        status: "completed",
        sessionId: "root",
        metrics: { toolCalls: 2, failures: 1 },
      }),
    )
    await Bun.write(
      path.join(run, "trace.json"),
      JSON.stringify({
        summary: { toolCalls: 2, failureCount: 1, tokens: { input: 10, output: 2 } },
        tools: [{ id: "root-tool-1" }, { id: "root-tool-2" }],
        failures: [{ id: "shared", message: "shared" }],
      }),
    )
    await Bun.write(path.join(run, "executions.json"), JSON.stringify([{ id: "root-exec", status: "completed" }]))
    await Promise.all([
      Bun.write(path.join(raw, "root", "session.json"), JSON.stringify({ id: "root", title: "Root session" })),
      Bun.write(
        path.join(raw, "root", "trace.json"),
        JSON.stringify({
          session: { id: "root", status: "idle" },
          summary: { toolCalls: 2, failureCount: 1, tokens: { input: 10, output: 2 } },
          tools: [{ id: "root-tool-1" }, { id: "root-tool-2" }],
          approvals: [{ id: "approval-root" }],
          searches: [],
          children: [{ sessionID: "child", agent: "explore" }],
          failures: [{ id: "shared", message: "shared" }],
        }),
      ),
      Bun.write(path.join(raw, "root", "executions.json"), JSON.stringify([{ id: "root-exec", status: "completed" }])),
      Bun.write(
        path.join(raw, "child", "session.json"),
        JSON.stringify({ id: "child", parentID: "root", title: "Child session" }),
      ),
      Bun.write(
        path.join(raw, "child", "trace.json"),
        JSON.stringify({
          session: { id: "child", status: "idle" },
          summary: { toolCalls: 3, failureCount: 2, tokens: { input: 5, output: 1 } },
          tools: [{ id: "child-tool-1" }, { id: "child-tool-2" }, { id: "child-tool-3" }],
          approvals: [{ id: "approval-child" }],
          searches: [{ id: "search-child" }],
          children: [],
          failures: [
            { id: "shared", message: "shared" },
            { id: "child-failure", message: "child" },
          ],
        }),
      ),
      Bun.write(path.join(raw, "child", "executions.json"), JSON.stringify([{ id: "child-exec", status: "failed" }])),
    ])

    const report = await loadCampaignReport({ root: treeRoot, plannedPrompts: 1 })
    const html = renderCampaignHtml(report, path.join(treeRoot, "dashboard", "index.html"))

    expect(report.runs[0]?.metrics).toMatchObject({ toolCalls: 2, failures: 1 })
    expect(report.runs[0]?.treeMetrics).toMatchObject({
      sessionCount: 2,
      childSessionCount: 1,
      toolCalls: 5,
      searches: 1,
      approvals: 2,
      failures: 2,
      reportedFailures: 3,
      executions: 2,
      failedExecutions: 1,
      executionSessionCount: 2,
      captureComplete: true,
    })
    expect(report.totals.tree).toMatchObject({ runs: 1, sessions: 2, childSessions: 1, toolCalls: 5, failures: 2 })
    expect(html).toContain("Tree tool calls")
    expect(html).toContain("Session tree")
    expect(html).toContain("Root metrics remain the run summary")
    expect(html).toContain("Child session")
  })

  test("writes a standalone dashboard and tolerates a campaign with no runs", async () => {
    const empty = path.join(root, "empty")
    await mkdir(empty, { recursive: true })
    const { report, output } = await renderCampaignDashboard({
      root: empty,
      now: new Date("2026-08-13T12:00:00.000Z"),
    })
    const html = await Bun.file(output).text()

    expect(report.status).toBe("pending")
    expect(report.totals).toMatchObject({ planned: 20, observed: 0, pending: 20 })
    expect(output).toBe(path.join(empty, "dashboard", "index.html"))
    expect(html).toContain("No runs have been captured yet")
    expect(html).toContain("prefers-reduced-motion")
    expect(html).toContain("@media print")
  })

  test("derives resolved campaign and batch status and distinguishes event from visible-output latency", async () => {
    const semanticRoot = path.join(root, "semantic-status")
    await mkdir(path.join(semanticRoot, "runs"), { recursive: true })
    await Bun.write(
      path.join(semanticRoot, "campaign.json"),
      JSON.stringify({ id: "semantic", plannedPrompts: 3, status: "running" }),
    )
    const statuses = ["completed", "partial", "blocked"]
    await Promise.all(
      statuses.map(async (runStatus, index) => {
        const id = `p0${index + 1}`
        const directory = path.join(semanticRoot, "runs", id)
        await mkdir(directory, { recursive: true })
        await Bun.write(
          path.join(directory, "run.json"),
          JSON.stringify({
            runID: id,
            promptId: `P${index + 1}`,
            title: `Prompt ${index + 1}`,
            batchId: "batch-01",
            status: runStatus,
            completedAt: "2026-08-13T10:00:00.000Z",
            metrics: {
              failures: 0,
              timeToFirstEventMs: 125,
              timeToFirstVisibleTextMs: 875,
            },
          }),
        )
      }),
    )

    const report = await loadCampaignReport({
      root: semanticRoot,
      now: new Date("2026-08-13T12:00:00.000Z"),
    })
    const html = renderCampaignHtml(report, path.join(semanticRoot, "dashboard", "index.html"))

    expect(report.status).toBe("blocked")
    expect(report.totals).toMatchObject({ completed: 1, partial: 1, blocked: 1, pending: 0 })
    expect(report.batches[0]?.status).toBe("blocked")
    expect(report.runs[0]?.metrics).toMatchObject({ timeToFirstEventMs: 125, timeToFirstOutputMs: 875 })
    expect(html).toContain("First event")
    expect(html).toContain("First visible text")
    expect(html).toContain("125 ms")
    expect(html).toContain("875 ms")
  })

  test("downgrades stale running campaign and batch records when prompts remain but no run is active", async () => {
    const pausedRoot = path.join(root, "paused-campaign")
    const run = path.join(pausedRoot, "runs", "p01")
    const batch = path.join(pausedRoot, "batches", "batch-01")
    await Promise.all([mkdir(run, { recursive: true }), mkdir(batch, { recursive: true })])
    await Promise.all([
      Bun.write(
        path.join(pausedRoot, "campaign.json"),
        JSON.stringify({ id: "paused", plannedPrompts: 3, status: "running" }),
      ),
      Bun.write(
        path.join(run, "run.json"),
        JSON.stringify({ runID: "p01", promptId: "P1", batchId: "batch-01", status: "completed" }),
      ),
      Bun.write(
        path.join(batch, "batch.json"),
        JSON.stringify({ id: "batch-01", status: "running", runIds: ["p01", "p02", "p03"] }),
      ),
    ])

    const report = await loadCampaignReport({ root: pausedRoot, plannedPrompts: 3 })

    expect(report.status).toBe("pending")
    expect(report.totals).toMatchObject({ observed: 1, running: 0, pending: 2 })
    expect(report.batches[0]?.status).toBe("pending")
  })
})
