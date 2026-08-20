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

    await SessionResearch.trial(sessionID, {
      stage: "simulate",
      branch: "baseline",
      candidate: "calibrated estimator simulation",
      outcome: "advanced",
      summary: "Produced finite calibration metrics",
      evidence: "metrics.json",
    })
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

test("persists material attempts and changes trajectory strategy without repeating dead ends", async () => {
  const sessionID = `ses_research_${crypto.randomUUID()}`
  try {
    const contract = await SessionResearch.define(sessionID, {
      objective: "Compare robust estimators",
      domain: "general",
      template: "minimal",
    })
    expect(SessionResearch.strategy(contract)).toMatchObject({ mode: "explore", stage: "scope", attempts: 0 })

    await SessionResearch.trial(sessionID, {
      stage: "scope",
      branch: "linear",
      candidate: "untrimmed mean",
      outcome: "failed",
      summary: "A single outlier dominated the estimate",
      evidence: "metrics.json:mae",
    })
    const repeated = await SessionResearch.trial(
      sessionID,
      {
        stage: "scope",
        branch: "linear",
        candidate: "Untrimmed mean",
        outcome: "neutral",
        summary: "A seed-only change did not alter the failure",
      },
      "call-repeat",
    )
    await SessionResearch.trial(
      sessionID,
      {
        stage: "scope",
        branch: "linear",
        candidate: "Untrimmed mean",
        outcome: "neutral",
        summary: "A seed-only change did not alter the failure",
      },
      "call-repeat",
    )
    expect((await SessionResearch.read(sessionID))?.trials).toHaveLength(2)
    expect(SessionResearch.strategy(repeated)).toMatchObject({
      mode: "pivot",
      attempts: 2,
      branches: 1,
      repeatedCandidates: ["untrimmed mean"],
    })

    await SessionResearch.trial(sessionID, {
      stage: "scope",
      branch: "trimmed",
      candidate: "ten percent trimmed mean",
      outcome: "advanced",
      summary: "Reduced error under the frozen contamination case",
      evidence: "metrics.json:trimmed_mae",
    })
    const fused = await SessionResearch.trial(sessionID, {
      stage: "scope",
      branch: "median",
      candidate: "median of means",
      outcome: "advanced",
      summary: "Improved the heavy-tail control independently",
      evidence: "metrics.json:mom_mae",
    })
    expect(SessionResearch.strategy(fused)).toMatchObject({ mode: "fuse", attempts: 4, branches: 3 })

    const prompt = await SessionResearch.prompt(sessionID)
    expect(prompt).toContain("Trajectory control:")
    expect(prompt).toContain("Mode: fuse")
    expect(prompt).toContain("trimmed/ten percent trimmed mean")
    expect(prompt).toContain("median/median of means")

    await SessionResearch.trial(sessionID, {
      stage: "execute",
      branch: "fused",
      candidate: "fused robust estimator",
      outcome: "advanced",
      summary: "Combined the independent robust branches",
      evidence: "metrics.json:fused_mae",
    })
    for (const stage of fused.stages) {
      await SessionResearch.stage(sessionID, { id: stage.id, status: "completed" })
    }
    expect(SessionResearch.strategy((await SessionResearch.read(sessionID))!)).toMatchObject({ mode: "verify" })
  } finally {
    await SessionResearch.remove(sessionID)
  }
})

test("requires a material trial before the domain decision stage can complete", async () => {
  const sessionID = `ses_research_${crypto.randomUUID()}`
  try {
    await SessionResearch.define(sessionID, {
      objective: "Compare robust estimators",
      domain: "statistics",
      template: "minimal",
    })
    expect(
      SessionResearch.stage(sessionID, {
        id: "simulate",
        status: "completed",
        detail: "simulation finished",
      }),
    ).rejects.toThrow("at least one material trial")

    await SessionResearch.trial(sessionID, {
      stage: "simulate",
      branch: "median",
      candidate: "sample median",
      outcome: "advanced",
      summary: "Reduced contaminated RMSE",
      evidence: "metrics.json:sample_median.rmse",
    })
    expect(
      await SessionResearch.stage(sessionID, {
        id: "simulate",
        status: "completed",
        detail: "simulation finished",
      }),
    ).toMatchObject({
      stages: expect.arrayContaining([expect.objectContaining({ id: "simulate", status: "completed" })]),
    })
  } finally {
    await SessionResearch.remove(sessionID)
  }
})

