import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessLaunch } from "../../src/session/harness/launch"

const skills = path.resolve(import.meta.dir, "../../skills")

const hash = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const canon = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canon(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}
const digest = (value: unknown) => hash(canon(value))
const fileHash = async (file: string) => hash(new Uint8Array(await Bun.file(file).arrayBuffer()))

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

async function exec(args: string[], cwd: string) {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (code) throw new Error(`${args.join(" ")} failed: ${stderr || stdout}`)
  return stdout.trim()
}

async function launchFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-launch-"))
  const workspace = path.join(dir, "checkout")
  const results = path.join(dir, "results")
  const dataset = path.join(dir, "dataset")
  const agent = path.join(dir, "agent")
  await Promise.all([
    fs.mkdir(path.join(workspace, "benchmark"), { recursive: true }),
    fs.mkdir(path.join(workspace, "tasks"), { recursive: true }),
    fs.mkdir(results, { recursive: true }),
    fs.mkdir(dataset, { recursive: true }),
    fs.mkdir(agent, { recursive: true }),
  ])
  await Promise.all([
    Bun.write(path.join(workspace, "benchmark", "run.py"), "print('runner')\n"),
    Bun.write(path.join(workspace, "benchmark", "evaluate.py"), "print('evaluator')\n"),
    Bun.write(path.join(workspace, "tasks", "task-17.json"), JSON.stringify({ id: "task-17" })),
    Bun.write(path.join(workspace, "pyproject.toml"), "[project]\nname='benchmark'\n"),
    Bun.write(path.join(workspace, "uv.lock"), "version = 1\n"),
  ])
  await exec(["git", "init", "-q"], workspace)
  await exec(["git", "config", "user.name", "Benchmark Test"], workspace)
  await exec(["git", "config", "user.email", "benchmark@example.test"], workspace)
  await exec(["git", "remote", "add", "origin", "https://github.com/example/official-benchmark.git"], workspace)
  await exec(["git", "add", "."], workspace)
  await exec(["git", "commit", "-qm", "fixture"], workspace)
  const revision = await exec(["git", "rev-parse", "HEAD"], workspace)

  await Promise.all([
    Bun.write(path.join(dataset, "REVISION"), "release-2026-08\n"),
    Bun.write(path.join(dataset, "manifest.json"), JSON.stringify({ files: ["held-out.bin"] })),
    Bun.write(path.join(results, "replay-1.json"), JSON.stringify({ score: 0.8 })),
    Bun.write(path.join(results, "replay-2.json"), JSON.stringify({ score: 0.8 })),
    Bun.write(path.join(results, "artifact-export.bin"), "artifact-bytes"),
    Bun.write(path.join(results, "artifact-import.bin"), "artifact-bytes"),
    Bun.write(path.join(results, "baseline.bin"), "baseline-bytes"),
    Bun.write(path.join(results, "baseline-score.json"), JSON.stringify({ metrics: { score: 0.5 } })),
  ])

  const receipt = path.join(dir, "boundary.json")
  const probed = await run("research/verify-benchmark-launch/scripts/validate_launch.py", [
    "probe-boundary",
    "--agent-root",
    agent,
    "--hidden-path",
    path.join(dir, "unmounted-hidden", "canary"),
    "--output",
    receipt,
  ])
  if (probed.code) throw new Error(probed.stderr)
  const boundary = JSON.parse(await Bun.file(receipt).text())
  const files = ["pyproject.toml", "uv.lock"]
  const locks = await Promise.all(
    files.map(async (name) => ({ path: name, sha256: await fileHash(path.join(workspace, name)) })),
  )
  const command = ["python", "benchmark/run.py", "--task", "task-17"]
  const manifest = path.join(dir, "launch.json")
  await Bun.write(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      workspace,
      resultsRoot: results,
      runner: {
        repository: "https://github.com/example/official-benchmark",
        revision,
        entrypoint: "benchmark/run.py",
        command,
        commandSHA256: digest(command),
        environment: { files, sha256: digest(locks.toSorted((left, right) => left.path.localeCompare(right.path))) },
      },
      dataset: {
        name: "official-data",
        source: "https://example.org/official-data",
        root: dataset,
        revision: "release-2026-08",
        revisionFile: "REVISION",
        manifest: "manifest.json",
        manifestSHA256: await fileHash(path.join(dataset, "manifest.json")),
      },
      task: {
        manifest: "tasks/task-17.json",
        sha256: await fileHash(path.join(workspace, "tasks", "task-17.json")),
      },
      evaluator: {
        artifact: "benchmark/evaluate.py",
        sha256: await fileHash(path.join(workspace, "benchmark", "evaluate.py")),
      },
      boundary: {
        receipt,
        receiptSHA256: await fileHash(receipt),
        agentRoot: agent,
        hiddenCommitments: boundary.checks.map((item: { commitment: string }) => item.commitment),
      },
      replay: { first: "replay-1.json", second: "replay-2.json" },
      roundtrip: { exported: "artifact-export.bin", imported: "artifact-import.bin" },
      baseline: {
        name: "official-baseline",
        artifact: "baseline.bin",
        artifactSHA256: await fileHash(path.join(results, "baseline.bin")),
        scoreFile: "baseline-score.json",
        scoreKey: "metrics.score",
        expectedScore: 0.5,
        tolerance: 1e-9,
      },
    }),
  )
  return { dir, manifest, results }
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

test("verify-benchmark-launch validates real Git state and replay artifacts", async () => {
  const fixture = await launchFixture()
  const output = path.join(fixture.dir, "report.json")
  try {
    const result = await run("research/verify-benchmark-launch/scripts/validate_launch.py", [
      "validate",
      fixture.manifest,
      "--output",
      output,
    ])
    expect(result.code).toBe(0)
    const report = JSON.parse(await Bun.file(output).text())
    expect(HarnessContract.Launch.parse(report.protocol)).toEqual(report.protocol)
    expect(HarnessLaunch.Validator.parse(report.validator)).toEqual(report.validator)
    expect(report).toMatchObject({
      status: "passed",
      baselineScore: 0.5,
      protocol: { protocolVersion: "benchmark-launch-v1" },
      validator: { name: "verify-benchmark-launch", version: "1" },
    })
    expect(report.checks.map((item: { id: string; status: string }) => [item.id, item.status])).toEqual([
      ["clean_checkout", "passed"],
      ["locked_environment", "passed"],
      ["task_manifest_load", "passed"],
      ["evaluator_load", "passed"],
      ["hidden_boundary", "passed"],
      ["deterministic_replay", "passed"],
      ["artifact_roundtrip", "passed"],
      ["baseline_replay", "passed"],
    ])
    expect(report.protocol.validatorSHA256).toBe(report.validator.scriptSHA256)
  } finally {
    await fs.rm(fixture.dir, { recursive: true, force: true })
  }
})

test("verify-benchmark-launch fails a nondeterministic official replay", async () => {
  const fixture = await launchFixture()
  try {
    await Bun.write(path.join(fixture.results, "replay-2.json"), JSON.stringify({ score: 0.81 }))
    const result = await run("research/verify-benchmark-launch/scripts/validate_launch.py", [
      "validate",
      fixture.manifest,
    ])
    expect(result.code).toBe(1)
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe("failed")
    expect(report.checks.find((item: { id: string }) => item.id === "deterministic_replay").status).toBe("failed")
    expect(report.failures).toContain("deterministic_replay:replay-mismatch")
  } finally {
    await fs.rm(fixture.dir, { recursive: true, force: true })
  }
})
