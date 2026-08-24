import path from "node:path"
import { fileURLToPath } from "node:url"

type Artifact = {
  path: string
  type: string
  required: boolean
  openable: boolean
}

type Flow = {
  id: string
  split: "development" | "held_out"
  title: string
  prompt: string
  fixtures: string[]
  coverage: string[]
  setup: string[]
  artifacts: Artifact[]
  acceptance: string[]
  observe: string[]
  repeat: number
}

type Suite = {
  version: string
  frozen: boolean
  splitPolicy: {
    development: number
    heldOut: number
    heldOutVisibleDuringTuning: boolean
  }
  tuningPolicy: {
    maxCandidateRevisions: number
    oneHarnessRulePerRevision: boolean
    promoteRepeatableFailuresToRegressionTests: boolean
    rerunAffectedDevelopmentFlows: boolean
    runHeldOutBeforeReleaseCandidate: boolean
  }
  flows: Flow[]
}

type Rubric = {
  version: number
  writtenBeforeRuns: boolean
  dimensions: { id: string; weight: number; evidence: string[] }[]
  hardGates: { id: string; requirement: string }[]
  comparison: {
    observableOnly: boolean
    allowed: string[]
    forbidden: string[]
  }
  releaseRule: {
    cleanLocalRuns: number
    requiresExplicitApproval: boolean
  }
}

type Lock = {
  version: string
  files: {
    suite: { path: string; sha256: string }
    rubric: { path: string; sha256: string }
  }
}

const dir = fileURLToPath(new URL(".", import.meta.url))
const required = [
  "chatgpt_oauth",
  "atlas_offline",
  "citations",
  "search_dedupe",
  "python",
  "r",
  "kernel_persistence",
  "kernel_restart",
  "folder_grant",
  "read_only",
  "symlink_escape",
  "network_approval",
  "denial",
  "scoped_retry",
  "paid_action",
  "ssh",
  "job_manifest",
  "reattach",
  "output_retrieval",
  "simple_answer",
  "no_ceremony",
  "long_research",
  "multiple_artifacts",
]

const sha = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

