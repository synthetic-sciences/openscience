import { HTTPException } from "hono/http-exception"
import { bodyLimit } from "hono/body-limit"
import { BillingImport } from "@/session/billing-import"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Decimal } from "decimal.js"
import { OpenScience } from "@/openscience"
import { localUsage } from "@/session/usage"
import { usageCost, usageCostLabels, usageDate, usageRange, usageModels } from "@synsci/util/usage"
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
  costs: z
    .array(
      z.object({
        source: z.enum(
          Object.keys(usageCostLabels) as [keyof typeof usageCostLabels, ...(keyof typeof usageCostLabels)[]],
        ),
        amountUSD: z.string().nullable(),
        known: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
      }),
    )
    .optional(),
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
  app.get(
    "/imports",
    describeRoute({
      summary: "List local provider billing imports",
      operationId: "settings.usage.imports",
      responses: {
        200: {
          description: "Billing imports",
          content: { "application/json": { schema: resolver(BillingImport.Batch.array()) } },
        },
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store")
      return c.json(await BillingImport.list())
    },
  )
  app.post(
    "/imports",
    bodyLimit({ maxSize: 2 * 1024 * 1024 }),
    describeRoute({
      summary: "Import provider billing evidence locally",
      operationId: "settings.usage.importBilling",
      responses: {
        200: {
          description: "Imported billing evidence",
          content: { "application/json": { schema: resolver(BillingImport.Batch) } },
        },
      },
    }),
    validator("json", BillingImport.Document),
    async (c) => {
      const result = await BillingImport.add(c.req.valid("json")).catch((error) => {
        if (error instanceof BillingImport.Conflict) throw new HTTPException(409, { message: error.message })
        throw error
      })
      c.header("Cache-Control", "no-store")
      return c.json(result)
    },
  )
  app.delete(
    "/imports/:id",
    describeRoute({
      summary: "Remove a local billing import",
      operationId: "settings.usage.removeImport",
      responses: {
        200: { description: "Removed", content: { "application/json": { schema: resolver(z.boolean()) } } },
      },
    }),
    validator("param", z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) })),
    async (c) => {
      await BillingImport.remove(c.req.valid("param").id)
      return c.json(true)
    },
  )
  app.get(
    "/billing",
    describeRoute({
      summary: "List and reconcile imported billing evidence",
      operationId: "settings.usage.billing",
      responses: {
        200: {
          description: "Billing records",
          content: { "application/json": { schema: resolver(BillingImport.Record.array()) } },
        },
      },
    }),
    validator("query", Query),
    async (c) => {
      const range = c.req.valid("query")
      c.header("Cache-Control", "no-store")
      return c.json(await BillingImport.records(Date.parse(range.start), Date.parse(range.end) + 86_400_000))
    },
  )
  for (const source of ["local", "managed"] as const) {
    app.get(
      `/${source}`,
      describeRoute({
        summary: `Get ${source} usage by day and model`,
        operationId: `settings.usage.${source}`,
        responses: {
          200: { description: "Usage", content: { "application/json": { schema: resolver(Result) } } },
          503: {
            description: "Account read deadline expired",
            content: { "text/plain": { schema: resolver(z.string()) } },
          },
        },
      }),
      validator("query", Query),
      async (c) => {
        const range = c.req.valid("query")
        const start = Date.parse(range.start)
        const end = Date.parse(range.end) + 86_400_000
        c.header("Cache-Control", "no-store")
        if (source === "local") return c.json({ connected: true, rows: await localUsage(start, end) })
        const deadline = OpenScience.accountDeadline(c.req.raw.signal)
        const result = await OpenScience.getUsage(
          new Date(start).toISOString(),
          new Date(end).toISOString(),
          deadline,
        ).catch((error) => {
          if (!deadline.aborted || deadline.reason?.name !== "TimeoutError") throw error
          throw new HTTPException(503, { message: deadline.reason.message })
        })
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
            costs: [usageCost("wallet_receipt", new Decimal(row.cost_cents).div(100).toFixed())],
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
