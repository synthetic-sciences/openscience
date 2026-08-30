import path from "path"
import { Global } from "../global"
import { JsonStore } from "../util/jsonstore"
import z from "zod"
import { CredentialLifecycle } from "../credentials/lifecycle"
import { isAtlasManagedKey } from "../credentials/managed-key"

export const OAUTH_DUMMY_KEY = "synsc-oauth-dummy-key"

export namespace Auth {
  /** Detect retired product credentials so they cannot escape into provider calls.
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
    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value)
        if (!parsed.success) return acc
        if (parsed.data.type === "api" && isAtlasApiKey(parsed.data.key)) return acc
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )
  }

  export async function set(key: string, info: Info) {
    if (info.type === "api" && isAtlasApiKey(info.key)) {
      throw new Error("Managed workspace credentials are not supported. Connect a provider account you control.")
    }
    await CredentialLifecycle.mutate(`provider-auth.set:${key}`, () =>
      JsonStore.update(filepath, (data) => ({ ...data, [key]: info })),
    )
  }

  export async function remove(key: string) {
    await CredentialLifecycle.mutate(`provider-auth.remove:${key}`, () =>
      JsonStore.update(filepath, (data) => {
        delete data[key]
      }),
    )
  }
}