export async function validateLaunchSuite(root = dir) {
  const paths = {
    suite: path.join(root, "suite.json"),
    rubric: path.join(root, "rubric.json"),
    lock: path.join(root, "lock.json"),
  }
  const [suiteRaw, rubricRaw, lockRaw] = await Promise.all([
    Bun.file(paths.suite).text(),
    Bun.file(paths.rubric).text(),
    Bun.file(paths.lock).text(),
  ])
  const suite = JSON.parse(suiteRaw) as Suite
  const rubric = JSON.parse(rubricRaw) as Rubric
  const lock = JSON.parse(lockRaw) as Lock
  const errors: string[] = []
  const check = (pass: boolean, message: string) => {
    if (!pass) errors.push(message)
  }

  check(suite.frozen, "suite must be frozen")
  check(suite.flows.length >= 8 && suite.flows.length <= 10, "suite must contain 8–10 flows")
  check(new Set(suite.flows.map((flow) => flow.id)).size === suite.flows.length, "flow ids must be unique")
  check(
    suite.flows.filter((flow) => flow.split === "development").length === suite.splitPolicy.development,
    "development flow count must match split policy",
  )
  check(
    suite.flows.filter((flow) => flow.split === "held_out").length === suite.splitPolicy.heldOut,
    "held-out flow count must match split policy",
  )
  check(!suite.splitPolicy.heldOutVisibleDuringTuning, "held-out flows must remain unavailable during tuning")
  check(suite.tuningPolicy.maxCandidateRevisions === 3, "bounded hill climb must allow at most three revisions")
  check(suite.tuningPolicy.oneHarnessRulePerRevision, "each candidate revision must change one harness rule")
  check(suite.tuningPolicy.promoteRepeatableFailuresToRegressionTests, "repeatable failures must become regressions")
  check(suite.tuningPolicy.rerunAffectedDevelopmentFlows, "affected development flows must be rerun")
  check(suite.tuningPolicy.runHeldOutBeforeReleaseCandidate, "held-out flows must run before a release candidate")

  const coverage = new Set(suite.flows.flatMap((flow) => flow.coverage))
  for (const tag of required) check(coverage.has(tag), `required coverage is missing: ${tag}`)

  for (const flow of suite.flows) {
    check(flow.prompt.length >= 40, `${flow.id}: prompt is not concrete enough`)
    check(flow.setup.length > 0, `${flow.id}: setup is required`)
    check(flow.acceptance.length >= 2, `${flow.id}: at least two acceptance checks are required`)
    check(flow.observe.length > 0, `${flow.id}: observable evidence fields are required`)
    check(flow.repeat >= 1 && flow.repeat <= 3, `${flow.id}: repeat count must be between one and three`)
    for (const artifact of flow.artifacts) {
      check(artifact.required, `${flow.id}: every frozen artifact must be required`)
      check(artifact.openable, `${flow.id}: every frozen artifact must be openable`)
      check(!path.isAbsolute(artifact.path), `${flow.id}: artifact path must be relative`)
    }
  }

  const fixtures = suite.flows.flatMap((flow) =>
    flow.fixtures.map((fixture) => ({ flow: flow.id, fixture, file: path.resolve(root, fixture) })),
  )
  const base = path.join(root, "fixtures") + path.sep
  await Promise.all(
    fixtures.map(async (fixture) => {
      check(fixture.file.startsWith(base), `${fixture.flow}: fixture escapes the suite directory: ${fixture.fixture}`)
      check(await Bun.file(fixture.file).exists(), `${fixture.flow}: fixture does not exist: ${fixture.fixture}`)
    }),
  )

  const dimensions = new Set(rubric.dimensions.map((dimension) => dimension.id))
  const expected = [
    "task_completion",
    "plan_usefulness",
    "time_to_first_output",
    "completion_time",
    "approval_quality",
    "tool_reliability",
    "citation_support",
    "artifact_validity",
    "ui_continuity",
    "delegation_restraint",
    "search_deduplication",
    "tool_relevance",
    "cost_control",
    "claim_support",
  ]
  for (const dimension of expected) check(dimensions.has(dimension), `rubric dimension is missing: ${dimension}`)
  check(rubric.writtenBeforeRuns, "rubric must be written before runs")
  check(rubric.comparison.observableOnly, "comparisons must use observable evidence only")
  check(rubric.comparison.forbidden.includes("hidden reasoning"), "hidden reasoning must be explicitly excluded")
  check(rubric.releaseRule.cleanLocalRuns === 3, "release must require three clean local runs")
  check(rubric.releaseRule.requiresExplicitApproval, "release must require explicit approval")
  check(rubric.hardGates.length >= 6, "launch rubric must include every hard gate")

  check(lock.version === suite.version, "lock version must match suite version")
  check(lock.files.suite.path === "suite.json", "suite lock path must be suite.json")
  check(lock.files.rubric.path === "rubric.json", "rubric lock path must be rubric.json")
  check(lock.files.suite.sha256 === sha(suiteRaw), "suite.json does not match its frozen hash")
  check(lock.files.rubric.sha256 === sha(rubricRaw), "rubric.json does not match its frozen hash")

  return {
    errors,
    suite,
    rubric,
    hash: sha(`${lock.files.suite.sha256}:${lock.files.rubric.sha256}`),
  }
}

if (import.meta.main) {
  const result = await validateLaunchSuite()
  if (result.errors.length) {
    for (const error of result.errors) console.error(`✗ ${error}`)
    process.exit(1)
  }
  console.log(
    `Launch suite ${result.suite.version} is frozen: ${result.suite.flows.length} flows, ${result.rubric.dimensions.length} rubric dimensions, ${result.hash.slice(0, 12)}.`,
  )
  if (Bun.argv.includes("--list")) {
    for (const flow of result.suite.flows) console.log(`${flow.split.padEnd(11)} ${flow.id}`)
  }
}
