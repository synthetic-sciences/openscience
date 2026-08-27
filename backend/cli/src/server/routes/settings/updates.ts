import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { Installation } from "../../../installation"
import { lazy } from "../../../util/lazy"

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
})

type UpdateResult = z.infer<typeof Result>
type UpdateInstallResult = z.infer<typeof InstallResult>

export function supportsAutomaticUpdate(method: string) {
  return ["curl", "npm", "pnpm", "yarn", "bun", "brew", "choco", "scoop"].includes(method)
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
        return InstallResult.parse({ ...result, installed: false, restartRequired: false })
      }
      if (!supportsAutomaticUpdate(result.method)) {
        throw new Error("Automatic updates are unavailable for this installation.")
      }
      await input.upgrade(result.method as Installation.Method, result.latest)
      return InstallResult.parse({ ...result, installed: true, restartRequired: true })
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
        },
      }),
      async (c) => {
        return c.json(await install())
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
