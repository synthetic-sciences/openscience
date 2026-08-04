import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

const skills = path.resolve(import.meta.dir, "../../skills")

async function run(script: string, args: string[]) {
  const process = Bun.spawn(["python", path.join(skills, script), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test("active-failure-audit builds an opaque committed probe manifest", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-audit-"))
  const source = path.join(dir, "private.jsonl")
  const output = path.join(dir, "manifest.json")
  await Bun.write(
    source,
    [
      JSON.stringify({
        id: "hard-1",
        hidden: { prompt: "PRIVATE_ALPHA", target: "answer-a" },
        features: [0.1, 0.9],
        stratum: "rare",
      }),
      JSON.stringify({
        id: "hard-2",
        hidden: { prompt: "PRIVATE_BETA", target: "answer-b" },
        features: [0.8, 0.2],
        stratum: "common",
        weight: 2,
        priorLoss: 0.7,
      }),
    ].join("\n"),
  )

  try {
    const result = await run("research/active-failure-audit/scripts/build_probe_manifest.py", [source, output])
    expect(result.code).toBe(0)
    const manifest = await Bun.file(output).text()
    expect(manifest).not.toContain("PRIVATE_ALPHA")
    expect(manifest).not.toContain("PRIVATE_BETA")
    const parsed = JSON.parse(manifest)
    expect(parsed.probes).toHaveLength(2)
    expect(parsed.probes[0].commitment).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.manifestSHA256).toMatch(/^[0-9a-f]{64}$/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("active-failure-audit rejects duplicate hidden probes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-audit-"))
  const source = path.join(dir, "private.jsonl")
  const output = path.join(dir, "manifest.json")
  await Bun.write(
    source,
    [
      JSON.stringify({ id: "a", hidden: { value: 1 }, features: [0], stratum: "x" }),
      JSON.stringify({ id: "b", hidden: { value: 1 }, features: [1], stratum: "y" }),
    ].join("\n"),
  )

  try {
    const result = await run("research/active-failure-audit/scripts/build_probe_manifest.py", [source, output])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("hidden probe commitments must be unique")
    expect(await Bun.file(output).exists()).toBe(false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("simulator-validation accepts a convergent invariant-preserving study", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-simulator-"))
  const source = path.join(dir, "study.json")
  const output = path.join(dir, "report.json")
  await Bun.write(
    source,
    JSON.stringify({
      simulator: {
        name: "reference-solver",
        version: "1.0.0",
        command: "reference-solver case.json",
        configSHA256: "0".repeat(64),
      },
      expectedOrder: 2,
      orderTolerance: 0.1,
      maxResidual: 1e-8,
      invariantTolerances: { mass_drift: 1e-6 },
      levels: [
        { label: "coarse", h: 0.1, error: 0.01, residual: 1e-9, invariants: { mass_drift: 2e-7 } },
        { label: "medium", h: 0.05, error: 0.0025, residual: 2e-9, invariants: { mass_drift: 3e-7 } },
        { label: "fine", h: 0.025, error: 0.000625, residual: 3e-9, invariants: { mass_drift: 4e-7 } },
      ],
    }),
  )

  try {
    const result = await run("physics/simulator-validation/scripts/validate_convergence.py", [
      source,
      "--output",
      output,
    ])
    expect(result.code).toBe(0)
    const report = JSON.parse(await Bun.file(output).text())
    expect(report.passed).toBe(true)
    expect(report.medianObservedOrder).toBeCloseTo(2)
    expect(report.checks["invariant:mass_drift"]).toBe(true)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("simulator-validation fails a refinement study with an excessive residual", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-simulator-"))
  const source = path.join(dir, "study.json")
  await Bun.write(
    source,
    JSON.stringify({
      simulator: { name: "solver", version: "1", command: "solver case", configSHA256: "a".repeat(64) },
      expectedOrder: 1,
      orderTolerance: 0,
      maxResidual: 1e-8,
      levels: [
        { label: "coarse", h: 0.1, error: 0.1, residual: 1e-9 },
        { label: "medium", h: 0.05, error: 0.05, residual: 2e-8 },
        { label: "fine", h: 0.025, error: 0.025, residual: 1e-9 },
      ],
    }),
  )

  try {
    const result = await run("physics/simulator-validation/scripts/validate_convergence.py", [source])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout).checks.residual_bound).toBe(false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("scientific-ablation-design accepts matched one-factor contrasts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ablation-"))
  const source = path.join(dir, "plan.json")
  const output = path.join(dir, "report.json")
  const context = { seeds: [1, 2, 3], budget: { candidates: 30 }, split: "held-out", evaluator: "eval-sha" }
  await Bun.write(
    source,
    JSON.stringify({
      metric: { name: "score", direction: "maximize" },
      baseline: { id: "full", config: { memory: "verified", search: "ucb" }, ...context },
      claims: [{ id: "memory-value", factor: "memory", from: "verified", to: "none" }],
      arms: [{ id: "no-memory", config: { memory: "none", search: "ucb" }, ...context }],
    }),
  )

  try {
    const result = await run("research/scientific-ablation-design/scripts/validate_ablation_plan.py", [
      source,
      "--output",
      output,
    ])
    expect(result.code).toBe(0)
    const report = JSON.parse(await Bun.file(output).text())
    expect(report.contrasts).toEqual([{ claim: "memory-value", baseline: "full", arm: "no-memory", factor: "memory" }])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("scientific-ablation-design rejects budget drift", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ablation-"))
  const source = path.join(dir, "plan.json")
  await Bun.write(
    source,
    JSON.stringify({
      metric: { name: "score", direction: "maximize" },
      baseline: {
        id: "full",
        config: { memory: "verified" },
        seeds: [1, 2],
        budget: { candidates: 30 },
        split: "held-out",
        evaluator: "eval-sha",
      },
      claims: [{ id: "memory-value", factor: "memory", from: "verified", to: "none" }],
      arms: [
        {
          id: "no-memory",
          config: { memory: "none" },
          seeds: [1, 2],
          budget: { candidates: 100 },
          split: "held-out",
          evaluator: "eval-sha",
        },
      ],
    }),
  )

  try {
    const result = await run("research/scientific-ablation-design/scripts/validate_ablation_plan.py", [source])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("drifts seed, budget, split, or evaluator")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
