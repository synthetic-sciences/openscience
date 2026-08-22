export namespace ProcessOutput {
  export interface Process {
    stdout: ReadableStream<Uint8Array>
    exited: Promise<number>
    kill(signal?: number | NodeJS.Signals): void
  }

  export interface Options {
    maxBytes: number
    timeoutMs: number
    signal?: AbortSignal
  }

  export interface Result {
    bytes: Buffer
    code: number | null
    timedOut: boolean
    truncated: boolean
  }

  const grace = 1_000

  export async function collect(proc: Process, options: Options): Promise<Result> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
      throw new Error("Process output maxBytes must be a positive safe integer")
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("Process output timeoutMs must be a positive safe integer")
    }

    const reader = proc.stdout.getReader()
    const chunks: Uint8Array[] = []
    const state = { size: 0, reason: undefined as "abort" | "error" | "limit" | "timeout" | undefined }
    const stopped = Promise.withResolvers<void>()
    const stop = (reason: NonNullable<typeof state.reason>) => {
      if (state.reason) return
      state.reason = reason
      try {
        proc.kill("SIGKILL")
      } catch {
        // The process may have exited between the stream event and the kill.
      }
      void reader.cancel(reason).catch(() => undefined)
      stopped.resolve()
    }
    const abort = () => stop("abort")
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs)
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) stop("abort")

    const consume = async () => {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return
        const remaining = options.maxBytes - state.size
        if (chunk.value.byteLength <= remaining) {
          chunks.push(chunk.value.slice())
          state.size += chunk.value.byteLength
          continue
        }
        if (remaining > 0) {
          chunks.push(chunk.value.slice(0, remaining))
          state.size += remaining
        }
        stop("limit")
        return
      }
    }
    const completed = Promise.all([proc.exited, consume()]).then(
      ([code]) => ({ code, error: undefined as unknown }),
      (error: unknown) => ({ code: null, error }),
    )

    try {
      const outcome = await Promise.race([
        completed,
        stopped.promise.then(() => ({ code: null, error: undefined as unknown })),
      ])
      if (!state.reason && outcome.error) {
        stop("error")
        await reader.cancel("error").catch(() => undefined)
        await Promise.race([proc.exited.catch(() => null), Bun.sleep(grace).then(() => null)])
        throw outcome.error
      }
      if (state.reason) {
        await reader.cancel(state.reason).catch(() => undefined)
        const code = await Promise.race([proc.exited.catch(() => null), Bun.sleep(grace).then(() => null)])
        void completed.catch(() => undefined)
        if (state.reason === "abort") options.signal?.throwIfAborted()
        return {
          bytes: Buffer.concat(chunks, state.size),
          code,
          timedOut: state.reason === "timeout",
          truncated: state.reason === "limit",
        }
      }
      return {
        bytes: Buffer.concat(chunks, state.size),
        code: outcome.code,
        timedOut: false,
        truncated: false,
      }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      reader.releaseLock()
    }
  }
}
