import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { FundingContextError, OpenScience } from "@/openscience"
import { Provider } from "@/provider/provider"
import { Instance } from "@/project/instance"
import { GlobalBus } from "@/bus/global"
import { lazy } from "@/util/lazy"
import { GlobalDisposedEvent } from "./global"
import { openUrl } from "@/util/open-url"
import { isWorkspaceKey } from "@/credentials/managed-key"

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
  ace_enabled: z.boolean().optional(),
})

const FundingOrganization = z.object({
  organization_id: z.string(),
  name: z.string(),
  slug: z.string(),
  is_personal: z.boolean(),
  status: z.string(),
  role: z.string(),
  membership_status: z.string(),
  funding_available: z.boolean(),
  effective_permissions: z.array(z.string()),
})

const FundingContext = z.object({
  type: z.enum(["personal", "organization"]),
  organization_id: z.string().optional(),
  available: z.boolean(),
  locked: z.boolean(),
  organizations: z.array(FundingOrganization),
})

const Credential = z.object({ type: z.enum(["personal", "organization"]), legacy: z.boolean() })

function credential(session: { api_key: string; organization_id?: string } | null) {
  if (!session) return null
  return {
    type:
      session.organization_id || isWorkspaceKey(session.api_key) ? ("organization" as const) : ("personal" as const),
    legacy: !isWorkspaceKey(session.api_key),
  }
}

function emitDisposed() {
  GlobalBus.emit("event", { directory: "global", payload: { type: GlobalDisposedEvent.type, properties: {} } })
}

const LoginResult = z.object({ ok: z.boolean(), error: z.string().optional() })

export const AccountRoutes = lazy(() =>
  new Hono()
    .get(
      "/session",
      describeRoute({
        summary: "Get local account session status",
        operationId: "account.session",
        responses: {
          200: {
            description: "Session status",
            content: { "application/json": { schema: resolver(z.object({ session: z.boolean() })) } },
          },
        },
      }),
      async (c) => c.json({ session: await OpenScience.isAuthenticated() }),
    )
    .get(
      "/",
      describeRoute({
        summary: "Get Ace account and funding summary",
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
                    funding_context: FundingContext,
                    credential: Credential.nullable(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const state = await OpenScience.getReconciledFundingState().catch(() => null)
        if (!state) {
          const session = await OpenScience.getSession()
          return c.json({
            session: !!session,
            balance_usd: null,
            billing_mode: null,
            credential: credential(session),
            funding_context: { type: "personal" as const, available: !session, locked: false, organizations: [] },
          })
        }
        const creditsRequest = OpenScience.getCredits(state.snapshot)
        const [user, credits, billing] = await Promise.all([
          OpenScience.getProfile(state.snapshot),
          creditsRequest,
          OpenScience.getBillingMode(state.snapshot, creditsRequest),
        ])
        return c.json({
          session: true,
          user: user ?? (state.snapshot.user_id ? { user_id: state.snapshot.user_id } : undefined),
          balance_usd: credits?.balanceUsd ?? null,
          billing_mode: billing,
          funding_context: state.context,
          credential: credential(state.snapshot),
        })
      },
    )
    .get(
      "/funding-context",
      describeRoute({
        summary: "Get Ace funding workspace",
        operationId: "account.fundingContext.get",
        responses: {
          200: {
            description: "Funding context",
            content: { "application/json": { schema: resolver(FundingContext) } },
          },
        },
      }),
      async (c) => c.json(await OpenScience.getFundingContext()),
    )
    .put(
      "/funding-context",
      describeRoute({
        summary: "Choose Ace funding workspace",
        operationId: "account.fundingContext.set",
        responses: {
          200: {
            description: "Funding context",
            content: { "application/json": { schema: resolver(FundingContext) } },
          },
          400: {
            description: "Invalid workspace",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("json", z.object({ organization_id: z.string().min(1).max(128).nullable() })),
      async (c) => {
        try {
          return c.json(await OpenScience.setFundingContext(c.req.valid("json").organization_id))
        } catch (error) {
          if (!(error instanceof FundingContextError)) throw error
          return c.json({ error: error.message }, 400)
        }
      },
    )
    .get(
      "/balance",
      describeRoute({
        summary: "Get purchased wallet balance",
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
        summary: "List account devices",
        operationId: "account.devices",
        responses: {
          200: { description: "Devices", content: { "application/json": { schema: resolver(Device.array()) } } },
        },
      }),
      async (c) => c.json((await OpenScience.listDevices()) ?? []),
    )
    .delete(
      "/devices/:keyID",
      describeRoute({
        summary: "Revoke account device",
        operationId: "account.device.revoke",
        responses: {
          200: { description: "Revoked", content: { "application/json": { schema: resolver(z.boolean()) } } },
        },
      }),
      validator("param", z.object({ keyID: z.string() })),
      async (c) => c.json(await OpenScience.revokeDevice(c.req.valid("param").keyID)),
    )
    .get(
      "/billing-mode",
      describeRoute({
        summary: "Get model billing mode",
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
        summary: "Set model billing mode",
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
      "/login-browser",
      describeRoute({
        summary: "Sign in through the system browser",
        operationId: "account.loginBrowser",
        responses: {
          200: { description: "Login result", content: { "application/json": { schema: resolver(LoginResult) } } },
        },
      }),
      async (c) => {
        try {
          await OpenScience.browserLogin({ onApprovalUrl: openUrl })
          Provider.invalidate()
          emitDisposed()
          return c.json({ ok: true })
        } catch (error) {
          return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    )
    .post(
      "/login-key",
      describeRoute({
        summary: "Sign in with an OpenScience workspace key",
        operationId: "account.loginKey",
        responses: {
          200: { description: "Login result", content: { "application/json": { schema: resolver(LoginResult) } } },
        },
      }),
      validator("json", z.object({ key: z.string() })),
      async (c) => {
        try {
          await OpenScience.loginWithKey(c.req.valid("json").key)
          Provider.invalidate()
          emitDisposed()
          return c.json({ ok: true })
        } catch (error) {
          return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    )
    .post(
      "/logout",
      describeRoute({
        summary: "Logout Ace account",
        operationId: "account.logout",
        responses: {
          200: { description: "Logged out", content: { "application/json": { schema: resolver(z.boolean()) } } },
        },
      }),
      async (c) => {
        await OpenScience.revokeCurrentDevice()
        await OpenScience.clearSession()
        Provider.invalidate()
        await Instance.disposeAll()
        emitDisposed()
        return c.json(true)
      },
    ),
)