test("retains stage boundary evidence without treating it as a verification check", async () => {
  const sessionID = `ses_research_${crypto.randomUUID()}`
  try {
    const contract = await SessionResearch.define(sessionID, {
      objective: "Verify a physical simulation",
      domain: "physics",
      template: "minimal",
    })
    const updated = await SessionResearch.stage(sessionID, {
      id: "model",
      status: "completed",
      detail: "model.json matches the frozen specification",
    })
    expect(updated.stages.find((stage) => stage.id === "model")?.detail).toBe(
      "model.json matches the frozen specification",
    )
    expect(updated.checks).toEqual(contract.checks)
  } finally {
    await SessionResearch.remove(sessionID)
  }
})

test("loads pre-trajectory contracts with an empty attempt ledger", () => {
  const parsed = SessionResearch.Contract.parse({
    version: 1,
    objective: "Legacy contract",
    domain: "general",
    template: "minimal",
    stages: [],
    deliverables: [],
    checks: [],
    failures: [],
    budget: {
      reserveUsd: 1,
      finalizationCalls: 0,
      finalizing: false,
      exhausted: false,
      updatedAt: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  })
  expect(parsed.trials).toEqual([])
})

test("requires evidence before a trial may claim advancement or regression", () => {
  expect(
    SessionResearch.Trial.safeParse({
      id: "trial-1",
      stage: "scope",
      branch: "robust",
      candidate: "trimmed mean",
      outcome: "advanced",
      summary: "Lower error",
      recordedAt: 1,
    }).success,
  ).toBe(false)
  expect(
    SessionResearch.Trial.safeParse({
      id: "trial-2",
      stage: "scope",
      branch: "robust",
      candidate: "trimmed mean",
      outcome: "advanced",
      summary: "Lower error",
      evidence: "metrics.json:mae",
      recordedAt: 1,
    }).success,
  ).toBe(true)
})

test("requires observed evidence before a verification check may settle", async () => {
  const sessionID = `ses_research_${crypto.randomUUID()}`
  try {
    const contract = await SessionResearch.define(sessionID, {
      objective: "Verify a saved result",
      domain: "general",
      template: "minimal",
    })
    const check = contract.checks[0]
    await expect(SessionResearch.check(sessionID, { id: check.id, status: "passed" })).rejects.toThrow(
      "requires observed evidence",
    )

    const legacy = {
      ...contract,
      checks: [{ ...check, status: "passed" as const }],
    }
    const assessment = SessionResearch.assess(legacy, {
      artifacts: [],
      jobs: [],
      kernels: [],
      findings: [],
      reviewed: false,
      busy: false,
    })
    expect(assessment.gates.find((gate) => gate.id === "checks")).toMatchObject({ status: "pending", complete: 0 })

    expect(
      await SessionResearch.check(sessionID, {
        id: check.id,
        status: "passed",
        evidence: "verification.log: exit 0",
      }),
    ).toMatchObject({ checks: [expect.objectContaining({ id: check.id, status: "passed" })] })
  } finally {
    await SessionResearch.remove(sessionID)
  }
})

test("promotes project research lessons across independent sessions and retires contradictions", async () => {
  const projectID = `prj_experience_${crypto.randomUUID()}`
  const otherID = `prj_experience_${crypto.randomUUID()}`
  const firstID = `ses_research_${crypto.randomUUID()}`
  const secondID = `ses_research_${crypto.randomUUID()}`
  const thirdID = `ses_research_${crypto.randomUUID()}`
  const physicsID = `ses_research_${crypto.randomUUID()}`
  const situation = "the contamination rate is unknown and may exceed ten percent"
  const guidance = "compare a bounded-influence estimator against the frozen classical baseline"
  try {
    for (const sessionID of [firstID, secondID, thirdID]) {
      await SessionResearch.define(sessionID, {
        objective: "Compare robust estimators",
        domain: "statistics",
        template: "minimal",
      })
    }
    await SessionResearch.define(physicsID, {
      objective: "Validate a numerical solver",
      domain: "physics",
      template: "minimal",
    })
    await SessionResearch.trial(
      firstID,
      {
        stage: "simulate",
        branch: "robust",
        candidate: "Huber estimator",
        outcome: "advanced",
        summary: "Reduced error under the frozen contamination sweep",
        evidence: "metrics-first.json:huber.rmse",
      },
      "support-first",
    )
    const first = await SessionResearch.learn(projectID, firstID, {
      sourceTrial: "trial-support-first",
      situation,
      guidance,
    })
    expect(first).toMatchObject({ confidence: "tentative", status: "active", supports: [{ sessionID: firstID }] })
    expect(first.supports[0].evidence).toBe("metrics-first.json:huber.rmse")

    const duplicate = await SessionResearch.learn(projectID, firstID, {
      sourceTrial: "trial-support-first",
      situation,
      guidance,
      evidence: "metrics-first.json:huber.rmse",
    })
    expect(duplicate.supports).toHaveLength(1)

    await SessionResearch.trial(
      secondID,
      {
        stage: "simulate",
        branch: "robust",
        candidate: "Tukey estimator",
        outcome: "advanced",
        summary: "Confirmed the method-family advantage on an independent session",
        evidence: "metrics-second.json:tukey.rmse",
      },
      "support-second",
    )
    const supported = await SessionResearch.learn(projectID, secondID, {
      sourceTrial: "trial-support-second",
      situation: `  ${situation.toUpperCase()}  `,
      guidance: ` ${guidance.toUpperCase()} `,
      evidence: "metrics-second.json:tukey.rmse",
    })
    expect(supported).toMatchObject({ confidence: "supported", status: "active" })
    expect(supported.supports).toHaveLength(2)
    expect(supported.situation).toBe(situation)
    expect(supported.guidance).toBe(guidance)

    const prompt = await SessionResearch.prompt(secondID, projectID)
    expect(prompt).toContain("Project research experience")
    expect(prompt).toContain(`[supported] ${supported.id}`)
    expect(prompt).toContain(`situation=${JSON.stringify(situation)}`)
    expect(prompt).toContain(`guidance=${JSON.stringify(guidance)}`)
    expect(prompt).not.toContain("metrics-second.json:tukey.rmse")
    expect(await SessionResearch.prompt(secondID, otherID)).not.toContain("Project research experience")

    await SessionResearch.trial(
      physicsID,
      {
        stage: "solve",
        branch: "finite-difference",
        candidate: "Stable explicit solver",
        outcome: "advanced",
        summary: "The frozen-grid solver met its convergence criterion",
        evidence: "physics-metrics.json:order",
      },
      "physics-support",
    )
    await expect(
      SessionResearch.unlearn(projectID, physicsID, {
        lesson: supported.id,
        sourceTrial: "trial-physics-support",
        reason: "A physics trial must not mutate statistics experience",
        evidence: "physics-metrics.json:order",
      }),
    ).rejects.toThrow("belongs to the statistics domain")

    await SessionResearch.trial(
      thirdID,
      {
        stage: "simulate",
        branch: "clean-data",
        candidate: "classical estimator under verified Gaussian data",
        outcome: "regressed",
        summary: "The robust estimator lost efficiency after contamination was ruled out",
        evidence: "metrics-third.json:efficiency",
      },
      "contradiction",
    )
    const rejected = await SessionResearch.unlearn(projectID, thirdID, {
      lesson: supported.id,
      sourceTrial: "trial-contradiction",
      reason: "The prior is invalid after contamination is ruled out",
      evidence: "metrics-third.json:efficiency",
    })
    expect(rejected).toMatchObject({ status: "rejected", contradictions: [{ sessionID: thirdID }] })
    expect(await SessionResearch.prompt(thirdID, projectID)).not.toContain(`[supported] ${supported.id}`)
  } finally {
    await Promise.all([firstID, secondID, thirdID, physicsID].map((sessionID) => SessionResearch.remove(sessionID)))
    await Promise.all([projectID, otherID].map((id) => SessionResearch.removeExperience(id)))
  }
})
