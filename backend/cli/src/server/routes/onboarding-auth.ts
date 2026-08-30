import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Auth } from "../../auth"

export type OnboardingAuthDependencies = {
  saveCredential(providerID: string, auth: Auth.Info): Promise<void>
  invalidate(): void
  serialize<T>(action: () => Promise<T>): Promise<T>
}

function reason(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Save one local provider credential under the shared credential lease. */
export async function configureOnboardingProviderKey(
  providerID: string,
  auth: Auth.Info,
  dependencies: OnboardingAuthDependencies,
) {
  await dependencies.serialize(async () => {
    await dependencies.saveCredential(providerID, auth)
    dependencies.invalidate()
  })
}

const Result = z.object({ configured: z.literal(true) })

export function OnboardingAuthRoutes(dependencies: OnboardingAuthDependencies) {
  return new Hono().put(
    "/:providerID/onboarding",
    describeRoute({
      summary: "Configure an onboarding provider credential",
      description: "Save one local provider key.",
      operationId: "auth.onboarding",
      responses: {
        200: {
          description: "Provider credential configured",
          content: { "application/json": { schema: resolver(Result) } },
        },
        500: {
          description: "Configuration failed",
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
