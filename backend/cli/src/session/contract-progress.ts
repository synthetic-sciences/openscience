import { createHash } from "node:crypto"

export namespace ContractProgress {
  export type Trace = {
    research: {
      status: string
      readiness: number
      missing: string[]
      failedCandidates: number
      gates: Array<{ id: string; status: string; complete: number; total: number; detail: string }>
      contract?: { stages: Array<{ id: string; status: string }> }
    }
    artifacts: Array<{
      artifactID?: string
      versionID?: string
      path?: string
      sha256?: string
      durable: boolean
    }>
    jobs: Array<{ id: string; status: string; artifactCount: number }>
    kernels: Array<{ toolID: string; status: string; executionCount?: number; provenanceID?: string }>
  }

  export type Marker = {
    progress: string
    repair: boolean
  }

  export type Decision = "ready" | "continue" | "repair" | "await_user"

  const ordered = <T>(items: T[], key: (item: T) => string) => items.toSorted((a, b) => key(a).localeCompare(key(b)))

  export function fingerprint(trace: Trace) {
    const value = {
      research: {
        status: trace.research.status,
        readiness: trace.research.readiness,
        missing: trace.research.missing.toSorted(),
        failedCandidates: trace.research.failedCandidates,
        gates: ordered(trace.research.gates, (gate) => gate.id).map((gate) => ({
          id: gate.id,
          status: gate.status,
          complete: gate.complete,
          total: gate.total,
          detail: gate.detail,
        })),
      },
      artifacts: ordered(trace.artifacts, (artifact) =>
        [artifact.versionID, artifact.artifactID, artifact.path, artifact.sha256].filter(Boolean).join(":"),
      ).map((artifact) => ({
        artifactID: artifact.artifactID,
        versionID: artifact.versionID,
        path: artifact.path,
        sha256: artifact.sha256,
        durable: artifact.durable,
      })),
      jobs: ordered(trace.jobs, (job) => job.id).map((job) => ({
        id: job.id,
        status: job.status,
        artifactCount: job.artifactCount,
      })),
      kernels: ordered(trace.kernels, (kernel) => kernel.toolID).map((kernel) => ({
        toolID: kernel.toolID,
        status: kernel.status,
        executionCount: kernel.executionCount,
        provenanceID: kernel.provenanceID,
      })),
    }
    return createHash("sha256").update(JSON.stringify(value)).digest("hex")
  }

  export function terminal(trace: Trace) {
    return trace.research.contract?.stages.some((stage) => stage.status === "blocked") === true
  }

  export function decide(input: { pending: number; progress: string; prior?: Marker; terminal?: boolean }): Decision {
    if (input.pending === 0) return "ready"
    if (input.terminal) return "await_user"
    if (!input.prior || input.prior.progress !== input.progress) return "continue"
    if (!input.prior.repair) return "repair"
    return "await_user"
  }
}
