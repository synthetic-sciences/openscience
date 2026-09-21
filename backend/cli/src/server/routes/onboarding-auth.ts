import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Auth } from "../../auth"
import { KeyCheck } from "../../provider/key-check"

type BillingMode = "managed" | "byok" | null

export type OnboardingAuthDependencies = {
  readCredential(providerID: string): Promise<Auth.Info | undefined>
  saveCredential(providerID: string, auth: Auth.Info): Promise<void>
  removeCredential(providerID: string): Promise<void>
  /** Ask the provider whether the key works. Must not throw, log, or keep the key. */
  verifyKey(providerID: string, key: string): Promise<KeyCheck.Outcome>
  readBillingMode(): Promise<BillingMode>
  selectByok(): Promise<void>
  restoreBillingMode(mode: BillingMode): Promise<void>
  invalidate(): void
  serialize<T>(action: () => Promise<T>): Promise<T>
}

function reason(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Save a BYOK credential and select it as one compensating transaction. */
async function configureOnboardingProviderKey(
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
          `Provider setup failed; the credential was restored, but model access could not be restored (${reason(modeRollback)}). Review Customize → Models before retrying.`,
        )
      }
      throw cause
    }
    dependencies.invalidate()
  })
}

const Result = z.object({
  configured: z.literal(true),
  verified: z
    .boolean()
    .optional()
    .describe("true: the provider accepted the key; false: it could not be reached; absent: no check applies"),
})
const Failure = z.object({ error: z.string() })

export function OnboardingAuthRoutes(dependencies: OnboardingAuthDependencies) {
  return new Hono().put(
    "/:providerID/onboarding",
    describeRoute({
      summary: "Configure an onboarding provider credential",
      description:
        "Check the key with its provider, then atomically save it and select BYOK model access. A key the provider refuses is not saved; an unreachable provider does not block the save.",
      operationId: "auth.onboarding",
      responses: {
        200: {
          description: "Provider credential and BYOK mode configured",
          content: { "application/json": { schema: resolver(Result) } },
        },
        400: {
          description: "The provider refused the key; nothing was saved",
          content: { "application/json": { schema: resolver(Failure) } },
        },
        500: {
          description: "Configuration failed and compensation was attempted",
          content: { "application/json": { schema: resolver(Failure) } },
        },
      },
    }),
    validator("param", z.object({ providerID: z.string().min(1) })),
    validator("json", Auth.Api),
    async (c) => {
      const providerID = c.req.valid("param").providerID
      const auth = c.req.valid("json")
      // Outside the credential lock: a slow provider must not stall other credential writes.
      const outcome = await dependencies.verifyKey(providerID, auth.key)
      if (outcome === "rejected") return c.json({ error: KeyCheck.rejection(providerID) }, 400)
      try {
        await configureOnboardingProviderKey(providerID, auth, dependencies)
        return c.json({
          configured: true as const,
          ...(outcome === "skipped" ? {} : { verified: outcome === "accepted" }),
        })
      } catch (error) {
        return c.json({ error: reason(error) }, 500)
      }
    },
  )
}
