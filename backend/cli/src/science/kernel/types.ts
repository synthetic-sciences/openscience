import z from "zod"

/**
 * Generalized persistent-kernel interface.
 *
 * Abstracts the pattern proven in `tool/biology/notebook.ts` (a long-lived
 * Python process that executes cells and returns results) so the kernel agent
 * can add multiple language backends — python, R, and beyond — behind ONE
 * uniform contract with Jupyter-style MIME-bundle results.
 *
 * A `KernelManager` owns per-session kernel lifecycles; a `Kernel` is a single
 * persistent interpreter process whose namespace survives across `execute`
 * calls.
 */

export type KernelLanguage = "python" | "r" | (string & {})

export const AtlasEnvironment = {
  access: "host_broker",
  credentials: "withheld",
  sources: "source_ids_only",
} as const

export const KernelEnvironment = z.object({
  cwd: z.string(),
  atlas: z.object({
    access: z.literal(AtlasEnvironment.access),
    credentials: z.literal(AtlasEnvironment.credentials),
    sources: z.literal(AtlasEnvironment.sources),
  }),
  sandbox: z.object({
    requested: z.boolean(),
    enforced: z.boolean(),
    backend: z.enum(["seatbelt", "bubblewrap", "none"]),
    network: z.enum(["allow", "deny"]),
    platform: z.string(),
    available: z.boolean(),
    tool: z.string().optional(),
    reason: z.string().optional(),
    warning: z.string().optional(),
  }),
})
export type KernelEnvironment = z.infer<typeof KernelEnvironment>

/**
 * A Jupyter-style MIME bundle: keys are MIME types, values are the encoded
 * representation (text/plain, text/html, image/png as base64, application/json,
 * application/vnd.plotly.v1+json, etc.). Renderers pick the richest key they
 * understand.
 */
export type MimeBundle = Record<string, string>

/** One output emitted during execution (stream text or a rich display value). */
export interface KernelOutput {
  type: "stream" | "display" | "result" | "error"
  /** For stream outputs: "stdout" | "stderr". */
  name?: "stdout" | "stderr"
  /** For display/result outputs: the MIME bundle. */
  data?: MimeBundle
  /** For error outputs: name + message + traceback. */
  error?: { name: string; message: string; traceback?: string[] }
}

/** Result of executing a single cell. */
export interface ExecuteResult {
  /** True if the cell completed without an uncaught exception. */
  ok: boolean
  /** Ordered outputs (stream chunks, rich displays, final value, errors). */
  outputs: KernelOutput[]
  /** Convenience: concatenated stdout. */
  stdout: string
  /** Convenience: concatenated stderr. */
  stderr: string
  /** Monotonic execution counter within the kernel. */
  executionCount?: number
  /** Local content-addressed record for this execution and its outputs. */
  provenanceID?: string
}

export interface ExecuteOptions {
  /** Per-cell timeout in ms. */
  timeout?: number
  /** Abort signal wired from the tool context. */
  signal?: AbortSignal
  /** Whether to capture rich (MIME) display outputs. Default true. */
  rich?: boolean
  /** Message, tool call, and human-facing cell identity used for lineage/UI. */
  origin?: { messageID?: string; callID?: string; title?: string; source?: string }
  /** Internal lifecycle hook fired when a queued cell actually starts. */
  onStart?: () => void
}

export interface KernelStartOptions {
  /** Owning session, used to assemble its durable filesystem grants. */
  sessionID?: string
  /** Working directory for the interpreter process. */
  cwd?: string
  /** Extra environment variables. */
  env?: Record<string, string>
  /** Interpreter binary override (e.g. a specific python/Rscript path). */
  binary?: string
}

export interface KernelProcess {
  /** OS process identifier for this exact live incarnation. */
  pid: number
  /** Host timestamp captured when this process was spawned. */
  startedAt: number
  /** Platform process-start token used to guard against PID reuse when available. */
  token?: string
}

/** A single persistent interpreter process. State persists across executes. */
export interface Kernel {
  readonly id: string
  readonly language: KernelLanguage
  /** The actual working directory and sandbox policy applied to this process. */
  readonly environment?: KernelEnvironment
  /** True once the process is up and the ready handshake has completed. */
  readonly ready: boolean
  /** Identity of the exact child process, including a PID-reuse guard where supported. */
  readonly process?: KernelProcess
  /** True when the process exited without an intentional lifecycle operation. */
  readonly crashed?: boolean
  /** True while this kernel is executing or has work waiting. */
  readonly busy?: boolean
  /** Number of executions waiting behind the currently-running cell. */
  readonly queueDepth?: number
  /** Start the underlying process and block until ready. */
  start(opts?: KernelStartOptions): Promise<void>
  /** Execute a code cell; namespace/imports/state persist to the next call. */
  execute(code: string, opts?: ExecuteOptions): Promise<ExecuteResult>
  /** Interrupt the currently-running cell without killing the kernel, if supported. */
  interrupt?(): Promise<boolean>
  /** Terminate the process and release resources. */
  shutdown(): Promise<void>
}

/** Factory + lifecycle owner. One manager per language backend implementation. */
export interface KernelManager {
  readonly language: KernelLanguage
  /** Get-or-create the persistent kernel for a session key. */
  get(sessionID: string, opts?: KernelStartOptions): Promise<Kernel>
  /** Shut down and forget a session's kernel. */
  release(sessionID: string): Promise<void>
  /** Whether a kernel process for this key is ready. */
  active?(sessionID: string): boolean
  /** Shut down every kernel this manager owns. */
  shutdownAll(): Promise<void>
}
