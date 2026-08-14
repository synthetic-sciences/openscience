import { Hono } from "hono"
import { validator } from "hono-openapi"
import z from "zod"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { lazy } from "../../../util/lazy"
import { Log } from "../../../util/log"
import { Config } from "../../../config/config"
import { Provider } from "../../../provider/provider"
import { LocalProvider } from "../../../provider/local"
import { Global } from "../../../global"
import { CredentialProcessLedger } from "../../../credentials/process-ledger"
import { ProcessIdentity } from "../../../process/process-identity"
import { DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX } from "../../../process/darwin-responsibility-launcher"
import { WindowsJobLauncher } from "../../../process/windows-job-launcher"
import { Shell } from "../../../shell/shell"
import { FileLease } from "../../../util/file-lease"

const log = Log.create({ service: "settings-local" })

export namespace LocalRuntime {
  const RUNTIME_ENV = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "OLLAMA_HOST",
    "OLLAMA_MODELS",
    "OLLAMA_ORIGINS",
    "OLLAMA_KEEP_ALIVE",
    "OLLAMA_NOHISTORY",
    "OLLAMA_DEBUG",
    "OLLAMA_FLASH_ATTENTION",
    "OLLAMA_KV_CACHE_TYPE",
    "OLLAMA_MAX_LOADED_MODELS",
    "OLLAMA_NUM_PARALLEL",
    "OLLAMA_MAX_QUEUE",
    "OLLAMA_SCHED_SPREAD",
    "OLLAMA_LLM_LIBRARY",
  ])

  interface Managed {
    id: string
    ledger: string
    child: ChildProcess
    detached: boolean
    identity?: string
    release?: string
    settled?: { code: number | null; signal: NodeJS.Signals | null; error?: string }
  }

  const active = new Map<string, Managed>()

  /** Local inference servers get runtime discovery/configuration only. They do
   * not inherit LLM keys, cloud credentials, Modal tokens, Atlas/OpenScience
   * control-plane variables, dynamic-loader hooks, or language startup hooks. */
  export function environment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [name, value] of Object.entries(source)) {
      if (!value) continue
      const key = process.platform === "win32" ? name.toUpperCase() : name
      if (RUNTIME_ENV.has(key) || key.startsWith("LC_")) result[name] = value
    }
    return {
      ...result,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    }
  }

  function ledgerID(id: string) {
    return `local-runtime-${crypto.createHash("sha256").update(id).digest("hex").slice(0, 32)}`
  }

  function lockPath(id: string) {
    return path.join(Global.Path.data, "local-runtime", `${crypto.createHash("sha256").update(id).digest("hex")}.lock`)
  }

  async function complete(id: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await CredentialProcessLedger.complete(id)) return
      await Bun.sleep(20)
    }
    await CredentialProcessLedger.revoke({ id, kind: "local-runtime" })
  }

  async function cleanupGate(release?: string) {
    if (!release) return
    await Promise.all([
      fs.rm(release, { force: true }).catch(() => undefined),
      fs.rm(`${release}${DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX}`, { force: true }).catch(() => undefined),
    ])
  }

  async function stopManaged(value: Managed) {
    const failures: unknown[] = []
    await CredentialProcessLedger.revoke({ id: value.ledger, kind: "local-runtime" }).catch((error) =>
      failures.push(error),
    )
    const stillOwned =
      value.child.pid && value.identity
        ? await CredentialProcessLedger.owns(value.child.pid, value.identity)
        : value.identity === undefined
    if (stillOwned && value.child.exitCode === null && value.child.signalCode === null) {
      await Shell.killTree(value.child, {
        detached: value.detached,
        exited: () => value.child.exitCode !== null || value.child.signalCode !== null,
      }).catch((error) => failures.push(error))
    }
    if (active.get(value.id) === value) active.delete(value.id)
    await cleanupGate(value.release)
    if (failures.length) throw new AggregateError(failures, `Local runtime ${value.id} could not be stopped`)
  }

  export async function stop(id: string): Promise<boolean> {
    const value = active.get(id)
    if (value) {
      await stopManaged(value)
      return true
    }
    return (await CredentialProcessLedger.revoke({ id: ledgerID(id), kind: "local-runtime" })) > 0
  }

  export async function stopAll(): Promise<number> {
    const known = [...active.values()]
    const recovered = await CredentialProcessLedger.revoke("local-runtime")
    await Promise.all(known.map((value) => stopManaged(value)))
    return Math.max(recovered, known.length)
  }

  export async function start<T>(input: {
    id: string
    file: string
    args: string[]
    probe: () => Promise<T | null>
    timeoutMs?: number
  }): Promise<{ alreadyRunning: boolean; value: T }> {
    await using lease = await FileLease.acquire(lockPath(input.id), (input.timeoutMs ?? 15_000) + 10_000)
    const already = await input.probe()
    if (already !== null) return { alreadyRunning: true, value: already }

    const current = active.get(input.id)
    if (current && !current.settled) await stopManaged(current)
    const ledger = ledgerID(input.id)
    // Recover exact ownership left by a killed prior server before replacing
    // this stable runtime id. A second live server is serialized by the lease.
    await CredentialProcessLedger.revoke({ id: ledger, kind: "local-runtime" })

    const linuxOwner =
      process.platform === "linux"
        ? await ProcessIdentity.capture(process.pid).then((identity) =>
            identity ? { pid: process.pid, identity } : undefined,
          )
        : undefined
    if (process.platform === "linux" && !linuxOwner) {
      throw new Error(`Could not capture the Linux server identity for local runtime ${input.id}`)
    }
    const wrapped = WindowsJobLauncher.wrap({ file: input.file, args: input.args, linuxOwner })
    const detached = process.platform !== "win32"
    const child = spawn(wrapped.file, wrapped.args, {
      env: environment(),
      detached,
      windowsHide: true,
      stdio: "ignore",
    })
    WindowsJobLauncher.bind(child, wrapped.release)
    const managed: Managed = { id: input.id, ledger, child, detached, release: wrapped.release }
    const completion = new Promise<NonNullable<Managed["settled"]>>((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }))
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    try {
      if (!child.pid) throw new Error(`Local runtime ${input.id} started without a process id`)
      managed.identity = await CredentialProcessLedger.identity(child.pid)
      if (!managed.identity) throw new Error(`Could not establish a safe identity for local runtime ${input.id}`)
      const registered = await CredentialProcessLedger.register({
        id: ledger,
        kind: "local-runtime",
        pid: child.pid,
        detached,
        identity: managed.identity,
        windowsRelease: wrapped.release,
      })
      if (!registered) throw new Error(`Local runtime ${input.id} exited before durable ownership was established`)
      if (process.platform === "linux" && wrapped.release) {
        await WindowsJobLauncher.release(wrapped.release, child.pid)
      }
      active.set(input.id, managed)
      void completion.then(async (settled) => {
        managed.settled = settled
        if (active.get(input.id) === managed) active.delete(input.id)
        await complete(ledger).catch((error) => log.error("local runtime completion failed", { id: input.id, error }))
        await cleanupGate(managed.release)
      })
    } catch (error) {
      await stopManaged(managed).catch(() => undefined)
      throw error
    }

    const deadline = Date.now() + (input.timeoutMs ?? 15_000)
    while (Date.now() < deadline) {
      const value = await input.probe()
      if (value !== null) {
        // Do not report a daemonized/unowned endpoint as an OpenScience-managed
        // start. The OS-owned supervisor must still be alive at handoff.
        await Bun.sleep(100)
        if (!managed.settled && active.get(input.id) === managed) return { alreadyRunning: false, value }
      }
      if (managed.settled) {
        const detail = managed.settled.error || `exit ${managed.settled.code ?? managed.settled.signal ?? "unknown"}`
        throw new Error(`Local runtime ${input.id} did not remain under OpenScience ownership (${detail})`)
      }
      await Bun.sleep(400)
    }
    await stopManaged(managed)
    throw new Error(`Local runtime ${input.id} did not answer within ${input.timeoutMs ?? 15_000}ms`)
  }
}

