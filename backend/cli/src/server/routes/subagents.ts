import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Session } from "@/session"
import { SubagentContinuation } from "@/session/subagent-continuation"
import { SubagentBudget } from "@/session/subagent-budget"
import { Identifier } from "@/id/id"
import { lazy } from "@synsci/util/lazy"
import { errors } from "../error"

const params = z.object({ sessionID: Identifier.schema("session") })
const increase = z.discriminatedUnion("unit", [
  z.object({
    unit: z.literal("usd"),
    amount: z.number().positive().max(1000000),
    revision: z.number().int().nonnegative(),
    key: z.string().uuid(),
  }),
  z.object({
    unit: z.literal("tokens"),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    revision: z.number().int().nonnegative(),
    key: z.string().uuid(),
  }),
])

export const SubagentRoutes = lazy(() =>
  new Hono()
    .get(
      "/budget",
      describeRoute({
        summary: "Read scoped subagent allowances",
        operationId: "session.subagentBudget",
        responses: {
          200: {
            description: "Shared subagent pools and assignments; main-agent inference is excluded",
            content: { "application/json": { schema: resolver(SubagentBudget.Snapshot.nullable()) } },
          },
          ...errors(404),
        },
      }),
      validator("param", params),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        await Session.assertDirectory(sessionID)
        return c.json(await SubagentBudget.snapshot(sessionID))
      },
    )
    .post(
      "/:childID/continue",
      describeRoute({
        summary: "Continue a stopped subagent",
        operationId: "session.continueSubagent",
        responses: {
          202: {
            description: "Accepted a new Task call for the same child",
            content: {
              "application/json": { schema: resolver(z.object({ sessionID: z.string(), callID: z.string() })) },
            },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", params.extend({ childID: Identifier.schema("session") })),
      validator("json", z.object({ key: z.string().uuid() })),
      async (c) => {
        const input = c.req.valid("param")
        await Session.assertDirectory(input.sessionID)
        const result = await SubagentContinuation.start(input.sessionID, input.childID, c.req.valid("json").key).catch(
          (error) => {
            if (error instanceof Error) throw new HTTPException(409, { message: error.message })
            throw error
          },
        )
        return c.json(result, 202)
      },
    )
    .post(
      "/budget/increase",
      describeRoute({
        summary: "Approve a subagent allowance increase",
        operationId: "session.increaseSubagentBudget",
        responses: {
          200: {
            description: "User-approved pool total; existing usage is preserved",
            content: { "application/json": { schema: resolver(SubagentBudget.Snapshot) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", params),
      validator("json", increase),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        await Session.assertDirectory(sessionID)
        const pool = await SubagentBudget.snapshot(sessionID)
        if (!pool) throw new HTTPException(404, { message: "Subagent allowance not found" })
        const input = c.req.valid("json")
        await SubagentBudget.increase(pool.rootSessionID, {
          ...input,
          amount: input.unit === "usd" ? SubagentBudget.dollars(input.amount) : input.amount,
        }).catch((error) => {
          if (error instanceof Error && /revision|Approval key conflict|Bounded runs are off/.test(error.message))
            throw new HTTPException(409, { message: error.message })
          throw error
        })
        return c.json((await SubagentBudget.snapshot(pool.rootSessionID))!)
      },
    ),
)
