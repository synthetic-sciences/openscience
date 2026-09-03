import { Global } from "../global"
import { Log } from "../util/log"
import path from "path"
import z from "zod"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { lazy } from "@/util/lazy"

// Try to import bundled snapshot (generated at build time)
// Falls back to undefined in dev mode when snapshot doesn't exist
/* @ts-ignore */

export namespace ModelsDev {
  const log = Log.create({ service: "models.dev" })
  const filepath = path.join(Global.Path.cache, "models.json")
  const Mode = z
    .object({
      model: z.string().optional(),
      cost: z
        .object({
          input: z.number(),
          output: z.number(),
          cache_read: z.number().optional(),
          cache_write: z.number().optional(),
        })
        .optional(),
      provider: z
        .object({
          body: z.record(z.string(), z.any()).optional(),
          headers: z.record(z.string(), z.string()).optional(),
        })
        .optional(),
    })
    .optional()

  const ReasoningOption = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("toggle"),
    }),
    z.object({
      type: z.literal("effort"),
      values: z.array(z.string().nullable()),
    }),
    z.object({
      type: z.literal("budget_tokens"),
      min: z.number().optional(),
      max: z.number().optional(),
    }),
  ])

  export const Model = z.object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    release_date: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    reasoning_options: z.array(ReasoningOption).optional(),
    temperature: z.boolean(),
    tool_call: z.boolean(),
    interleaved: z
      .union([
        z.literal(true),
        z
          .object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          })
          .strict(),
      ])
      .optional(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
        tiers: z
          .array(
            z.object({
              input: z.number(),
              output: z.number(),
              cache_read: z.number().optional(),
              cache_write: z.number().optional(),
              tier: z.object({ type: z.literal("context"), size: z.number().positive() }),
            }),
          )
          .optional(),
        context_over_200k: z
          .object({
            input: z.number(),
            output: z.number(),
            cache_read: z.number().optional(),
            cache_write: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    limit: z.object({
      context: z.number(),
      input: z.number().optional(),
      output: z.number(),
    }),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      })
      .optional(),
    experimental: z
      .union([
        z.boolean(),
        z.object({
          modes: z.record(z.string(), Mode).optional(),
        }),
      ])
      .optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    options: z.record(z.string(), z.any()),
    headers: z.record(z.string(), z.string()).optional(),
    provider: z.object({ npm: z.string() }).optional(),
    variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  })
  export type Model = z.infer<typeof Model>

  export const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), Model),
  })

  export type Provider = z.infer<typeof Provider>

  function url() {
    return Flag.OPENSCIENCE_MODELS_URL || "https://models.dev"
  }

  function hasCurrentFrontier(data: Record<string, any> | undefined) {
    // A well-formed catalog with the major providers populated is good enough to
    // serve synchronously; actual freshness is guaranteed by the startup (once the
    // cache is a day old) + hourly refresh() below, which refetches live from
    // models.dev. We deliberately
    // do NOT hardcode specific frontier model ids here — they churn (a provider
    // renaming its flagship would wrongly reject an otherwise-current catalog and
    // pin stale data). Just require the catalog to be structurally valid.
    const modelCount = (p: string) => Object.keys((data?.[p]?.models as Record<string, unknown>) ?? {}).length
    return modelCount("anthropic") > 0 && modelCount("openai") > 0
  }

  async function fetchLive() {
    return fetch(`${url()}/api.json`, {
      headers: {
        "User-Agent": Installation.USER_AGENT,
      },
      signal: AbortSignal.timeout(10 * 1000),
    })
      .then((x) => (x.ok ? x.text() : undefined))
      .then((text) => (text ? (JSON.parse(text) as Record<string, unknown>) : undefined))
      .catch((e) => {
        log.error("Failed to fetch models.dev", {
          error: e,
        })
      })
  }

  export const Data = lazy(async () => {
    const file = Bun.file(filepath)
    const result = await file.json().catch(() => {})
    if (result && (Flag.OPENSCIENCE_DISABLE_MODELS_FETCH || hasCurrentFrontier(result))) return result
    // @ts-ignore
    const snapshot = await import("./models-snapshot")
      .then((m) => m.snapshot as Record<string, unknown>)
      .catch(() => undefined)
    if (snapshot && (Flag.OPENSCIENCE_DISABLE_MODELS_FETCH || hasCurrentFrontier(snapshot as Record<string, any>)))
      return snapshot
    if (Flag.OPENSCIENCE_DISABLE_MODELS_FETCH) return {}
    const live = await fetchLive()
    if (live) {
      await Bun.write(file, JSON.stringify(live))
      return live
    }
    return result ?? snapshot ?? {}
  })

  export async function get() {
    const result = await Data()
    return result as Record<string, Provider>
  }

  /** Whether the on-disk catalog was refreshed within the last day. */
  export async function fresh() {
    const stat = await Bun.file(filepath)
      .stat()
      .catch(() => undefined)
    return !!stat && Date.now() - stat.mtime.getTime() < 24 * 60 * 60 * 1000
  }

  export async function refresh() {
    const file = Bun.file(filepath)
    const result = await fetchLive()
    if (!result) return
    const serialized = JSON.stringify(result)
    const cached = await file.text().catch(() => undefined)
    await Bun.write(file, serialized)
    // Only a changed catalog is worth rebuilding provider state for. A
    // byte-identical refresh would otherwise discard the memoized state (and
    // resend the whole catalog) right as the workspace is loading it.
    if (cached === serialized) return
    ModelsDev.Data.reset()
    // Drop the memoized provider state so a long-running session picks up the
    // refreshed catalog (new/renamed/removed models) instead of serving the
    // snapshot captured at first build. Dynamic import avoids a static cycle
    // (provider.ts imports ModelsDev). Best-effort.
    try {
      const { Provider } = await import("./provider")
      Provider.invalidate()
    } catch {}
  }
}

if (!Flag.OPENSCIENCE_DISABLE_MODELS_FETCH) {
  // A cache younger than a day is served as-is at boot so startup never races
  // a live fetch; the hourly interval keeps a long-running server current.
  ModelsDev.fresh().then((fresh) => (fresh ? undefined : ModelsDev.refresh()))
  setInterval(
    async () => {
      await ModelsDev.refresh()
    },
    60 * 1000 * 60,
  ).unref()
}
