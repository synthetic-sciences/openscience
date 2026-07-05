import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { OpenScience } from "@/openscience"
import { Provider } from "@/provider/provider"
import { Instance } from "@/project/instance"
import { GlobalBus } from "@/bus/global"
import { lazy } from "@/util/lazy"
import { GlobalDisposedEvent } from "./global"

const Device = z.object({
  key_id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  expires_at: z.string().nullable(),
})

const BillingMode = z.object({
  mode: z.enum(["byok", "managed"]),
  balance_cents: z.number(),
  balance_usd: z.number(),
  managed_supported: z.boolean(),
})

function emitDisposed() {
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: GlobalDisposedEvent.type,
      properties: {},
    },
  })
}

export const AccountRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get account",
        description: "Get synced OpenScience account and billing summary.",
        operationId: "account.get",
        responses: {
          200: {
            description: "Account summary",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    session: z.boolean(),
                    user: z.unknown().optional(),
                    balance_usd: z.number(),
                    billing_mode: BillingMode.nullable(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const session = await OpenScience.getSession()
        const sync = session ? await OpenScience.syncServices() : null
        // -1 is the wire encoding for "unknown" (schema: number)
        const balance = (session ? await OpenScience.getBalance() : null) ?? -1
        const billing = session ? await OpenScience.getBillingMode() : null
        return c.json({
          session: !!session,
          user: sync?.user,
          balance_usd: balance,
          billing_mode: billing,
        })
      },
    )
    .get(
      "/balance",
      describeRoute({
        summary: "Get balance",
        operationId: "account.balance",
        responses: {
          200: {
            description: "Balance",
            content: { "application/json": { schema: resolver(z.object({ balance_usd: z.number() })) } },
          },
        },
      }),
      async (c) => c.json({ balance_usd: (await OpenScience.getBalance()) ?? -1 }),
    )
    .get(
      "/devices",
      describeRoute({
        summary: "List devices",
        operationId: "account.devices",
        responses: {
          200: {
            description: "Devices",
            content: { "application/json": { schema: resolver(Device.array()) } },
          },
        },
      }),
      async (c) => c.json((await OpenScience.listDevices()) ?? []),
    )
    .delete(
      "/devices/:keyID",
      describeRoute({
        summary: "Revoke device",
        operationId: "account.device.revoke",
        responses: {
          200: {
            description: "Device revoked",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
        },
      }),
      validator("param", z.object({ keyID: z.string() })),
      async (c) => c.json(await OpenScience.revokeDevice(c.req.valid("param").keyID)),
    )
    .get(
      "/billing-mode",
      describeRoute({
        summary: "Get billing mode",
        operationId: "account.billingMode.get",
        responses: {
          200: {
            description: "Billing mode",
            content: { "application/json": { schema: resolver(BillingMode.nullable()) } },
          },
        },
      }),
      async (c) => c.json(await OpenScience.getBillingMode()),
    )
    .post(
      "/billing-mode",
      describeRoute({
        summary: "Set billing mode",
        operationId: "account.billingMode.set",
        responses: {
          200: {
            description: "Billing mode",
            content: { "application/json": { schema: resolver(BillingMode.nullable()) } },
          },
        },
      }),
      validator("json", z.object({ mode: z.enum(["byok", "managed"]) })),
      async (c) => c.json(await OpenScience.setBillingMode(c.req.valid("json").mode)),
    )
    .post(
      "/logout",
      describeRoute({
        summary: "Logout account",
        operationId: "account.logout",
        responses: {
          200: {
            description: "Logged out",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
        },
      }),
      async (c) => {
        await OpenScience.clearSession()
        Provider.invalidate()
        await Instance.disposeAll()
        emitDisposed()
        return c.json(true)
      },
    ),
)
