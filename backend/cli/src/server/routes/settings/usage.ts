import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { OpenScience } from "@/openscience"
import { localUsage } from "@/session/usage"
import { usageDate, usageRange, usageModels } from "@synsci/util/usage"
import { lazy } from "@synsci/util/lazy"

const DateValue = z.string().refine(usageDate, "Use a valid YYYY-MM-DD date")
const Query = z
  .object({ start: DateValue.optional(), end: DateValue.optional() })
  .transform((value) => ({ ...usageRange(), ...value }))
  .refine(
    (value) => value.start <= value.end && (Date.parse(value.end) - Date.parse(value.start)) / 86_400_000 < 366,
    "Choose a date range of up to 366 days",
  )
const Row = z.object({
  date: z.string(),
  provider: z.string(),
  model: z.string(),
  route: z.enum(["managed", "byok", "local", "chatgpt", "subscription", "custom", "unknown"]),
  calls: z.number(),
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  tokens: z.number(),
  cost: z.number(),
})
const Result = z.object({ connected: z.boolean(), rows: z.array(Row) })
const Remote = z.object({
  daily_breakdown: z.array(
    z.object({
      date: z.string(),
      provider: z.string(),
      model: z.string(),
      route: z.string(),
      calls: z.number(),
      input_tokens: z.number(),
      output_tokens: z.number(),
      reasoning_tokens: z.number().optional(),
      cache_read_tokens: z.number().optional(),
      cache_creation_tokens: z.number().optional(),
      cost_cents: z.number(),
    }),
  ),
})

export const UsageSettingsRoutes = lazy(() => {
  const app = new Hono()
  for (const source of ["local", "managed"] as const) {
    app.get(
      `/${source}`,
      describeRoute({
        summary: `Get ${source} usage by day and model`,
        operationId: `settings.usage.${source}`,
        responses: { 200: { description: "Usage", content: { "application/json": { schema: resolver(Result) } } } },
      }),
      validator("query", Query),
      async (c) => {
        const range = c.req.valid("query")
        const start = Date.parse(range.start)
        const end = Date.parse(range.end) + 86_400_000
        if (source === "local") return c.json({ connected: true, rows: await localUsage(start, end) })
        const result = await OpenScience.getUsage(
          new Date(start).toISOString(),
          new Date(end).toISOString(),
          OpenScience.accountDeadline(c.req.raw.signal),
        )
        if (result === null) return c.json({ connected: false, rows: [] })
        const rows = Remote.parse(result)
          .daily_breakdown.filter((row) => row.route === "managed" && row.date >= range.start && row.date <= range.end)
          .map((row) => ({
            date: row.date,
            provider: row.provider,
            model: row.model,
            route: "managed" as const,
            calls: row.calls,
            input: row.input_tokens,
            output: row.output_tokens,
            reasoning: row.reasoning_tokens ?? 0,
            cacheRead: row.cache_read_tokens ?? 0,
            cacheWrite: row.cache_creation_tokens ?? 0,
            tokens: row.input_tokens + row.output_tokens,
            cost: row.cost_cents / 100,
          }))
        return c.json({
          connected: true,
          rows: [...new Set(rows.map((row) => row.date))].flatMap((date) =>
            usageModels(rows.filter((row) => row.date === date)),
          ),
        })
      },
    )
  }
  return app
})
