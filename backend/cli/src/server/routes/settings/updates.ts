import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { Installation } from "../../../installation"
import { lazy } from "../../../util/lazy"
import { SelfRestart } from "../../../process/self-restart"
import { SessionPrompt } from "../../../session/prompt"
import { ComputeJobs } from "../../../compute/jobs"
import { AuthoritySignal } from "../../../project/authority-signal"
import { UpdateQuiescence } from "../../../process/update-quiescence"
import { timingSafeEqual } from "../../../util/timing-safe"
import { GracefulShutdown } from "../../../process/graceful-shutdown"

const RELEASES = "https://github.com/synthetic-sciences/openscience/releases"
const RELEASES_API = "https://api.github.com/repos/synthetic-sciences/openscience/releases?per_page=20"
const CACHE_TTL = 5 * 60_000

export function isNewerVersion(current: string, latest: string) {
  if (current === "local" || current === latest) return false
  try {
    return Bun.semver.order(current, latest) < 0
  } catch {
    return false
  }
}

const Result = z.object({
  current: z.string(),
  latest: z.string(),
  channel: z.string(),
  method: z.string(),
  updateAvailable: z.boolean(),
  releaseNotes: z.string().url(),
})

const InstallResult = Result.extend({
  installed: z.boolean(),
  restartRequired: z.boolean(),
  restartScheduled: z.boolean().default(false),
})

const Failure = z.object({ error: z.string() })

type UpdateResult = z.infer<typeof Result>
type UpdateInstallResult = z.infer<typeof InstallResult>

export function supportsAutomaticUpdate(method: string) {
  return ["curl", "npm", "pnpm", "yarn", "bun", "brew", "choco", "scoop", "desktop"].includes(method)
}

export function desktopUpdateShutdownAuthorized(authorization: string | undefined, token: string | undefined) {
  if (!token || !authorization?.startsWith("Bearer ")) return false
  const candidate = authorization.slice("Bearer ".length)
  return !!candidate && timingSafeEqual(candidate, token)
}

export type DesktopUpdateActivity = {
  sessions: number
  compute: number
  pty: number
  kernel: number
  mcp: number
  admitted?: number
}

export function desktopUpdateBlockers(input: DesktopUpdateActivity) {
  const noun = (count: number, singular: string, plural = `${singular}s`) =>
    count ? [`${count} ${count === 1 ? singular : plural}`] : []
  const categorized = input.pty + input.kernel + input.mcp
  const transitioning = Math.max(0, (input.admitted ?? categorized) - categorized)
  return [
    ...noun(input.sessions, "agent run"),
    ...noun(input.compute, "compute job"),
    ...noun(input.pty, "interactive terminal"),
    ...noun(input.kernel, "kernel execution"),
    ...noun(input.mcp, "MCP request"),
    ...(transitioning && !input.sessions && !input.compute ? noun(transitioning, "runtime transition") : []),
  ]
}

export function createUpdateInstaller(input: {
  resolve: () => Promise<UpdateResult>
  upgrade: (method: Installation.Method, target: string) => Promise<void>
}) {
  const state: { pending?: Promise<UpdateInstallResult> } = {}
  return () => {
    if (state.pending) return state.pending
    const pending = input.resolve().then(async (result) => {
      if (!result.updateAvailable) {
        return InstallResult.parse({
          ...result,
          installed: false,
          restartRequired: false,
          restartScheduled: false,
        })
      }
      if (!supportsAutomaticUpdate(result.method)) {
        throw new Error("Automatic updates are unavailable for this installation.")
      }
      await input.upgrade(result.method as Installation.Method, result.latest)
      return InstallResult.parse({
        ...result,
        installed: result.method !== "desktop",
        restartRequired: true,
        restartScheduled: false,
      })
    })
    state.pending = pending
    void pending.then(
      () => {
        if (state.pending === pending) state.pending = undefined
      },
      () => {
        if (state.pending === pending) state.pending = undefined
      },
    )
    return pending
  }
}

/**
 * Deduplicates startup/background update probes without making an explicit
 * manual check stale. Failed probes are never retained, so a transient package
 * manager or registry failure can be retried immediately.
 */
export function createUpdateCache<T>(input: { load: () => Promise<T>; ttl?: number; now?: () => number }) {
  const cache: { value?: Promise<T>; pending?: Promise<T>; expires?: number } = {}
  const now = input.now ?? Date.now

  return (refresh = false) => {
    const timestamp = now()
    if (cache.pending) return cache.pending
    if (!refresh && cache.value && cache.expires && cache.expires > timestamp) return cache.value

    const value = Promise.resolve().then(input.load)
    cache.value = value
    cache.pending = value
    cache.expires = timestamp + (input.ttl ?? CACHE_TTL)
    void value.then(
      () => {
        if (cache.pending === value) cache.pending = undefined
      },
      () => {
        if (cache.pending === value) cache.pending = undefined
        if (cache.value !== value) return
        cache.value = undefined
        cache.expires = undefined
      },
    )
    return value
  }
}

// The installation mechanism belongs to the running executable and cannot
// change until this process restarts. Keep that expensive package-manager
// discovery separate so a manual version refresh only rechecks the registry.
const method = createUpdateCache({
  load: Installation.method,
  ttl: Number.POSITIVE_INFINITY,
})

const update = createUpdateCache({
  load: async () => {
    const install = await method()
    const latest = await Installation.latest(install)
    return Result.parse({
      current: Installation.VERSION,
      latest,
      channel: Installation.CHANNEL,
      method: install,
      updateAvailable: isNewerVersion(Installation.VERSION, latest),
      releaseNotes: RELEASES,
    })
  },
})

const install = createUpdateInstaller({
  resolve: () => update(true),
  upgrade: Installation.upgrade,
})