/** Provider ids in config whose baseURL points at the local machine. */
async function configuredLocals() {
  const config = await Config.get().catch(() => ({}) as any)
  return Object.entries(config.provider ?? {})
    .filter(([, p]: [string, any]) => Provider.isLocalBaseURL(p?.options?.baseURL ?? p?.api))
    .map(([id, p]: [string, any]) => ({
      id,
      name: p?.name ?? id,
      baseURL: (p?.options?.baseURL ?? p?.api) as string,
      models: Object.keys(p?.models ?? {}),
    }))
}

/**
 * Local-model management for the workspace GUI. The SPA can't probe
 * `localhost:11434` itself (cross-origin), so the server — which CAN reach local
 * endpoints — does detection and listing on its behalf, and writes the provider
 * config block. Mirrors the `openscience local` CLI wizard.
 */
export const LocalModelsRoutes = lazy(() =>
  new Hono()
    // Configured local providers.
    .get("/", async (c) => c.json({ providers: await configuredLocals(), presets: LocalProvider.PRESETS }))

    // Auto-startable runtimes: is the CLI installed, and is it already running?
    .get("/status", async (c) => {
      const runtimes = await Promise.all(
        Object.entries(LocalProvider.RUNTIME_COMMANDS).map(async ([id, cmd]) => {
          const preset = LocalProvider.PRESETS.find((p) => p.id === id)
          const installed = !!Bun.which(cmd.bin)
          const models = preset ? await LocalProvider.probe(preset.baseURL, preset.apiKey) : null
          return {
            id,
            name: preset?.name ?? id,
            baseURL: preset?.baseURL,
            installed,
            running: Array.isArray(models),
            models: models ?? [],
            install: cmd.install,
            serveHint: cmd.serveHint,
          }
        }),
      )
      return c.json({ runtimes })
    })

    // Start (host) a runtime's server for the user, then wait until it responds.
    .post("/start", validator("json", z.object({ id: z.string() })), async (c) => {
      const { id } = c.req.valid("json")
      const cmd = LocalProvider.RUNTIME_COMMANDS[id]
      const preset = LocalProvider.PRESETS.find((p) => p.id === id)
      if (!cmd || !preset) return c.json({ error: `Unknown or non-startable runtime: ${id}` }, 400)

      const executable = Bun.which(cmd.bin)
      if (!executable) {
        return c.json({ id, running: false, installed: false, install: cmd.install }, 200)
      }

      try {
        const started = await LocalRuntime.start({
          id,
          file: executable,
          args: cmd.serve,
          probe: () => LocalProvider.probe(preset.baseURL, preset.apiKey),
        })
        if (!started.alreadyRunning) log.info("started owned local runtime", { id, bin: executable })
        return c.json({
          id,
          running: true,
          ...(started.alreadyRunning ? { alreadyRunning: true } : { started: true }),
          models: started.value,
        })
      } catch (e) {
        return c.json({ id, running: false, error: e instanceof Error ? e.message : String(e) }, 200)
      }
    })

    // Probe the well-known runtimes and report which are running + their models.
    .get("/detect", async (c) => {
      const detected = await LocalProvider.detect().catch(() => [])
      return c.json({
        detected: detected.map((d) => ({
          id: d.preset.id,
          name: d.preset.name,
          baseURL: d.preset.baseURL,
          models: d.models,
        })),
      })
    })

    // List the models a specific endpoint exposes (for a custom URL entry).
    .post("/models", validator("json", z.object({ url: z.string(), key: z.string().optional() })), async (c) => {
      const { url, key } = c.req.valid("json")
      const baseURL = LocalProvider.normalizeBaseURL(url)
      try {
        const models = await LocalProvider.listModels(baseURL, key)
        return c.json({ baseURL, models })
      } catch (e) {
        return c.json({ baseURL, models: [], error: e instanceof Error ? e.message : String(e) }, 200)
      }
    })

    // Register (or update) a local provider block.
    .post(
      "/",
      validator(
        "json",
        z.object({
          url: z.string(),
          id: z.string().optional(),
          name: z.string().optional(),
          key: z.string().optional(),
          models: z.array(z.string()).min(1),
          setDefault: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const baseURL = LocalProvider.normalizeBaseURL(body.url)
        let host = "local"
        try {
          host = new URL(baseURL).host
        } catch {}
        const id = (body.id || `local-${host.split(":")[1] || host}`).replace(/[^a-z0-9-]/gi, "-").toLowerCase()
        const block = LocalProvider.buildProviderConfig({
          name: body.name || `Local (${host})`,
          baseURL,
          apiKey: body.key,
          models: body.models,
        })
        await Config.setProvider(id, block as any, "global")
        if (body.setDefault) await Config.updateGlobal({ model: `${id}/${body.models[0]}` })
        Provider.invalidate()
        log.info("registered local provider", { id, baseURL, models: body.models.length })
        return c.json({ id, baseURL, models: body.models })
      },
    )

    // Remove a local provider.
    .delete("/:id", async (c) => {
      const id = c.req.param("id")
      await Config.removeProvider(id, "global").catch(() => {})
      await Config.removeProvider(id, "project").catch(() => {})
      Provider.invalidate()
      return c.json({ id, removed: true })
    }),
)
