import { Instance } from "@/project/instance"
import { OpenScience } from "@/openscience"
import { Provenance } from "@/science/provenance/store"
import type { Node, Run } from "@/science/provenance/store"
import { ProvenanceEnvelope } from "@/science/provenance/envelope"
import { AtlasBrokerError, atlasRequest } from "./broker"

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

const clip = (value: string, max = 30_000) => (value.length > max ? `${value.slice(0, max)}\n\n... (truncated)` : value)

const clean = <T>(value: T): T => JSON.parse(OpenScience.redactSecrets(JSON.stringify(value))) as T

const isRun = (node: Node | undefined): node is Run =>
  node?.kind === "run" && "tool" in node && typeof node.tool === "string"

async function git(args: string[]) {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: Instance.worktree,
      stdout: "pipe",
      stderr: "ignore",
    })
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) return
    return text.trim()
  } catch {
    return
  }
}

async function code() {
  const [repo, branch, sha, state] = await Promise.all([
    git(["remote", "get-url", "origin"]),
    git(["branch", "--show-current"]),
    git(["rev-parse", "HEAD"]),
    git(["status", "--porcelain"]),
  ])
  if (!sha) return {}
  return {
    ...(repo ? { repo_url: repo } : {}),
    ...(branch ? { branch_name: branch } : {}),
    head_commit_sha: sha,
    ...(state !== undefined ? { git_dirty: Boolean(state) } : {}),
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
    const tail = [meta.stdout, meta.result, meta.stderr, meta.error]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n")
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
      stdout_tail: clip(OpenScience.redactSecrets(tail)),
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
