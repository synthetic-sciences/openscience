import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Auth } from "../../auth"

type BillingMode = "managed" | "byok" | null

export type OnboardingAuthDependencies = {
  readCredential(providerID: string): Promise<Auth.Info | undefined>
  saveCredential(providerID: string, auth: Auth.Info): Promise<void>
  removeCredential(providerID: string): Promise<void>
  readBillingMode(): Promise<BillingMode>
  selectByok(): Promise<void>
  restoreBillingMode(mode: BillingMode): Promise<void>
  invalidate(): void
  serialize<T>(action: () => Promise<T>): Promise<T>
}

function reason(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Save one onboarding BYOK credential and select BYOK as one compensating
 * transaction. The previous secret never leaves the server. Holding the
 * credential lease across the snapshot, write, mode selection, and rollback
 * prevents a concurrent settings write from being overwritten by compensation.
 */
export async function configureOnboardingProviderKey(
  providerID: string,
  auth: Auth.Info,
  dependencies: OnboardingAuthDependencies,
) {
  await dependencies.serialize(async () => {
    const previousCredential = await dependencies.readCredential(providerID)
    const previousMode = await dependencies.readBillingMode()

    try {
      await dependencies.saveCredential(providerID, auth)
      await dependencies.selectByok()
    } catch (cause) {
      let credentialRollback: unknown
      let modeRollback: unknown

      try {
        if (previousCredential) await dependencies.saveCredential(providerID, previousCredential)
        else await dependencies.removeCredential(providerID)
      } catch (error) {
        credentialRollback = error
      }

      try {
        await dependencies.restoreBillingMode(previousMode)
      } catch (error) {
        modeRollback = error
      }

      dependencies.invalidate()

      if (credentialRollback) {
        throw new AggregateError(
          [cause, credentialRollback, ...(modeRollback ? [modeRollback] : [])],
          `Provider setup failed and the previous credential could not be restored (${reason(credentialRollback)}). Review Customize → Models before retrying.`,
        )
      }
      if (modeRollback) {
        throw new AggregateError(
          [cause, modeRollback],
          `Provider setup failed; the previous credential was restored, but model access could not be restored (${reason(modeRollback)}). Review Customize → Models before retrying.`,
        )
      }
      throw cause
    }

    dependencies.invalidate()
  })
}

const Result = z.object({ configured: z.literal(true) })

export function OnboardingAuthRoutes(dependencies: OnboardingAuthDependencies) {
  return new Hono().put(
    "/:providerID/onboarding",
    describeRoute({
      summary: "Configure an onboarding provider credential",
      description: "Atomically save one local provider key and select BYOK model access.",
      operationId: "auth.onboarding",
      responses: {
        200: {
          description: "Provider credential and BYOK mode configured",
          content: { "application/json": { schema: resolver(Result) } },
        },
        500: {
          description: "Configuration failed and compensation was attempted",
          content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
        },
      },
    }),
    validator("param", z.object({ providerID: z.string().min(1) })),
    validator("json", Auth.Api),
    async (c) => {
      try {
        await configureOnboardingProviderKey(c.req.valid("param").providerID, c.req.valid("json"), dependencies)
        return c.json({ configured: true as const })
      } catch (error) {
        return c.json({ error: reason(error) }, 500)
      }
    },
  )
}
