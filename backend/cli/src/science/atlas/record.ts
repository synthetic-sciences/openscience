import { Instance } from "@/project/instance"
import { OpenScience } from "@/openscience"
import { Provenance } from "@/science/provenance/store"
import type { Node, Run } from "@/science/provenance/store"
import { ProvenanceEnvelope } from "@/science/provenance/envelope"
import { AtlasBrokerError, atlasRequest } from "./broker"
import { GitOutput } from "@/util/git-output"

export type AtlasRecordInput = {
  project: string
  provenanceID: string
  title?: string
  config?: Record<string, unknown>
  metrics?: Record<string, unknown>
  outcome?: "success" | "failure" | "inconclusive"
  failureMode?: "diverged" | "oom" | "data_bug" | "code_bug" | "underperformed" | "other"
  cluster?: string
  plan?: string
  hypothesis?: string
  signal?: AbortSignal
}

const required = (value: string | undefined, name: string) => {
  const result = value?.trim()
  if (!result) throw new AtlasBrokerError(`${name} is required`)
  return result
}

const OUTPUT_CHARS = 30_000

const clipOutput = (values: unknown[]) => {
  const state = { text: "", truncated: false }
  for (const value of values) {
    if (typeof value !== "string" || !value) continue
    const remaining = OUTPUT_CHARS - state.text.length
    const separator = state.text ? "\n" : ""
    const available = Math.max(0, remaining - separator.length)
    if (value.length <= available) {
      state.text += separator + value
      continue
    }
    state.text += separator.slice(0, remaining) + value.slice(0, available)
    state.truncated = true
    break
  }
  return state.truncated ? `${state.text}\n\n... (truncated)` : state.text
}

const clean = <T>(value: T): T => JSON.parse(OpenScience.redactSecrets(JSON.stringify(value))) as T

const isRun = (node: Node | undefined): node is Run =>
  node?.kind === "run" && "tool" in node && typeof node.tool === "string"

async function git(args: string[]) {
  return GitOutput.text(args, Instance.worktree)
}

async function dirty() {
  const result = await GitOutput.run(
    ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=normal"],
    Instance.worktree,
    { maxBytes: 1 },
  ).catch(() => undefined)
  if (!result || result.timedOut) return undefined
  if (result.truncated) return true
  if (result.code !== 0) return undefined
  return result.bytes.byteLength > 0
}

async function code() {
  const [repo, branch, sha, state] = await Promise.all([
    git(["remote", "get-url", "origin"]),
    git(["branch", "--show-current"]),
    git(["rev-parse", "HEAD"]),
    dirty(),
  ])
  if (!sha) return {}
  return {
    ...(repo ? { repo_url: repo } : {}),
    ...(branch ? { branch_name: branch } : {}),
    head_commit_sha: sha,
    ...(state !== undefined ? { git_dirty: state } : {}),
  }
}

export namespace AtlasRecorder {
  export async function publish(input: AtlasRecordInput) {
    const project = required(input.project, "project")
    const id = required(input.provenanceID, "provenance_id")
    const node = await Provenance.find(
      {
        projectID: Instance.project.id,
        directory: Instance.directory,
      },
      id,
    )
    if (!isRun(node)) {
      throw new AtlasBrokerError("The provenance record was not found in this project.", 404)
    }

    const meta = node.meta ?? {}
    const owner = typeof meta.directory === "string" ? meta.directory : Instance.directory
    const tail = clipOutput([meta.stdout, meta.result, meta.stderr, meta.error])
    const outcome =
      input.outcome ?? (node.status === "ok" ? "success" : node.status === "error" ? "failure" : "inconclusive")
    if (node.status === "error" && outcome === "success") {
      throw new AtlasBrokerError("A failed local execution cannot be published as a successful Gateway run.")
    }
    const output = tail
      ? [
          ProvenanceEnvelope.output({
            kind: node.status === "error" ? "error" : "result",
            label: "local run output",
            content: tail,
            createdAt: node.recordedAt,
          }),
        ]
      : []
    const envelope =
      node.provenance ??
      ProvenanceEnvelope.create({
        kind: "kernel",
        projectID: typeof meta.projectID === "string" ? meta.projectID : undefined,
        sessionID: node.sessionID,
        runID: node.id,
        code: typeof node.inputs?.code === "string" ? node.inputs.code : undefined,
        cwd: owner,
        kernel:
          typeof meta.kernelID === "string" && typeof node.inputs?.language === "string"
            ? {
                id: meta.kernelID,
                language: node.inputs.language,
                incarnation: typeof meta.kernelIncarnation === "number" ? meta.kernelIncarnation : undefined,
              }
            : undefined,
        status: node.status === "ok" ? "succeeded" : node.status === "error" ? "failed" : "inconclusive",
        outputs: output,
        createdAt: node.recordedAt,
        completedAt: node.recordedAt,
      })
    const body = {
      project_id: project,
      title: input.title?.trim() || node.label,
      config: clean({
        ...(input.config ?? {}),
        ...(node.inputs ?? {}),
        provenance_id: node.id,
        openscience_provenance: envelope,
      }),
      ...(input.metrics ? { metrics: clean(input.metrics) } : {}),
      stdout_tail: OpenScience.redactSecrets(tail),
      ...(node.status ? { exit_code: node.status === "ok" ? 0 : 1 } : {}),
      outcome,
      ...(outcome === "failure" ? { failure_mode: input.failureMode ?? "other" } : {}),
      ...(input.cluster ? { run_cluster_key: input.cluster } : {}),
      ...(input.plan ? { plan_id: input.plan } : {}),
      ...(input.hypothesis ? { hypothesis_id: input.hypothesis } : {}),
      ...(await code()),
    }
    return atlasRequest("POST", "/api/v1/runs:record", body, input.signal)
  }
}
