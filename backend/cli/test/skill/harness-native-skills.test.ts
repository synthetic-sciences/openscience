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
  const driver = { kind: "argv", entrypoint: "benchmark/run.py", cwd: ".", argv: command }
  const recipe = path.join(dir, "recipe.json")
  const recipeSHA256 = digest({ id: "fixture-official-v2" })
  const driverSHA256 = digest(driver)
  await Bun.write(
    recipe,
    JSON.stringify({
      schemaVersion: 2,
      recipeSHA256,
      driverSHA256,
      entrypoint: "benchmark/run.py",
      launchStage: "run",
      stages: [{ id: "run", driver }],
    }),
  )
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
        recipe: {
          artifact: recipe,
          artifactSHA256: await fileHash(recipe),
          recipeSHA256,
          driverSHA256,
        },
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
  return { dir, manifest, recipe, results }
}

async function pilotFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-pilot-"))
  const workspace = path.join(dir, "checkout")
  const results = path.join(dir, "results")
  const recipe = path.join(dir, "recipe.json")
  const manifest = path.join(dir, "pilot.json")
  await fs.mkdir(workspace, { recursive: true })
  await Promise.all([
    Bun.write(
      path.join(workspace, "runner.py"),
      [
        "import argparse, json",
        "parser = argparse.ArgumentParser()",
        "parser.add_argument('--output', required=True)",
        "args = parser.parse_args()",
        "open(args.output, 'w', encoding='utf-8').write(json.dumps({'scores': [1, 0, 1]}))",
      ].join("\n"),
    ),
    Bun.write(path.join(workspace, "pyproject.toml"), "[project]\nname='pilot-fixture'\nversion='1.0.0'\n"),
    Bun.write(path.join(workspace, ".gitignore"), "pilot-score.json\n"),
  ])
  await exec(["git", "init", "--initial-branch=main", "-q"], workspace)
  await exec(["git", "config", "user.name", "Benchmark Test"], workspace)
  await exec(["git", "config", "user.email", "benchmark@example.test"], workspace)
  await exec(["git", "remote", "add", "origin", "https://github.com/example/pilot-benchmark.git"], workspace)
  await exec(["git", "add", "."], workspace)
  await exec(["git", "commit", "-qm", "fixture"], workspace)
  const revision = await exec(["git", "rev-parse", "HEAD"], workspace)
  const driver = {
    kind: "argv",
    entrypoint: "runner.py",
    cwd: ".",
    argv: ["python", "runner.py", "--output", "pilot-score.json"],
  }
  await Bun.write(
    recipe,
    JSON.stringify({
      schemaVersion: 2,
      recipeID: "fixture-official-v2",
      benchmark: "mle",
      recipeSHA256: digest({ id: "fixture-official-v2" }),
      bindingsSHA256: digest({}),
      driverSHA256: digest(driver),
      entrypoint: "runner.py",
      bindings: {},
      environment: { manager: "setuptools", python: ">=3.11", files: ["pyproject.toml"] },
      anchors: ["runner.py"],
      runtime: [],
      stages: [
        {
          id: "evaluate",
          role: "evaluate",
          driver,
          inputs: [],
          outputs: ["pilot-score.json"],
          environment: [],
        },
      ],
      launchStage: "evaluate",
      artifacts: [
        {
          id: "scores",
          kind: "file",
          path: "pilot-score.json",
          format: "json",
          cardinality: { minimum: 1, maximum: 1 },
          producedBy: "evaluate",
          owner: "evaluator",
        },
      ],
      metrics: [
        {
          name: "accuracy",
          artifact: "scores",
          selector: { kind: "jsonpath", path: "$.scores" },
          direction: "maximize",
          aggregation: "mean",
        },
      ],
      limitations: ["fixture"],
    }),
  )
  await Bun.write(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      workspace,
      resultsRoot: results,
      source: { repository: "https://github.com/example/pilot-benchmark", revision },
      recipe,
      timeoutSeconds: 30,
      runtime: {},
    }),
  )
  return { dir, workspace, results, recipe, manifest }
}