export const UpdatesSettingsRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Check for an OpenScience update",
        operationId: "settings.updates.check",
        responses: {
          200: {
            description: "Current and latest package versions",
            content: { "application/json": { schema: resolver(Result) } },
          },
        },
      }),
      async (c) => {
        return c.json(await update(c.req.query("refresh") === "1"))
      },
    )
    .get(
      "/state",
      describeRoute({
        summary: "Get desktop update progress",
        operationId: "settings.updates.state",
        responses: {
          200: {
            description: "Desktop update state",
            content: { "application/json": { schema: resolver(Installation.DesktopUpdateState) } },
          },
        },
      }),
      async (c) => c.json(await Installation.desktopUpdateState()),
    )
    .post(
      "/stage",
      describeRoute({
        summary: "Download and verify the desktop update",
        operationId: "settings.updates.stage",
        responses: {
          202: {
            description: "Desktop update staging began",
            content: { "application/json": { schema: resolver(Installation.DesktopUpdateState) } },
          },
        },
      }),
      async (c) => {
        const result = await update(true)
        if (result.method !== "desktop") throw new Error("Staged updates are available only in the desktop app")
        return c.json(await Installation.stageDesktopUpdate(result.latest), 202)
      },
    )
    .post(
      "/apply",
      describeRoute({
        summary: "Restart into a verified desktop update",
        operationId: "settings.updates.apply",
        responses: {
          202: {
            description: "Desktop restart scheduled",
            content: { "application/json": { schema: resolver(Installation.DesktopUpdateState) } },
          },
          409: {
            description: "Active work must finish before restart",
            content: { "application/json": { schema: resolver(Failure) } },
          },
        },
      }),
      async (c) => {
        const desktop = await Installation.desktopUpdateState().catch(() => undefined)
        if (desktop?.phase === "restart_blocked" && desktop.version) {
          return c.json(await Installation.applyDesktopUpdate(desktop.version), 202)
        }
        const outcome = await AuthoritySignal.exclusive(async () => {
          const sessions = SessionPrompt.activeCount()
          const compute = ComputeJobs.activeCount()
          const runtime = UpdateQuiescence.inventory()
          const blockers = desktopUpdateBlockers({ sessions, compute, ...runtime })
          if (blockers.length) {
            return {
              error: `Finish active work before restarting OpenScience: ${blockers.join(", ")}.`,
            }
          }

          const staged = desktop ?? (await Installation.desktopUpdateState())
          if (staged.phase !== "ready" || !staged.version) {
            return { error: "The desktop update is not verified and ready yet." }
          }

          let release: (() => void) | undefined
          try {
            release = UpdateQuiescence.begin()
            const value = await Installation.applyDesktopUpdate(staged.version)
            // A successful handoff deliberately keeps admission closed until
            // Electron stops this backend and launches the verified bundle.
            release = undefined
            return { value }
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) }
          } finally {
            release?.()
          }
        })
        if ("error" in outcome) return c.json(Failure.parse({ error: outcome.error }), 409)
        return c.json(outcome.value, 202)
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Gracefully release runtimes before a desktop restart",
        operationId: "settings.updates.dispose",
        responses: {
          204: { description: "Every process-local runtime was released" },
          401: {
            description: "The desktop capability token is missing or invalid",
            content: { "application/json": { schema: resolver(Failure) } },
          },
          503: {
            description: "Runtime disposal did not finish within the bounded handoff",
            content: { "application/json": { schema: resolver(Failure) } },
          },
        },
      }),
      async (c) => {
        if (
          !desktopUpdateShutdownAuthorized(c.req.header("authorization"), process.env.OPENSCIENCE_DESKTOP_UPDATE_TOKEN)
        ) {
          c.header("WWW-Authenticate", 'Bearer realm="openscience-desktop-update"')
          return c.json(Failure.parse({ error: "The desktop update capability is invalid." }), 401)
        }
        const result = await GracefulShutdown.run({ timeoutMs: 4_000 }).then(
          () => ({ ok: true as const }),
          (error) => ({ error: error instanceof Error ? error.message : String(error) }),
        )
        if ("error" in result) return c.json(Failure.parse({ error: result.error }), 503)
        return c.body(null, 204)
      },
    )
    .delete(
      "/stage",
      describeRoute({
        summary: "Cancel or discard a staged desktop update",
        operationId: "settings.updates.cancel",
        responses: {
          200: {
            description: "Desktop update discarded",
            content: { "application/json": { schema: resolver(Installation.DesktopUpdateState) } },
          },
        },
      }),
      async (c) => c.json(await Installation.cancelDesktopUpdate()),
    )
    .post(
      "/",
      describeRoute({
        summary: "Install the latest OpenScience release",
        operationId: "settings.updates.install",
        responses: {
          200: {
            description: "Installation result",
            content: { "application/json": { schema: resolver(InstallResult) } },
          },
          409: {
            description: "The current installation cannot be updated automatically",
            content: { "application/json": { schema: resolver(Failure) } },
          },
        },
      }),
      async (c) => {
        const outcome = await install().then(
          (value) => ({ value }),
          (error) => ({ error: error instanceof Error ? error.message : String(error) }),
        )
        if ("error" in outcome) return c.json(Failure.parse({ error: outcome.error }), 409)
        const result = outcome.value
        const restartScheduled = result.installed ? result.method === "desktop" || SelfRestart.schedule() : false
        return c.json(InstallResult.parse({ ...result, restartScheduled }))
      },
    )
    .get("/releases", async (c) => {
      const response = await fetch(RELEASES_API, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": Installation.USER_AGENT,
        },
      })
      if (!response.ok) return c.json({ error: `Release history unavailable (${response.status})` }, 502)
      return c.json(await response.json())
    }),
)
