import { spawn } from "node:child_process"
import path from "node:path"

export type ServerProcessOptions = {
  /** The runtime is loopback-only. Other hostnames are rejected. */
  hostname?: string
  port?: number
  signal?: AbortSignal
  /** Maximum time to start and pass the health check, in milliseconds. */
  timeout?: number
  /** Grace period before an owned child is forcibly terminated. */
  shutdownTimeout?: number
  executablePath?: string
  /** Arguments before `serve`, for example a Bun executable's source entrypoint. */
  executableArgs?: string[]
  cwd?: string
  /** Overrides inherited environment; undefined removes a variable. */
  env?: Record<string, string | undefined>
}

type Options = ServerProcessOptions & { config?: { logLevel?: string } }

/** Snapshot the same connection scope and credential inherited by an owned child. */
export function serverClientOptions(options: ServerProcessOptions = {}) {
  const env = { ...process.env, ...options.env }
  const token = env.OPENSCIENCE_AUTH_TOKEN
  return {
    directory: path.resolve(options.cwd ?? process.cwd()),
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  }
}

function localURL(value: string) {
  const url = new URL(value)
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("OpenScience announced an invalid local server URL")
  }
  return url.origin
}

/** Own exactly the child started here. Connecting a client to an existing
 * server uses createOpenScienceClient and never enters this lifecycle. */
export async function startServer(options: Options = {}) {
  options.signal?.throwIfAborted()
  if (options.hostname && !["127.0.0.1", "localhost"].includes(options.hostname)) {
    throw new Error("OpenScience servers can only bind to loopback")
  }
  const timeout = options.timeout ?? 5000
  const shutdown = options.shutdownTimeout ?? 10_000
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(shutdown) || shutdown <= 0) {
    throw new Error("Server startup and shutdown timeouts must be positive finite milliseconds")
  }
  const port = options.port ?? 4096
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid OpenScience server port")

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
    OPENSCIENCE_SERVER_READY_FORMAT: "json",
  }
  const args = [...(options.executableArgs ?? []), "serve", "--port", String(port)]
  if (options.config?.logLevel) args.push("--log-level", options.config.logLevel)
  const proc = spawn(options.executablePath ?? "openscience", args, {
    cwd: options.cwd,
    env: {
      ...env,
      OPENSCIENCE_CONFIG_CONTENT:
        options.config === undefined ? (env.OPENSCIENCE_CONFIG_CONTENT ?? "{}") : JSON.stringify(options.config),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const state = {
    exited: false,
    announced: false,
    buffer: "",
    output: "",
    closing: undefined as Promise<void> | undefined,
  }
  const exited = new Promise<void>((resolve) => {
    proc.once("close", () => {
      state.exited = true
      options.signal?.removeEventListener("abort", abort)
      resolve()
    })
  })
  const wait = async (duration: number) => {
    const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
    try {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer.id = setTimeout(resolve, duration)
        }),
      ])
    } finally {
      if (timer.id) clearTimeout(timer.id)
    }
  }
  const close = () => {
    state.closing ??= (async () => {
      if (state.exited) return
      proc.kill("SIGTERM")
      await wait(shutdown)
      if (state.exited) return
      proc.kill("SIGKILL")
      await wait(Math.max(1000, shutdown))
      if (!state.exited) throw new Error("OpenScience child did not exit after forced shutdown")
    })()
    return state.closing
  }
  const controller = new AbortController()
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()

  try {
    const url = await new Promise<string>((resolve, reject) => {
      const fail = (error: unknown) => reject(error)
      proc.on("error", fail)
      controller.signal.addEventListener("abort", () => fail(controller.signal.reason), { once: true })
      if (controller.signal.aborted) return fail(controller.signal.reason)
      timer.id = setTimeout(
        () => controller.abort(new Error(`Timeout waiting for server to start after ${timeout}ms`)),
        timeout,
      )
      proc.once("exit", (code, signal) => {
        fail(
          new Error(
            `OpenScience server exited before becoming ready (${signal ?? code})${state.output ? `\n${state.output}` : ""}`,
          ),
        )
      })
      const check = async (value: string) => {
        const url = localURL(value)
        const token = env.OPENSCIENCE_AUTH_TOKEN
        const response = await fetch(`${url}/global/health`, {
          signal: controller.signal,
          redirect: "error",
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
        })
        const health: unknown = await response.json()
        if (
          !response.ok ||
          !health ||
          typeof health !== "object" ||
          !("healthy" in health) ||
          health.healthy !== true ||
          !("version" in health) ||
          typeof health.version !== "string"
        ) {
          throw new Error("OpenScience server did not pass its health check")
        }
        return url
      }
      proc.stdout.on("data", (chunk: Buffer) => {
        if (state.announced) return
        state.buffer += chunk.toString()
        const lines = state.buffer.split("\n")
        state.buffer = (lines.pop() ?? "").slice(-65_536)
        for (const line of lines) {
          try {
            const value = (() => {
              if (line.startsWith("{")) {
                const value: unknown = JSON.parse(line)
                if (!value || typeof value !== "object" || !("type" in value) || value.type !== "server.ready") return
                if (
                  !("schemaVersion" in value) ||
                  value.schemaVersion !== 1 ||
                  !("url" in value) ||
                  typeof value.url !== "string"
                ) {
                  throw new Error("Unsupported OpenScience server readiness record")
                }
                if (!("pid" in value) || value.pid !== proc.pid)
                  throw new Error("OpenScience server readiness process mismatch")
                return value.url
              }
              // Older runtimes ignore the readiness environment option. Their
              // human announcement remains supported, followed by the same probe.
              return line.match(/^openscience server listening on\s+(https?:\/\/[^\s]+)/)?.[1]
            })()
            if (!value) continue
            state.announced = true
            void check(value).then(resolve, fail)
            break
          } catch (error) {
            fail(error)
          }
        }
      })
      proc.stderr.on("data", (chunk: Buffer) => {
        state.output = (state.output + chunk.toString()).slice(-8192)
      })
    })
    // Abort continues to own shutdown after startup; attached clients have no
    // corresponding child or signal hook.
    controller.signal.addEventListener("abort", () => void close().catch(() => undefined), { once: true })
    if (controller.signal.aborted) {
      await close()
      controller.signal.throwIfAborted()
    }
    return { url, pid: proc.pid!, close }
  } catch (error) {
    controller.abort(error)
    await close().catch((cleanup) => {
      throw new AggregateError([error, cleanup], "Server startup and cleanup failed")
    })
    throw error
  } finally {
    if (timer.id) clearTimeout(timer.id)
  }
}
