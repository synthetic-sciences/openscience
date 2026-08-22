import { ProcessOutput } from "./process-output"

export namespace GitOutput {
  export const MAX_BYTES = 64 * 1024
  export const TIMEOUT_MS = 10_000

  export interface Options {
    maxBytes?: number
    timeoutMs?: number
    signal?: AbortSignal
  }

  export interface SyncResult {
    bytes: Buffer
    code: number | null
    stopped: boolean
    truncated: boolean
  }

  const limits = (options: Options) => {
    const maxBytes = options.maxBytes ?? MAX_BYTES
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Git output maxBytes must be positive")
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Git timeoutMs must be positive")
    return { maxBytes, timeoutMs }
  }

  const env = () => ({
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  })

  export async function run(args: string[], cwd: string, options: Options = {}) {
    const limit = limits(options)
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      env: env(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    return ProcessOutput.collect(proc, {
      maxBytes: limit.maxBytes,
      timeoutMs: limit.timeoutMs,
      signal: options.signal,
    })
  }

  export async function text(args: string[], cwd: string, options: Options = {}): Promise<string | undefined> {
    const result = await run(args, cwd, options).catch(() => undefined)
    if (!result || result.code !== 0 || result.timedOut || result.truncated) return
    return result.bytes.toString().trim()
  }

  export function runSync(args: string[], cwd: string, options: Options = {}): SyncResult {
    const limit = limits(options)
    const proc = Bun.spawnSync(["git", ...args], {
      cwd,
      env: env(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      maxBuffer: limit.maxBytes,
      timeout: limit.timeoutMs,
    })
    return {
      bytes: Buffer.from(proc.stdout.subarray(0, limit.maxBytes)),
      code: proc.exitCode,
      stopped: !!proc.signalCode,
      truncated: proc.stdout.byteLength > limit.maxBytes,
    }
  }

  export function textSync(args: string[], cwd: string, options: Options = {}): string | undefined {
    try {
      const result = runSync(args, cwd, options)
      if (result.code !== 0 || result.stopped || result.truncated) return
      return result.bytes.toString().trim()
    } catch {
      return
    }
  }
}