async function pythonPilotFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-python-pilot-"))
  const workspace = path.join(dir, "checkout")
  const results = path.join(dir, "results")
  const recipe = path.join(dir, "recipe.json")
  const manifest = path.join(dir, "pilot.json")
  const runtime = path.join(dir, "evaluations.json")
  await fs.mkdir(workspace, { recursive: true })
  await Promise.all([
    Bun.write(
      path.join(workspace, "bench.py"),
      [
        "class Evaluator:",
        "    def __init__(self, scale):",
        "        self.scale = scale",
        "    def evaluate(self, evaluations, batch_size):",
        "        return [value * self.scale for value in evaluations[:batch_size]]",
      ].join("\n"),
    ),
    Bun.write(path.join(workspace, "pyproject.toml"), "[project]\nname='python-pilot'\nversion='1.0.0'\n"),
    Bun.write(runtime, JSON.stringify([1, 2, 3, 100])),
  ])
  await exec(["git", "init", "--initial-branch=main", "-q"], workspace)
  await exec(["git", "config", "user.name", "Benchmark Test"], workspace)
  await exec(["git", "config", "user.email", "benchmark@example.test"], workspace)
  await exec(["git", "remote", "add", "origin", "https://github.com/example/python-pilot.git"], workspace)
  await exec(["git", "add", "."], workspace)
  await exec(["git", "commit", "-qm", "fixture"], workspace)
  const revision = await exec(["git", "rev-parse", "HEAD"], workspace)
  const load = {
    kind: "python_api",
    entrypoint: "bench.py",
    module: "bench",
    symbol: "Evaluator",
    kwargs: { scale: 2 },
    arguments: {},
  }
  const evaluate = {
    kind: "python_api",
    entrypoint: "bench.py",
    module: "bench",
    symbol: "Evaluator.evaluate",
    receiver: "evaluator",
    kwargs: { batch_size: 3 },
    arguments: { evaluations: "evaluations" },
  }
  await Bun.write(
    recipe,
    JSON.stringify({
      schemaVersion: 2,
      recipeID: "python-fixture-official-v2",
      benchmark: "biomni",
      recipeSHA256: digest({ id: "python-fixture-official-v2" }),
      bindingsSHA256: digest({}),
      driverSHA256: digest(evaluate),
      entrypoint: "bench.py",
      bindings: {},
      environment: { manager: "setuptools", python: ">=3.11", files: ["pyproject.toml"] },
      anchors: ["bench.py"],
      runtime: [{ name: "evaluations", kind: "json", owner: "runner", description: "fixture values" }],
      stages: [
        {
          id: "load",
          role: "prepare",
          driver: load,
          inputs: [],
          outputs: [],
          environment: [],
          produces: "evaluator",
        },
        {
          id: "evaluate",
          role: "evaluate",
          driver: evaluate,
          inputs: [],
          outputs: [],
          environment: [],
          produces: "rewards",
        },
      ],
      launchStage: "evaluate",
      artifacts: [
        {
          id: "rewards",
          kind: "return",
          format: "json",
          producedBy: "evaluate",
          owner: "evaluator",
          value: "rewards",
        },
      ],
      metrics: [
        {
          name: "mean-reward",
          artifact: "rewards",
          selector: { kind: "jsonpath", path: "$[*]" },
          direction: "maximize",
          aggregation: "mean",
        },
      ],
      limitations: ["fixture"],
    }),
  )
  await Bun.write(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      workspace,
      resultsRoot: results,
      source: { repository: "https://github.com/example/python-pilot", revision },
      recipe,
      timeoutSeconds: 30,
      runtime: { evaluations: { kind: "json", artifact: runtime, sha256: await fileHash(runtime) } },
    }),
  )
  return { dir, results, manifest }
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

