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
  managed_unlocked: z.boolean(),
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
      "/session",
      describeRoute({
        summary: "Get local session status",
        description:
          "Check whether this OpenScience server has a local Synthetic Sciences session without a network request.",
        operationId: "account.session",
        responses: {
          200: {
            description: "Local session status",
            content: {
              "application/json": {
                schema: resolver(z.object({ session: z.boolean() })),
              },
            },
          },
        },
      }),
      async (c) => c.json({ session: await OpenScience.isAuthenticated() }),
    )
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
                    balance_usd: z.number().nullable(),
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
        const [user, credits, billing] = session
          ? await Promise.all([OpenScience.getProfile(), OpenScience.getCredits(), OpenScience.getBillingMode()])
          : [null, null, null]
        return c.json({
          session: !!session,
          user: user ?? (session?.user_id ? { user_id: session.user_id } : undefined),
          balance_usd: credits?.balanceUsd ?? null,
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
            content: { "application/json": { schema: resolver(z.object({ balance_usd: z.number().nullable() })) } },
          },
        },
      }),
      async (c) => c.json({ balance_usd: (await OpenScience.getCredits())?.balanceUsd ?? null }),
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
      "/login-key",
      describeRoute({
        summary: "Sign in with a Synthetic Sciences API key",
        operationId: "account.loginKey",
        responses: {
          200: {
            description: "Login result",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean(), error: z.string().optional() })),
              },
            },
          },
        },
      }),
      validator("json", z.object({ key: z.string() })),
      async (c) => {
        // Browser-side Atlas sign-in: validate + persist the pasted `thk_` key,
        // then resync managed services and rebuild the provider cache so managed
        // models light up without a terminal. A rejected key is a 200
        // { ok:false } (an expected user error, not a server fault).
        try {
          await OpenScience.loginWithKey(c.req.valid("json").key.trim())
          await OpenScience.syncServices().catch(() => {})
          Provider.invalidate()
          return c.json({ ok: true })
        } catch (err) {
          return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
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
        // Best-effort server-side revocation of this device's key while the
        // session can still authenticate the call; local cleanup follows
        // regardless of the outcome.
        await OpenScience.revokeCurrentDevice()
        await OpenScience.clearSession()
        Provider.invalidate()
        await Instance.disposeAll()
        emitDisposed()
        return c.json(true)
      },
    ),
)
