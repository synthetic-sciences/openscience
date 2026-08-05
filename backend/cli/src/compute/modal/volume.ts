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
    python?: string
    uv?: string
  }

  export type Entry = {
    path: string
    type: string
    size: number
    mtime?: number
  }

  export type Volume = {
    name: string
  }

  export type Download = {
    path: string
    staging: string
    size: number
    sha256: string
  }

  type Request =
    | { action: "check" }
    | { action: "volumes"; environment?: string }
    | { action: "list"; volume: string; environment?: string; path: string; recursive: boolean }
    | {
        action: "wait"
        volume: string
        environment?: string
        path: string
        recursive: boolean
        marker: string
        attempts: number
        interval_ms: number
      }
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

  const cache: { path?: Promise<string> } = {}

  export async function driverPath() {
    if (cache.path) return cache.path
    const pending = Promise.resolve().then(async () => {
      const source = Bun.file(driver)
      const bytes = Buffer.from(await source.arrayBuffer())
      const target = path.join(Global.Path.data, "runtime", `modal-volume-${Bun.hash(bytes)}.py`)
      const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
      await fs.mkdir(path.dirname(target), { recursive: true })
      const installed = Bun.file(target)
      if ((await installed.exists()) && Bun.hash(await installed.arrayBuffer()) === Bun.hash(bytes)) return target
      await fs.writeFile(temp, bytes, { mode: 0o600, flag: "wx" })
      await fs.rename(temp, target).catch(async (error) => {
        await fs.unlink(temp).catch(() => undefined)
        if (await Bun.file(target).exists()) return
        throw error
      })
      return target
    })
    cache.path = pending.catch((error) => {
      cache.path = undefined
      throw error
    })
    return cache.path
  }

  export async function command(context: Context) {
    if (context.command) return context.command
    const file = await driverPath()
    const python = context.python ?? Bun.which("python3") ?? Bun.which("python")
    if (python) {
      const probe = Bun.spawn(
        [
          python,
          "-I",
          "-c",
          `import modal; assert modal.__version__ == '${VERSION}'; assert hasattr(modal.Volume, 'read_file')`,
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          env: environment(context.env ?? process.env),
        },
      )
      if ((await probe.exited) === 0) return [python, "-I", file]
    }
    const uv = context.uv ?? Bun.which("uv")
    if (uv) {
      return [uv, "run", "--no-project", "--python", "3.12", "--with", `modal==${VERSION}`, "python", "-I", file]
    }
    throw new Error("Modal Volume access requires uv or a Python installation that can import the Modal SDK")
  }

  function environment(source: Record<string, string | undefined>) {
    const env = { ...source }
    for (const name of ["PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONUSERBASE"]) {
      delete env[name]
    }
    env.PYTHONNOUSERSITE = "1"
    return env
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
    const env = environment(context.env ?? process.env)
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

  export async function volumes(context: Context): Promise<Volume[]> {
    const result = await invoke({ action: "volumes", environment: context.environment }, context, LIST_TIMEOUT)
    if (!Array.isArray(result)) throw new Error("Modal Volume discovery did not return an array")
    return result.map((entry) => {
      if (!entry || typeof entry !== "object" || !("name" in entry) || typeof entry.name !== "string") {
        throw new Error("Modal Volume discovery returned an invalid name")
      }
      if (!entry.name.trim()) throw new Error("Modal Volume discovery returned an empty name")
      return { name: entry.name }
    })
  }

  export async function list(context: Context, volume: string, root = "/", recursive = false): Promise<Entry[]> {
    const requested = root.replaceAll("\\", "/")
    if (requested.includes("\0") || requested.split("/").includes("..")) {
      throw new Error(`Modal Volume list received an unsafe path: ${root}`)
    }
    const result = await invoke(
      { action: "list", volume, environment: context.environment, path: requested, recursive },
      context,
      LIST_TIMEOUT,
    )
    return entries(result, "list")
  }

  export async function wait(
    context: Context,
    volume: string,
    marker: string,
    attempts = 20,
    interval = 500,
  ): Promise<Entry[]> {
    const target = safe(marker)
    const result = await invoke(
      {
        action: "wait",
        volume,
        environment: context.environment,
        path: "/",
        recursive: true,
        marker: target,
        attempts,
        interval_ms: interval,
      },
      context,
      LIST_TIMEOUT,
    )
    return entries(result, "wait")
  }

  function entries(result: unknown, action: "list" | "wait"): Entry[] {
    if (!Array.isArray(result)) throw new Error(`Modal Volume ${action} did not return an array`)
    return result.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error(`Modal Volume ${action} returned an invalid entry`)
      if (!("path" in entry) || typeof entry.path !== "string") {
        throw new Error(`Modal Volume ${action} returned an entry without a path`)
      }
      if (!("type" in entry) || typeof entry.type !== "string") {
        throw new Error(`Modal Volume ${action} returned an invalid type for ${entry.path}`)
      }
      if (!("size" in entry) || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new Error(`Modal Volume ${action} returned an invalid size for ${entry.path}`)
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
    const root = await fs.realpath(staging)
    return Promise.all(
      result.map(async (entry) => {
        if (!entry || typeof entry !== "object") throw new Error("Modal Volume download returned an invalid entry")
        if (!("path" in entry) || typeof entry.path !== "string") {
          throw new Error("Modal Volume download returned an entry without a path")
        }
        if (!("staging" in entry) || typeof entry.staging !== "string") {
          throw new Error(`Modal Volume download returned no local path for ${entry.path}`)
        }
        if (
          !("size" in entry) ||
          typeof entry.size !== "number" ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0
        ) {
          throw new Error(`Modal Volume download returned an invalid size for ${entry.path}`)
        }
        if (!("sha256" in entry) || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
          throw new Error(`Modal Volume download returned an invalid checksum for ${entry.path}`)
        }
        const relative = safe(entry.path)
        const expected = path.resolve(root, ...relative.split("/"))
        const actual = await fs.realpath(entry.staging).catch(() => undefined)
        if (actual !== expected) {
          throw new Error(`Modal Volume download escaped its staging directory: ${entry.path}`)
        }
        return { path: relative, staging: expected, size: entry.size, sha256: entry.sha256 }
      }),
    )
  }
}
