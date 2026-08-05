import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessLaunch } from "../../src/session/harness/launch"
import { HarnessBenchmark } from "../../src/session/harness/benchmark"
import { HarnessRecipe } from "../../src/session/harness/recipe"

export const harnessHash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

export function recipeSelection(key: HarnessRecipe.Verified): HarnessRecipe.Selection {
  const bindings = {
    bixbench: {},
    biomni: {},
    pde: { dataRoot: "data", datasetStem: "1D_Advection_Sols_beta0.1" },
    chembench: { runID: "fixture-run" },
    matscibench: { outputDir: "fixtures/matsci-results" },
    mle: {
      competitionList: "fixtures/competitions.txt",
      dataDir: "fixtures/data",
      submissionManifest: "fixtures/submissions.jsonl",
      outputDir: "fixtures/results",
    },
    ale: { configName: "gpt-5", rootPath: "fixtures/ale-results" },
    researchclaw: { config: "eval_configs/fixture.yaml" },
    paperbench: {
      submissionDir: "fixtures/paperbench/submission",
      paperID: "adaptive-pruning",
      outputDir: "fixtures/paperbench/judge",
    },
    scicode: {
      codeDir: "fixtures/scicode/code",
      logDir: "fixtures/scicode/logs",
      outputDir: "fixtures/scicode/results",
    },
  } satisfies Record<HarnessRecipe.Verified, Record<string, string>>
  return HarnessRecipe.Selection.parse({ recipeID: HarnessRecipe.catalog[key].id, bindings: bindings[key] })
}

export function launchProtocol(key = "official", selection?: HarnessRecipe.Selection) {
  const id = HarnessBenchmark.Id.safeParse(key)
  const benchmark = id.success ? HarnessBenchmark.catalog[id.data] : undefined
  const source = benchmark?.source.status === "methodology_only" ? undefined : benchmark?.source
  const recipe = selection ? HarnessRecipe.materialize(key, selection) : undefined
  return HarnessContract.Launch.parse({
    protocolVersion: "benchmark-launch-v1",
    runner: {
      repository: source?.repository ?? `https://example.org/${key}/benchmark.git`,
      revision: source?.revision ?? harnessHash(`${key}-runner`).slice(0, 40),
      entrypoint: recipe?.entrypoint ?? "benchmark/run.py",
      commandSHA256: harnessHash(`${key}-command`),
      environmentSHA256: harnessHash(`${key}-environment`),
      recipeSHA256: recipe?.recipeSHA256,
      driverSHA256: recipe?.driverSHA256,
    },
    dataset: {
      name: `${key}-dataset`,
      source: source?.dataset ?? `https://example.org/${key}/dataset`,
      revision: `${key}-dataset-v1`,
      manifestSHA256: harnessHash(`${key}-dataset-manifest`),
    },
    taskManifestSHA256: harnessHash(`${key}-task-manifest`),
    evaluatorSHA256: harnessHash(`${key}-evaluator`),
    validatorSHA256: harnessHash(`${key}-launch-validator`),
    baseline: {
      name: `${key}-baseline`,
      artifactSHA256: harnessHash(`${key}-baseline-artifact`),
      expectedScore: 0.5,
      tolerance: 1e-9,
    },
  })
}

export function launchSubmit(contract: HarnessContract.Info, token: string) {
  if (!contract.launch) throw new Error("Expected a benchmark launch protocol")
  return HarnessLaunch.Submit.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    protocol: contract.launch,
    validator: {
      name: "verify-benchmark-launch",
      version: "1",
      scriptSHA256: contract.launch.validatorSHA256,
      manifestSHA256: harnessHash(`${contract.sessionID}-launch-manifest`),
    },
    checks: HarnessContract.LaunchCheck.options.map((id) => ({
      id,
      status: "passed" as const,
      evidence: [`launch:${id}`],
    })),
    baselineScore: 0.5,
    evidence: ["launch:readiness-report.json"],
    evaluatedAt: Math.max(Date.now(), contract.createdAt),
  })
}

export async function launchReady(contract: HarnessContract.Info, token: string) {
  return HarnessLaunch.record(launchSubmit(contract, token), contract)
}
