import path from "path"
import { Global } from "../global"
import { JsonStore } from "../util/jsonstore"
import z from "zod"
import { CredentialLifecycle } from "../credentials/lifecycle"
import { isAtlasManagedKey } from "../credentials/managed-key"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { WorkspaceCredentials } from "../openscience/workspace-credentials"

export const OAUTH_DUMMY_KEY = "synsc-oauth-dummy-key"
const log = Log.create({ service: "auth" })

export namespace Auth {
  /** Detect Ace account credentials so they cannot escape into direct provider calls.
   *  Canonical home: `auth/index.ts` is a near-leaf module (only
   *  path/global/jsonstore/zod besides this file's own Config import), so
   *  `provider.ts` - which already imports Auth - depends on this instead of
   *  Auth duplicating or importing from Provider (a much heavier module: all
   *  the AI SDK loaders, plus Provider already imports Auth AND Config, so
   *  an Auth -> Provider edge would close two cycles through it at once). */
  export function isAtlasApiKey(key: unknown): key is string {
    return isAtlasManagedKey(key)
  }

  export const Oauth = z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
      accountId: z.string().optional(),
      enterpriseUrl: z.string().optional(),
    })
    .meta({ ref: "OAuth" })

  export const Api = z
    .object({
      type: z.literal("api"),
      key: z.string(),
    })
    .meta({ ref: "ApiAuth" })

  export const WellKnown = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
    })
    .meta({ ref: "WellKnownAuth" })

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown]).meta({ ref: "Auth" })
  export type Info = z.infer<typeof Info>

  const filepath = path.join(Global.Path.data, "auth.json")

  export async function get(providerID: string) {
    const auth = await all()
    return auth[providerID]
  }

  export async function all(): Promise<Record<string, Info>> {
    const data = await JsonStore.read(filepath)
    // Synced model keys stay in the encrypted overlay, never process.env.
    // These reviewed provider env names therefore belong to the local user,
    // not the separately allowlisted cloud service env. Compare provenance,
    // not secret values: even an equal local key remains locally owned.
    const synced = Object.fromEntries(
      Object.entries((await WorkspaceCredentials.read())?.auth ?? {}).filter(
        ([id]) =>
          !WorkspaceCredentials.providerEnv(id).some((name) => {
            const key = process.env[name]
            return key && !isAtlasApiKey(key)
          }),
      ),
    )
    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value)
        if (!parsed.success) return acc
        if (parsed.data.type === "api" && isAtlasApiKey(parsed.data.key)) return acc
        acc[key] = parsed.data
        return acc
      },
      synced as Record<string, Info>,
    )
  }

  export async function set(key: string, info: Info) {
    if (info.type === "api" && isAtlasApiKey(info.key)) {
      throw new Error(
        "Ace workspace credentials belong to OpenScience sign-in, not provider keys. Sign in to Ace or add a provider key you control.",
      )
    }
    const selectsByok = key === "openrouter" && info.type === "api" && !isAtlasApiKey(info.key)
    await CredentialLifecycle.mutate(`provider-auth.set:${key}`, async () => {
      if (!selectsByok) {
        await JsonStore.update(filepath, (data) => ({ ...data, [key]: info }))
        return
      }
      const previous = await JsonStore.read(filepath)
      const previousMode = (await Config.getGlobal()).billing?.llm ?? null
      try {
        await JsonStore.update(filepath, (data) => ({ ...data, [key]: info }))
        const config = await Config.getGlobal()
        if (config.billing?.llm === "managed") {
          await Config.updateGlobal({ billing: { llm: "byok" } }, { preserveInstances: true })
        }
      } catch (cause) {
        let credentialRollback: unknown
        let modeRollback: unknown
        try {
          await JsonStore.update(filepath, () => previous)
        } catch (error) {
          credentialRollback = error
        }
        try {
          await Config.updateGlobal({ billing: { llm: previousMode } }, { preserveInstances: true })
        } catch (error) {
          modeRollback = error
        }
        log.warn("OpenRouter BYOK handoff failed; compensation attempted", {
          error: cause instanceof Error ? cause.message : String(cause),
          credentialRollback: credentialRollback instanceof Error ? credentialRollback.message : credentialRollback,
          modeRollback: modeRollback instanceof Error ? modeRollback.message : modeRollback,
        })
        if (credentialRollback || modeRollback) {
          throw new AggregateError(
            [cause, ...(credentialRollback ? [credentialRollback] : []), ...(modeRollback ? [modeRollback] : [])],
            "OpenRouter setup failed and could not be fully restored. Review Customize → Models before retrying.",
          )
        }
        throw cause
      }
    })
  }

  export async function remove(key: string) {
    await CredentialLifecycle.mutate(`provider-auth.remove:${key}`, async () => {
      const local = await JsonStore.read(filepath)
      if (!local[key] && (await WorkspaceCredentials.read())?.auth[key]) {
        throw new Error("Manage this synced provider key in your workspace on app.syntheticsciences.ai.")
      }
      await JsonStore.update(filepath, (data) => {
        delete data[key]
      })
    })
  }
}
