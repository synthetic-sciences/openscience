import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, rm } from "node:fs/promises"
import { captureRun, summarize } from "../../../../evals/launch/capture"
import { validateLaunchSuite } from "../../../../evals/launch/validate"

const root = path.join(import.meta.dir, `.launch-capture-${process.pid}`)
const launch = path.resolve(import.meta.dir, "../../../../evals/launch")
const trace = {
  version: 1 as const,
  session: {
    id: "ses_launch_capture",
    title: "Launch capture",
    status: "idle" as const,
    createdAt: 1000,
    updatedAt: 1100,
  },
  summary: {
    timeToFirstUsefulOutputMs: 40,
    totalCompletionTimeMs: 100,
    cost: 0.02,
    tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 0 } },
    toolCalls: 0,
    childCount: 0,
    searchCount: 0,
    dedupeHits: 0,
    approvalCount: 0,
    artifactSaves: 0,
    failureCount: 0,
    retryCount: 0,
  },
  inference: [{ model: "echo", provider: "e2e", effort: "default", source: "local" as const, cost: 0.02 }],
  tools: [],
  children: [],
  searches: [],
  kernels: [],
  jobs: [],
  approvals: [],
  external: [{ kind: "model" as const, name: "echo", source: "local", external: false, cost: 0.02 }],
  artifacts: [],
  failures: [],
  retries: [],
  privacy: {
    local: true as const,
    atlasRequired: false as const,
    hiddenReasoningStored: false as const,
    toolOutputsCopied: false as const,
  },
}

afterAll(() => rm(root, { recursive: true, force: true }))

describe("launch capture", () => {
  test("preserves a raw trace and creates an unscored human review", async () => {
    const validation = await validateLaunchSuite(launch)
    const flow = validation.suite.flows.find((item) => item.id === "simple-question")
    expect(flow).toBeDefined()
    if (!flow) return

    const captured = await captureRun({
      root,
      flow,
      suiteVersion: validation.suite.version,
      suiteHash: validation.hash,
      dimensions: validation.rubric.dimensions.map((dimension) => dimension.id),
      gates: validation.rubric.hardGates.map((gate) => gate.id),
      trace,
      attempt: 1,
      phase: "baseline",
      runID: "simple-question-a1",
    })
    const raw = await Bun.file(path.join(captured.output, "trace.json")).json()
    const review = await Bun.file(path.join(captured.output, "review.json")).json()

    expect(raw.privacy.hiddenReasoningStored).toBe(false)
    expect(review.dimensions.task_completion.score).toBeNull()
    expect(review.hardGates.no_p0_p1.status).toBe("not_evaluated")
    expect(captured.result.observables.tokens.total).toBe(20)
    expect(captured.result.completion.observableComplete).toBe(true)
    expect(summarize([captured.result]).observableCompletionRate).toBe(1)
  })

  test("refuses to expose a held-out flow during development tuning", async () => {
    const validation = await validateLaunchSuite(launch)
    const flow = validation.suite.flows.find((item) => item.split === "held_out")
    expect(flow).toBeDefined()
    if (!flow) return

    expect(
      captureRun({
        root,
        flow,
        suiteVersion: validation.suite.version,
        suiteHash: validation.hash,
        dimensions: [],
        gates: [],
        trace,
        attempt: 1,
        phase: "development",
        runID: "held-out-a1",
      }),
    ).rejects.toThrow("cannot run during development tuning")
  })

  test("captures required artifacts from a directory root", async () => {
    const validation = await validateLaunchSuite(launch)
    const flow = validation.suite.flows.find((item) => item.id === "oauth-artifact")
    const artifacts = path.join(root, "artifact-root")
    expect(flow).toBeDefined()
    if (!flow) return

    await mkdir(artifacts, { recursive: true })
    await Bun.write(path.join(artifacts, "assay-decision.md"), "# Decision\n\nSupported by the source.")
    const captured = await captureRun({
      root,
      flow,
      suiteVersion: validation.suite.version,
      suiteHash: validation.hash,
      dimensions: [],
      gates: [],
      trace,
      attempt: 1,
      phase: "baseline",
      runID: "oauth-artifact-a1",
      artifactRoot: artifacts,
    })

    expect(captured.result.artifacts).toMatchObject([
      {
        path: "assay-decision.md",
        exists: true,
        valid: true,
      },
    ])
  })
})
