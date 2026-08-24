import z from "zod"
import { GitOutput } from "@/util/git-output"

export namespace ProvenanceEnvelope {
  export const Reason = z.enum([
    "not_applicable",
    "not_captured",
    "not_implemented",
    "not_published",
    "not_versioned",
    "remote_unverified",
  ])
  export type Reason = z.infer<typeof Reason>

  const missing = z.object({
    status: z.literal("unavailable"),
    reason: Reason,
  })
  const field = <T extends z.ZodType>(schema: T) =>
    z.union([
      z.object({
        status: z.literal("available"),
        value: schema,
      }),
      missing,
    ])

  export const Output = z.object({
    kind: z.enum(["stream", "display", "result", "error", "artifact", "checkpoint"]),
    label: z.string(),
    artifact_id: field(z.string()),
    path: field(z.string()),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
    version_id: field(z.string()),
    version: field(z.number().int().positive()),
    created_at: field(z.string()),
  })
  export type Output = z.infer<typeof Output>

  export const Schema = z.object({
    format: z.literal("openscience.provenance.v1"),
    kind: z.enum(["kernel", "local_compute", "remote_compute", "artifact_version"]),
    identity: z.object({
      project_id: field(z.string()),
      session_id: field(z.string()),
      run_id: field(z.string()),
    }),
    input: z.object({
      code: field(z.string()),
      cwd: field(z.string()),
      code_state: field(
        z.object({
          repository: field(z.string()),
          branch: field(z.string()),
          commit: field(z.string()),
          dirty: field(z.boolean()),
        }),
      ),
    }),
    environment: z.object({
      host: field(
        z.object({
          platform: z.string(),
          arch: z.string(),
          runtimes: z.record(z.string(), z.string()),
        }),
      ),
      kernel: field(
        z.object({
          id: z.string(),
          language: z.string(),
          environment_name: field(z.string()),
          interpreter: field(
            z.object({
              name: z.string(),
              binary: z.string(),
              version: field(z.string()),
            }),
          ),
          incarnation: field(z.number().int().positive()),
          process_id: field(z.number().int().positive()),
          process_started_at: field(z.string()),
        }),
      ),
    }),
    outputs: z.object({
      status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "inconclusive"]),
      items: Output.array(),
    }),
    timestamps: z.object({
      created_at: field(z.string()),
      started_at: field(z.string()),
      completed_at: field(z.string()),
    }),
    handoff: z.object({
      atlas_compute_id: field(z.string()).describe(
        "@deprecated Compatibility field. Managed compute is retired and this value is always unavailable.",
      ),
      atlas_run_id: field(z.string()),
    }),
  })
  export type Schema = z.infer<typeof Schema>

  export const available = <T>(value: T) => ({ status: "available" as const, value })
  export const unavailable = (reason: Reason) => ({ status: "unavailable" as const, reason })

  const time = (value: string | number | undefined, reason: Reason = "not_captured") =>
    value === undefined
      ? unavailable(reason)
      : available(typeof value === "number" ? new Date(value).toISOString() : value)

  export function digest(value: string | Uint8Array) {
    const hash = new Bun.CryptoHasher("sha256")
    hash.update(value)
    return hash.digest("hex")
  }

  export function code(cwd: string) {
    const repository = GitOutput.textSync(["remote", "get-url", "origin"], cwd)
    const branch = GitOutput.textSync(["branch", "--show-current"], cwd)
    const commit = GitOutput.textSync(["rev-parse", "HEAD"], cwd)
    const result = (() => {
      try {
        return GitOutput.runSync(["-c", "core.fsmonitor=false", "status", "--porcelain"], cwd, { maxBytes: 1 })
      } catch {
        return
      }
    })()
    const state = result?.bytes.byteLength ? true : result?.code === 0 && !result.stopped ? false : undefined
    if (!repository && !branch && !commit && state === undefined) return
    return {
      repository: repository || undefined,
      branch: branch || undefined,
      commit: commit || undefined,
      dirty: state,
    }
  }

  export function output(input: {
    kind: Output["kind"]
    label: string
    content?: string | Uint8Array
    sha256?: string
    size?: number
    artifactID?: string
    path?: string
    versionID?: string
    version?: number
    createdAt?: string | number
    versionReason?: Reason
  }): Output {
    const bytes = typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content
    return Output.parse({
      kind: input.kind,
      label: input.label,
      artifact_id: input.artifactID ? available(input.artifactID) : unavailable("not_applicable"),
      path: input.path ? available(input.path) : unavailable("not_applicable"),
      sha256: input.sha256 ?? digest(bytes ?? new Uint8Array()),
      size: input.size ?? bytes?.byteLength ?? 0,
      version_id: input.versionID ? available(input.versionID) : unavailable(input.versionReason ?? "not_applicable"),
      version:
        input.version !== undefined ? available(input.version) : unavailable(input.versionReason ?? "not_applicable"),
      created_at: time(input.createdAt, "not_captured"),
    })
  }

  export function create(input: {
    kind: Schema["kind"]
    projectID?: string
    sessionID?: string
    runID?: string
    code?: string
    cwd?: string
    codeState?: {
      repository?: string
      branch?: string
      commit?: string
      dirty?: boolean
    }
    codeReason?: Reason
    host?: {
      platform: string
      arch: string
      runtimes?: Record<string, string>
    }
    hostReason?: Reason
    kernel?: {
      id: string
      language: string
      environmentName?: string
      interpreter?: {
        name: string
        binary: string
        version?: string
      }
      incarnation?: number
      processID?: number
      processStartedAt?: string | number
    }
    status?: Schema["outputs"]["status"]
    outputs?: Output[]
    createdAt?: string | number
    startedAt?: string | number
    completedAt?: string | number
  }): Schema {
    return Schema.parse({
      format: "openscience.provenance.v1",
      kind: input.kind,
      identity: {
        project_id: input.projectID ? available(input.projectID) : unavailable("not_captured"),
        session_id: input.sessionID ? available(input.sessionID) : unavailable("not_captured"),
        run_id: input.runID ? available(input.runID) : unavailable("not_captured"),
      },
      input: {
        code: input.code !== undefined ? available(input.code) : unavailable("not_applicable"),
        cwd: input.cwd ? available(input.cwd) : unavailable("not_captured"),
        code_state: input.codeState
          ? available({
              repository: input.codeState.repository
                ? available(input.codeState.repository)
                : unavailable("not_captured"),
              branch: input.codeState.branch ? available(input.codeState.branch) : unavailable("not_captured"),
              commit: input.codeState.commit ? available(input.codeState.commit) : unavailable("not_captured"),
              dirty:
                input.codeState.dirty === undefined ? unavailable("not_captured") : available(input.codeState.dirty),
            })
          : unavailable(input.codeReason ?? "not_captured"),
      },
      environment: {
        host: input.host
          ? available({
              platform: input.host.platform,
              arch: input.host.arch,
              runtimes: input.host.runtimes ?? {},
            })
          : unavailable(input.hostReason ?? "not_captured"),
        kernel: input.kernel
          ? available({
              id: input.kernel.id,
              language: input.kernel.language,
              environment_name: input.kernel.environmentName
                ? available(input.kernel.environmentName)
                : unavailable("not_captured"),
              interpreter: input.kernel.interpreter
                ? available({
                    name: input.kernel.interpreter.name,
                    binary: input.kernel.interpreter.binary,
                    version: input.kernel.interpreter.version
                      ? available(input.kernel.interpreter.version)
                      : unavailable("not_captured"),
                  })
                : unavailable("not_captured"),
              incarnation:
                input.kernel.incarnation === undefined
                  ? unavailable("not_captured")
                  : available(input.kernel.incarnation),
              process_id:
                input.kernel.processID === undefined ? unavailable("not_captured") : available(input.kernel.processID),
              process_started_at: time(input.kernel.processStartedAt, "not_captured"),
            })
          : unavailable("not_applicable"),
      },
      outputs: {
        status: input.status ?? "inconclusive",
        items: input.outputs ?? [],
      },
      timestamps: {
        created_at: time(input.createdAt, "not_captured"),
        started_at: time(input.startedAt, "not_captured"),
        completed_at: time(input.completedAt, "not_captured"),
      },
      handoff: {
        atlas_compute_id: unavailable("not_applicable"),
        atlas_run_id: unavailable("not_published"),
      },
    })
  }
}
