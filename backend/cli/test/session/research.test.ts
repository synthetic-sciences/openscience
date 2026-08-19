import { expect, test } from "bun:test"
import { SessionResearch } from "../../src/session/research"

test("explicit deliverables replace generic template filenames", async () => {
  const sessionID = `ses_research_${crypto.randomUUID()}`
  try {
    const contract = await SessionResearch.define(sessionID, {
      objective: "Build a claim matrix",
      domain: "evidence",
      template: "evidence",
      deliverables: [
        { path: "sources.json", label: "Source records", required: true },
        { path: "claim_evidence.csv", label: "Claim matrix", required: true },
      ],
    })
    expect(contract.deliverables.map((item) => item.path)).toEqual(["sources.json", "claim_evidence.csv"])
  } finally {
    await SessionResearch.remove(sessionID)
  }
})

test("persists, resumes, and truthfully assesses a research completion contract", async () => {
  const sessionID = `ses_research_${crypto.randomUUID()}`
  try {
    const created = await SessionResearch.define(sessionID, {
      objective: "Compare calibrated estimators",
      domain: "statistics",
      template: "empirical",
      deliverables: [
        { path: "analysis.py", label: "Rerunnable analysis", required: true },
        { path: "metrics.json", label: "Machine-readable metrics", required: true },
        { path: "report.md", label: "Research report", required: true },
        { path: "REPRODUCE.md", label: "Reproduction instructions", required: true },
        { path: "figures/*.png", label: "Checked figures", required: true },
      ],
      reserveUsd: 1.25,
    })
    expect(created.stages.map((stage) => stage.id)).toContain("calibrate")
    expect(created.deliverables.map((item) => item.path)).toContain("metrics.json")
    expect(await SessionResearch.read(sessionID)).toEqual(created)

    for (const stage of created.stages) {
      await SessionResearch.stage(sessionID, { id: stage.id, status: "completed", detail: "verified" })
    }
    for (const check of created.checks) {
      await SessionResearch.check(sessionID, {
        id: check.id,
        status: "passed",
        evidence: "clean process output",
      })
    }
    await SessionResearch.fail(sessionID, {
      stage: "infer",
      candidate: "unregularized fit",
      message: "optimizer diverged",
      disposition: "retained as a failed candidate",
    })

    const contract = (await SessionResearch.read(sessionID))!
    const assessment = SessionResearch.assess(contract, {
      artifacts: [
        { path: "analysis.py" },
        { path: "metrics.json" },
        { path: "report.md" },
        { path: "REPRODUCE.md" },
        { path: "figures/calibration.png" },
      ],
      jobs: [{ status: "completed" }],
      kernels: [{ status: "completed" }],
      findings: [{ verdict: "supports", status: undefined, severity: "info" }],
      reviewed: true,
      busy: false,
    })
    expect(assessment).toMatchObject({ status: "ready", readiness: 100, failedCandidates: 1 })

    const recovered = SessionResearch.assess(contract, {
      artifacts: [
        { path: "analysis.py" },
        { path: "metrics.json" },
        { path: "report.md" },
        { path: "REPRODUCE.md" },
        { path: "figures/calibration.png" },
      ],
      jobs: [{ status: "failed" }, { status: "completed" }],
      kernels: [{ status: "error" }, { status: "completed" }],
      findings: [{ verdict: "supports", status: "confirmed", severity: "info" }],
      reviewed: true,
      busy: false,
    })
    expect(recovered).toMatchObject({ status: "ready", readiness: 100 })
    expect(recovered.gates.find((gate) => gate.id === "runtime")).toMatchObject({
      status: "passed",
      detail: "2 failed runtime attempts are retained; final checks and review passed",
    })

    expect(await SessionResearch.preflight(sessionID, 1.2)).toBe("finalize")
    expect(await SessionResearch.prompt(sessionID)).toContain("managed-credit reserve is active")
    expect(await SessionResearch.preflight(sessionID, 1.2)).toBe("block")
    await SessionResearch.exhaust(sessionID, 0)
    expect((await SessionResearch.read(sessionID))?.budget).toMatchObject({ exhausted: true, lastBalanceUsd: 0 })
  } finally {
    await SessionResearch.remove(sessionID)
  }
})

test("blocks readiness on unresolved review findings and runtime failures", async () => {
  const sessionID = `ses_research_${crypto.randomUUID()}`
  try {
    const contract = await SessionResearch.define(sessionID, {
      objective: "Validate a physical simulation",
      domain: "physics",
      template: "minimal",
    })
    const assessment = SessionResearch.assess(contract, {
      artifacts: [],
      jobs: [{ status: "failed" }],
      kernels: [{ status: "error" }],
      findings: [{ verdict: "refutes", status: "open", severity: "major" }],
      reviewed: true,
      busy: false,
    })

    expect(assessment.status).toBe("blocked")
    expect(assessment.gates.find((gate) => gate.id === "review")?.status).toBe("failed")
    expect(assessment.gates.find((gate) => gate.id === "runtime")?.detail).toContain("2 kernel or compute failures")
  } finally {
    await SessionResearch.remove(sessionID)
  }
})
