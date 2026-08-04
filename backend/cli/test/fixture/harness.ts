import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessLaunch } from "../../src/session/harness/launch"

export const harnessHash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

export function launchProtocol(key = "official") {
  return HarnessContract.Launch.parse({
    protocolVersion: "benchmark-launch-v1",
    runner: {
      repository: `https://example.org/${key}/benchmark.git`,
      revision: harnessHash(`${key}-runner`).slice(0, 40),
      entrypoint: "benchmark/run.py",
      commandSHA256: harnessHash(`${key}-command`),
      environmentSHA256: harnessHash(`${key}-environment`),
    },
    dataset: {
      name: `${key}-dataset`,
      source: `https://example.org/${key}/dataset`,
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
