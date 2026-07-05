import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { Session } from "../../../session"
import { lazy } from "../../../util/lazy"
import { Log } from "../../../util/log"

const log = Log.create({ service: "settings-usage" })

const Tokens = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cache_read: z.number(),
  cache_write: z.number(),
})

const Summary = z.object({
  sessions: z.number(),
  total: z.object({ cost: z.number(), tokens: Tokens }),
  latest: z.object({ id: z.string(), title: z.string(), cost: z.number(), tokens: Tokens }).nullable(),
  weekly: z.array(z.object({ date: z.string(), cost: z.number(), tokens: z.number() })),
  by_model: z.array(
    z.object({ key: z.string(), provider: z.string(), model: z.string(), cost: z.number(), tokens: z.number() }),
  ),
})

const emptyTokens = () => ({ input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 })

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// Real, locally-computed usage: sums assistant-message cost + token counts across
// every session in the current project, grouped by model and by day. This is the
// "where tokens go" ground truth — no estimates, just what the sessions recorded.
export const SettingsUsageRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "Local usage summary",
      operationId: "settings.usage.get",
      responses: {
        200: {
          description: "Usage summary",
          content: { "application/json": { schema: resolver(Summary) } },
        },
      },
    }),
    async (c) => {
      const total = { cost: 0, tokens: emptyTokens() }
      const byModel = new Map<string, { provider: string; model: string; cost: number; tokens: number }>()

      // Last 7 calendar days (oldest → newest), pre-seeded so gaps render as zero.
      const now = Date.now()
      const day = 24 * 60 * 60 * 1000
      const weekly = new Map<string, { cost: number; tokens: number }>()
      for (let i = 6; i >= 0; i--) weekly.set(dayKey(now - i * day), { cost: 0, tokens: 0 })
      const weekStart = now - 7 * day

      let latest: z.infer<typeof Summary>["latest"] = null
      let latestUpdated = -1
      let sessions = 0

      try {
        for await (const session of Session.list()) {
          sessions++
          const acc = { cost: 0, tokens: emptyTokens() }
          const msgs = await Session.messages({ sessionID: session.id }).catch(() => [])
          for (const { info } of msgs) {
            if (info.role !== "assistant") continue
            const t = info.tokens
            const tokenCount = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
            total.cost += info.cost
            total.tokens.input += t.input
            total.tokens.output += t.output
            total.tokens.reasoning += t.reasoning
            total.tokens.cache_read += t.cache.read
            total.tokens.cache_write += t.cache.write
            acc.cost += info.cost
            acc.tokens.input += t.input
            acc.tokens.output += t.output
            acc.tokens.reasoning += t.reasoning
            acc.tokens.cache_read += t.cache.read
            acc.tokens.cache_write += t.cache.write

            const key = `${info.providerID}/${info.modelID}`
            const row = byModel.get(key) ?? { provider: info.providerID, model: info.modelID, cost: 0, tokens: 0 }
            row.cost += info.cost
            row.tokens += tokenCount
            byModel.set(key, row)

            if (info.time.created >= weekStart) {
              const bucket = weekly.get(dayKey(info.time.created))
              if (bucket) {
                bucket.cost += info.cost
                bucket.tokens += tokenCount
              }
            }
          }

          const updated = session.time.updated ?? session.time.created
          if (updated > latestUpdated) {
            latestUpdated = updated
            latest = { id: session.id, title: session.title || "Untitled", cost: acc.cost, tokens: acc.tokens }
          }
        }
      } catch (e) {
        log.warn("usage aggregation failed", { error: e instanceof Error ? e.message : String(e) })
      }

      return c.json({
        sessions,
        total,
        latest,
        weekly: [...weekly.entries()].map(([date, v]) => ({ date, cost: v.cost, tokens: v.tokens })),
        by_model: [...byModel.entries()]
          .map(([key, v]) => ({ key, ...v }))
          .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
      })
    },
  ),
)
