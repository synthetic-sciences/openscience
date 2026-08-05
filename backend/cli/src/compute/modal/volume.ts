import fs from "fs/promises"
import path from "path"
import driver from "./volume.py" with { type: "file" }
import { Global } from "../../global"

export namespace ModalVolume {
  export const VERSION = "1.1.4"

  export type Context = {
    tokenId: string
    tokenSecret: string
    environment?: string
    command?: string[]
    env?: Record<string, string | undefined>
  }

  export type Entry = {
    path: string
    type: string
    size: number
    mtime?: number
  }

  export type Download = {
    path: string
    staging: string
    size: number
  }

  type Request =
    | { action: "check" }
    | { action: "list"; volume: string; environment?: string; path: string; recursive: boolean }
    | { action: "download"; volume: string; environment?: string; paths: string[]; staging: string }

  const LIST_TIMEOUT = 60_000
  const DOWNLOAD_TIMEOUT = 10 * 60_000
  const GRACE = 200
  const text = new TextDecoder()
  const clean = (value: string) => value.replaceAll("\\", "/").replace(/^\/+/, "")
  const safe = (value: string) => {
    const result = clean(value)
    if (!result || result.split("/").includes("..")) throw new Error(`Modal Volume returned an unsafe path: ${value}`)
    return result
  }

  let materialized: string | undefined

  export async function driverPath() {
    if (materialized) return materialized
    const source = Bun.file(driver)
    const target = path.join(Global.Path.data, "runtime", `modal-volume-${Bun.hash(await source.text())}.py`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await Bun.write(target, source)
    materialized = target
    return target
  }

  async function command(context: Context) {
    if (context.command) return context.command
    const file = await driverPath()
    const python = Bun.which("python3") ?? Bun.which("python")
    if (python) {
      const probe = Bun.spawn([python, "-c", "import modal; assert hasattr(modal.Volume, 'read_file')"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      if ((await probe.exited) === 0) return [python, file]
    }
    const uv = Bun.which("uv")
    if (uv) return [uv, "run", "--python", "3.12", "--with", `modal==${VERSION}`, "python", file]
    throw new Error("Modal Volume access requires uv or a Python installation that can import the Modal SDK")
  }

  function kill(pid: number) {
    if (process.platform === "win32") {
      Bun.spawn(["taskkill", "/pid", String(pid), "/f", "/t"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      return
    }
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      return
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {}
    }, GRACE)
  }

  async function invoke(request: Request, context: Context, timeout: number) {
    const env = { ...(context.env ?? process.env) }
    env.MODAL_TOKEN_ID = context.tokenId
    env.MODAL_TOKEN_SECRET = context.tokenSecret
    const proc = Bun.spawn(await command(context), {
      stdin: Buffer.from(JSON.stringify(request)),
      stdout: "pipe",
      stderr: "pipe",
      env,
      detached: true,
    })
    const drained = Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
      proc.exited,
    ])
    const timer = Bun.sleep(timeout).then(() => undefined)
    const result = await Promise.race([drained, timer])
    if (!result) {
      kill(proc.pid)
      drained.catch(() => undefined)
      throw new Error(`Modal Volume ${request.action} timed out after ${timeout}ms`)
    }
    const [stdout, stderr, code] = result
    if (proc.signalCode) throw new Error(`Modal Volume ${request.action} was killed by ${proc.signalCode}`)
    if (code !== 0) {
      const detail = stderr.byteLength ? stderr : stdout
      throw new Error(`Modal Volume ${request.action} failed (exit ${code}): ${text.decode(detail).trim()}`)
    }
    try {
      return JSON.parse(text.decode(stdout)) as unknown
    } catch (cause) {
      throw new Error(`Modal Volume ${request.action} returned invalid JSON`, { cause })
    }
  }

  export async function check(context: Context) {
    const result = await invoke({ action: "check" }, context, LIST_TIMEOUT)
    if (!result || typeof result !== "object" || !("version" in result) || typeof result.version !== "string") {
      throw new Error("Modal Volume check returned an invalid SDK version")
    }
    return result.version
  }

  export async function list(context: Context, volume: string, root = "/", recursive = false): Promise<Entry[]> {
    const result = await invoke(
      { action: "list", volume, environment: context.environment, path: root, recursive },
      context,
      LIST_TIMEOUT,
    )
    if (!Array.isArray(result)) throw new Error("Modal Volume list did not return an array")
    return result.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Modal Volume list returned an invalid entry")
      if (!("path" in entry) || typeof entry.path !== "string") {
        throw new Error("Modal Volume list returned an entry without a path")
      }
      if (!("type" in entry) || typeof entry.type !== "string") {
        throw new Error(`Modal Volume list returned an invalid type for ${entry.path}`)
      }
      if (!("size" in entry) || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new Error(`Modal Volume list returned an invalid size for ${entry.path}`)
      }
      const mtime = "mtime" in entry && typeof entry.mtime === "number" ? entry.mtime : undefined
      return { path: safe(entry.path), type: entry.type, size: entry.size, ...(mtime === undefined ? {} : { mtime }) }
    })
  }

  export async function download(
    context: Context,
    volume: string,
    paths: string[],
    staging: string,
  ): Promise<Download[]> {
    const files = paths.map(safe)
    await fs.rm(staging, { recursive: true, force: true })
    await fs.mkdir(staging, { recursive: true, mode: 0o700 })
    const result = await invoke(
      { action: "download", volume, environment: context.environment, paths: files, staging },
      context,
      DOWNLOAD_TIMEOUT,
    )
    if (!Array.isArray(result)) throw new Error("Modal Volume download did not return an array")
    return result.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Modal Volume download returned an invalid entry")
      if (!("path" in entry) || typeof entry.path !== "string") {
        throw new Error("Modal Volume download returned an entry without a path")
      }
      if (!("staging" in entry) || typeof entry.staging !== "string") {
        throw new Error(`Modal Volume download returned no local path for ${entry.path}`)
      }
      if (!("size" in entry) || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new Error(`Modal Volume download returned an invalid size for ${entry.path}`)
      }
      const relative = safe(entry.path)
      const expected = path.resolve(staging, ...relative.split("/"))
      if (path.resolve(entry.staging) !== expected) {
        throw new Error(`Modal Volume download escaped its staging directory: ${entry.path}`)
      }
      return { path: relative, staging: expected, size: entry.size }
    })
  }
}