test("verify-benchmark-integrity derives observable violations from an evaluator-owned trace", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-integrity-"))
  const trace = path.join(dir, "trace.jsonl")
  const contract = path.join(dir, "contract.json")
  const subject = path.join(dir, "subject.json")
  const model = path.join(dir, "model.json")
  const audits = path.join(dir, "audits.json")
  const output = path.join(dir, "submission.json")
  const report = path.join(dir, "report.json")
  const canaries = hash("canaries")
  const commitments = await run("research/verify-benchmark-integrity/scripts/verify_integrity.py", ["commitments"])
  expect(commitments.code).toBe(0)
  const pins = JSON.parse(commitments.stdout)
  const kinds = ["test_item_contamination", "external_model_use", "benchmark_lookup"]
  const identities = kinds.map((kind) => ({
    kind,
    name: `${kind}-auditor`,
    version: "1",
    promptSHA256: hash(`${kind}-prompt`),
  }))
  await Promise.all([
    Bun.write(
      contract,
      JSON.stringify({
        protocolVersion: "benchmark-integrity-v1",
        validatorSHA256: pins.validatorSHA256,
        traceSchemaSHA256: pins.traceSchemaSHA256,
        minEvents: 4,
        minCoverage: 0.9,
        assignedModel: {
          name: "assigned-model",
          baseArtifactSHA256: hash("base"),
          configSHA256: hash("config"),
        },
        forbiddenModelArtifacts: [hash("forbidden")],
        policy: {
          testItemDerivation: "forbidden",
          unapprovedExternalModels: "forbidden",
          benchmarkLookup: "forbidden",
        },
        auditors: identities,
        hiddenCanaryManifestSHA256: canaries,
        minHiddenCanaries: 2,
      }),
    ),
    Bun.write(
      trace,
      [
        { seq: 0, at: 1_000, kind: "command" },
        { seq: 1, at: 1_001, kind: "model_call", approved: true },
        { seq: 2, at: 1_002, kind: "model_call", approved: false },
        { seq: 3, at: 1_003, kind: "benchmark_lookup" },
        { seq: 4, at: 1_004, kind: "hidden_canary", manifestSHA256: canaries, canaryID: "a", violation: false },
        { seq: 5, at: 1_005, kind: "hidden_canary", manifestSHA256: canaries, canaryID: "b", violation: true },
        { seq: 6, at: 1_006, kind: "trace_gap", dropped: 1 },
      ]
        .map((item) => JSON.stringify(item))
        .join("\n"),
    ),
    Bun.write(
      subject,
      JSON.stringify({ type: "run", id: "run-1", artifact: { uri: "artifact:output", sha256: hash("output") } }),
    ),
    Bun.write(
      model,
      JSON.stringify({
        name: "assigned-model",
        baseArtifactSHA256: hash("base"),
        configSHA256: hash("config"),
        outputArtifactSHA256: hash("fine-tuned"),
        lineageVerified: true,
      }),
    ),
    Bun.write(
      audits,
      JSON.stringify(
        identities.map((identity) => ({
          ...identity,
          decision: "clean",
          confidence: 0.99,
          evidence: [`artifact:${identity.kind}.json`],
        })),
      ),
    ),
  ])

  try {
    const result = await run("research/verify-benchmark-integrity/scripts/verify_integrity.py", [
      "build",
      "--contract",
      contract,
      "--trace",
      trace,
      "--subject",
      subject,
      "--model",
      model,
      "--audits",
      audits,
      "--run-id",
      "run-1",
      "--session-id",
      "session-1",
      "--evaluated-at",
      "1100",
      "--output",
      output,
      "--report",
      report,
    ])
    expect(result.code).toBe(0)
    const submission = JSON.parse(await Bun.file(output).text())
    expect(submission.evaluatorToken).toBeUndefined()
    expect(submission.trace).toMatchObject({ events: 7, dropped: 1, schemaSHA256: pins.traceSchemaSHA256 })
    expect(submission.activity).toMatchObject({
      unapprovedExternalModelCalls: 1,
      benchmarkLookupEvents: 1,
      hiddenCanariesTested: 2,
      hiddenCanaryViolations: 1,
    })
    expect(JSON.parse(await Bun.file(report).text()).traceCoverage).toBe(0.875)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("verify-benchmark-integrity rejects a non-contiguous trace", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-integrity-gap-"))
  const trace = path.join(dir, "trace.jsonl")
  await Bun.write(
    trace,
    [
      { seq: 0, at: 1, kind: "command" },
      { seq: 2, at: 2, kind: "command" },
    ]
      .map((item) => JSON.stringify(item))
      .join("\n"),
  )
  try {
    const result = await run("research/verify-benchmark-integrity/scripts/verify_integrity.py", [
      "check-trace",
      "--trace",
      trace,
      "--canary-manifest",
      hash("canaries"),
    ])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("trace sequence must be contiguous")
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
    expect(report.protocol.runner.recipeSHA256).toMatch(/^[0-9a-f]{64}$/)
    expect(report.protocol.runner.driverSHA256).toMatch(/^[0-9a-f]{64}$/)
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

test("verify-benchmark-launch rejects a substituted native recipe driver", async () => {
  const fixture = await launchFixture()
  try {
    const recipe = JSON.parse(await Bun.file(fixture.recipe).text())
    recipe.stages[0].driver.argv.push("--substituted")
    await Bun.write(fixture.recipe, JSON.stringify(recipe))
    const result = await run("research/verify-benchmark-launch/scripts/validate_launch.py", [
      "validate",
      fixture.manifest,
    ])
    expect(result.code).toBe(1)
    const report = JSON.parse(result.stdout)
    expect(report.checks.find((item: { id: string }) => item.id === "locked_environment").status).toBe("failed")
    expect(report.failures).toContain("locked_environment:command-environment-or-recipe-mismatch")
  } finally {
    await fs.rm(fixture.dir, { recursive: true, force: true })
  }
})

test("run-benchmark-pilot executes a clean native argv recipe and extracts typed metrics", async () => {
  const fixture = await pilotFixture()
  const preflight = path.join(fixture.dir, "preflight.json")
  const receipt = path.join(fixture.dir, "receipt.json")
  try {
    const checked = await run("research/run-benchmark-pilot/scripts/run_pilot.py", [
      "preflight",
      fixture.manifest,
      "--output",
      preflight,
    ])
    expect(checked.code).toBe(0)
    expect(JSON.parse(await Bun.file(preflight).text())).toMatchObject({ status: "passed", schemaVersion: 1 })
    const result = await run("research/run-benchmark-pilot/scripts/run_pilot.py", [
      "run",
      fixture.manifest,
      "--output",
      receipt,
    ])
    expect(result.code).toBe(0)
    const value = JSON.parse(await Bun.file(receipt).text())
    expect(value).toMatchObject({ status: "passed", metrics: { accuracy: 2 / 3 } })
    expect(value.receiptSHA256).toMatch(/^[0-9a-f]{64}$/)
    expect(value.stages).toHaveLength(1)
    expect(value.artifacts[0].paths).toHaveLength(1)
  } finally {
    await fs.rm(fixture.dir, { recursive: true, force: true })
  }
})

test("run-benchmark-pilot rejects stale outputs before execution", async () => {
  const fixture = await pilotFixture()
  try {
    await Bun.write(path.join(fixture.workspace, "pilot-score.json"), JSON.stringify({ scores: [1] }))
    const result = await run("research/run-benchmark-pilot/scripts/run_pilot.py", [
      "preflight",
      fixture.manifest,
      "--output",
      path.join(fixture.dir, "preflight.json"),
    ])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("artifact path is not clean before launch")
  } finally {
    await fs.rm(fixture.dir, { recursive: true, force: true })
  }
})

test("run-benchmark-pilot preserves Python receivers, named arguments, typed kwargs, and return artifacts", async () => {
  const fixture = await pythonPilotFixture()
  const receipt = path.join(fixture.dir, "receipt.json")
  try {
    const result = await run("research/run-benchmark-pilot/scripts/run_pilot.py", [
      "run",
      fixture.manifest,
      "--output",
      receipt,
    ])
    expect(result.code).toBe(0)
    const value = JSON.parse(await Bun.file(receipt).text())
    expect(value.metrics).toEqual({ "mean-reward": 4 })
    expect(value.stages.map((stage: { returnType: string }) => stage.returnType)).toEqual(["Evaluator", "list"])
    expect(JSON.parse(await Bun.file(path.join(fixture.results, "returns", "rewards.json")).text())).toEqual([2, 4, 6])
  } finally {
    await fs.rm(fixture.dir, { recursive: true, force: true })
  }
})

async function sourceFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-sources-"))
  const remote = path.join(dir, "official.git")
  const repo = path.join(dir, "source")
  const catalog = path.join(dir, "catalog.json")
  await exec(["git", "init", "--bare", "--initial-branch=main", "-q", remote], dir)
  await exec(["git", "init", "--initial-branch=main", "-q", repo], dir)
  await exec(["git", "config", "user.name", "Benchmark Test"], repo)
  await exec(["git", "config", "user.email", "benchmark@example.test"], repo)
  await Bun.write(path.join(repo, "evaluate.py"), "print('official evaluator')\n")
  await exec(["git", "add", "evaluate.py"], repo)
  await exec(["git", "commit", "-qm", "official release"], repo)
  await exec(["git", "remote", "add", "origin", remote], repo)
  await exec(["git", "push", "-q", "-u", "origin", "main"], repo)
  const revision = await exec(["git", "rev-parse", "HEAD"], repo)
  const write = (pin = revision, required = ["evaluate.py"]) =>
    Bun.write(
      catalog,
      JSON.stringify([
        {
          id: "official",
          source: {
            status: "official_open",
            repository: remote,
            revision: pin,
            checkedAt: "2026-08-05",
            requiredPaths: required,
          },
        },
        {
          id: "method",
          source: { status: "methodology_only", reason: "No external benchmark release" },
        },
      ]),
    )
  await write()
  return { dir, repo, catalog, revision, write }
}

test("audit-benchmark-sources verifies exact pins and surfaces non-destructive upstream drift", async () => {
  const fixture = await sourceFixture()
  try {
    const current = await run("research/audit-benchmark-sources/scripts/audit_sources.py", [
      fixture.catalog,
      "--allow-local",
      "--today",
      "2026-08-05",
    ])
    expect(current.code).toBe(0)
    const initial = JSON.parse(current.stdout)
    expect(initial).toMatchObject({
      status: "passed",
      summary: { official: 1, verified: 1, methodologyOnly: 1, upstreamChanged: 0 },
    })
    expect(initial.entries[0]).toMatchObject({
      pinReachable: true,
      relation: "current",
      requiredPaths: { "evaluate.py": true },
    })

    await Bun.write(path.join(fixture.repo, "release.txt"), "new upstream release\n")
    await exec(["git", "add", "release.txt"], fixture.repo)
    await exec(["git", "commit", "-qm", "new upstream release"], fixture.repo)
    await exec(["git", "push", "-q", "origin", "main"], fixture.repo)
    const changed = await run("research/audit-benchmark-sources/scripts/audit_sources.py", [
      fixture.catalog,
      "--allow-local",
      "--today",
      "2026-08-05",
    ])
    expect(changed.code).toBe(0)
    const report = JSON.parse(changed.stdout)
    expect(report.status).toBe("passed")
    expect(report.entries[0]).toMatchObject({ pinReachable: true, relation: "upstream_changed" })
    expect(report.entries[0].revision).toBe(fixture.revision)
    expect(report.reviews).toEqual(["official:upstream_changed"])
    expect(report.reportSHA256).toMatch(/^[a-f0-9]{64}$/)
    const unsigned = structuredClone(report)
    delete unsigned.reportSHA256
    expect(report.reportSHA256).toBe(digest(unsigned))
  } finally {
    await fs.rm(fixture.dir, { recursive: true, force: true })
  }
})

test("audit-benchmark-sources fails closed when a catalog pin is unreachable", async () => {
  const fixture = await sourceFixture()
  try {
    await fixture.write("f".repeat(40))
    const result = await run("research/audit-benchmark-sources/scripts/audit_sources.py", [
      fixture.catalog,
      "--allow-local",
      "--today",
      "2026-08-05",
    ])
    expect(result.code).toBe(1)
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe("failed")
    expect(report.failures).toEqual(["official:pin_unreachable"])
    expect(report.entries[0]).toMatchObject({ pinReachable: false, relation: "upstream_changed" })

    await fixture.write(fixture.revision, ["missing-evaluator.py"])
    const missing = await run("research/audit-benchmark-sources/scripts/audit_sources.py", [
      fixture.catalog,
      "--allow-local",
      "--today",
      "2026-08-05",
    ])
    expect(missing.code).toBe(1)
    const absent = JSON.parse(missing.stdout)
    expect(absent.failures).toEqual(["official:required_path_missing"])
    expect(absent.entries[0]).toMatchObject({
      pinReachable: true,
      requiredPaths: { "missing-evaluator.py": false },
    })
  } finally {
    await fs.rm(fixture.dir, { recursive: true, force: true })
  }
})
