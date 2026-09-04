import path from "path"
import fs from "fs/promises"
import { appendFileSync } from "fs"
import { Global } from "../global"
import { DataRootBarrier } from "../global/data-root-barrier"
import z from "zod"

export namespace Log {
  export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
  export type Level = z.infer<typeof Level>

  const levelPriority: Record<Level, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  let level: Level = "INFO"

  function shouldLog(input: Level): boolean {
    return levelPriority[input] >= levelPriority[level]
  }

  export type Logger = {
    debug(message?: any, extra?: Record<string, any>): void
    info(message?: any, extra?: Record<string, any>): void
    error(message?: any, extra?: Record<string, any>): void
    warn(message?: any, extra?: Record<string, any>): void
    /** A copy of this logger carrying one more tag; the receiver is unchanged. */
    tag(key: string, value: string): Logger
    /** An uncached copy with the same tags. */
    clone(): Logger
    /** An uncached copy carrying extra tags, for one call or one stream. */
    child(tags: Record<string, any>): Logger
    time(
      message: string,
      extra?: Record<string, any>,
    ): {
      stop(): void
      [Symbol.dispose](): void
    }
  }

  const loggers = new Map<string, Logger>()

  export const Default = create({ service: "default" })

  export interface Options {
    print: boolean
    dev?: boolean
    level?: Level
  }

  let logpath = ""
  export function file() {
    return logpath
  }
  let write = (msg: any) => {
    process.stderr.write(msg)
    return msg.length
  }
  let pending = Promise.resolve()

  // File-mode lines are batched so one barrier marker and one append cover
  // many lines instead of an fsync-backed marker per line.
  const FLUSH_MS = 50
  const FLUSH_BYTES = 64 * 1024
  const buffered: string[] = []
  const buffer = { size: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined, exit: false }

  function drain() {
    if (buffer.timer) clearTimeout(buffer.timer)
    buffer.timer = undefined
    if (!buffered.length) return pending
    const content = buffered.join("")
    buffered.length = 0
    buffer.size = 0
    // Resolve the stable data-root link for every serialized append instead
    // of retaining an fd into one physical root. Relocation intent blocks a
    // new append, drains earlier ones, snapshots the logs, switches the link,
    // then releases the same precomputed path onto the new target.
    pending = pending
      .catch(() => undefined)
      .then(async () => {
        await using operation = await DataRootBarrier.enter(logpath, 120_000)
        await fs.appendFile(logpath, content)
      })
      .catch((error) => {
        process.stderr.write(`OpenScience log write failed: ${String(error)}\n`)
      })
    return pending
  }

  export function flush() {
    return drain()
  }

  export async function init(options: Options) {
    if (options.level) level = options.level
    cleanup(Global.Path.log)
    if (options.print) return
    logpath = path.join(
      Global.Path.log,
      options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
    )
    await fs.truncate(logpath).catch(() => {})
    write = (msg: any) => {
      const content = String(msg)
      buffered.push(content)
      buffer.size += content.length
      if (buffer.size >= FLUSH_BYTES) {
        drain()
        return content.length
      }
      if (!buffer.timer) buffer.timer = setTimeout(drain, FLUSH_MS).unref()
      return content.length
    }
    if (buffer.exit) return
    buffer.exit = true
    // process.exit() skips the async drain, so land whatever is still
    // buffered synchronously on the stable log path. DataRootBarrier is
    // skipped on purpose: it is async, so lines buffered during an in-flight
    // relocation may land on the old physical root rather than be lost.
    process.on("exit", () => {
      if (!buffered.length || !logpath) return
      try {
        appendFileSync(logpath, buffered.join(""))
      } catch {}
      buffered.length = 0
    })
  }

  async function cleanup(dir: string) {
    const glob = new Bun.Glob("????-??-??T??????.log")
    const files = await Array.fromAsync(
      glob.scan({
        cwd: dir,
        absolute: true,
      }),
    )
    if (files.length <= 5) return

    const filesToDelete = files.slice(0, -10)
    await Promise.all(filesToDelete.map((file) => fs.unlink(file).catch(() => {})))
  }

  function formatError(error: Error, depth = 0): string {
    const result = error.message
    return error.cause instanceof Error && depth < 10
      ? result + " Caused by: " + formatError(error.cause, depth + 1)
      : result
  }

  let last = Date.now()

  /** One logger per service, shared by every caller of `create` with that
   * service. Per-call tags belong on `child`/`tag`/`clone` copies, which are
   * never cached: tagging the shared instance would relabel every concurrent
   * caller's lines, and caching the copies would grow the map without bound. */
  export function create(tags?: Record<string, any>) {
    const service = tags?.["service"]
    const cached = typeof service === "string" ? loggers.get(service) : undefined
    if (cached) return cached
    const result = logger({ ...tags })
    if (typeof service === "string") loggers.set(service, result)
    return result
  }

  function logger(tags: Record<string, any>): Logger {
    function build(message: any, extra?: Record<string, any>) {
      const prefix = Object.entries({
        ...tags,
        ...extra,
      })
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          const prefix = `${key}=`
          if (value instanceof Error) return prefix + formatError(value)
          if (typeof value === "object") return prefix + JSON.stringify(value)
          return prefix + value
        })
        .join(" ")
      const next = new Date()
      const diff = next.getTime() - last
      last = next.getTime()
      return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
    }
    const result: Logger = {
      debug(message?: any, extra?: Record<string, any>) {
        if (shouldLog("DEBUG")) {
          write("DEBUG " + build(message, extra))
        }
      },
      info(message?: any, extra?: Record<string, any>) {
        if (shouldLog("INFO")) {
          write("INFO  " + build(message, extra))
        }
      },
      error(message?: any, extra?: Record<string, any>) {
        if (shouldLog("ERROR")) {
          write("ERROR " + build(message, extra))
        }
      },
      warn(message?: any, extra?: Record<string, any>) {
        if (shouldLog("WARN")) {
          write("WARN  " + build(message, extra))
        }
      },
      tag(key: string, value: string) {
        return logger({ ...tags, [key]: value })
      },
      clone() {
        return logger({ ...tags })
      },
      child(extra: Record<string, any>) {
        return logger({ ...tags, ...extra })
      },
      time(message: string, extra?: Record<string, any>) {
        const now = Date.now()
        result.info(message, { status: "started", ...extra })
        function stop() {
          result.info(message, {
            status: "completed",
            duration: Date.now() - now,
            ...extra,
          })
        }
        return {
          stop,
          [Symbol.dispose]() {
            stop()
          },
        }
      },
    }
    return result
  }
}
