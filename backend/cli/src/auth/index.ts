import path from "path"
import { Global } from "../global"
import { JsonStore } from "../util/jsonstore"
import z from "zod"
import { Config } from "../config/config"

export const OAUTH_DUMMY_KEY = "synsc-oauth-dummy-key"

// A managed Atlas wallet credential (`thk_*`), as opposed to a user-owned
// (BYOK) key. Duplicated from Provider.isAtlasApiKey (provider/provider.ts)
// rather than imported: provider.ts already imports both Auth and Config, so
// Auth importing Provider would close a second, larger cycle through a much
// heavier module (all the AI SDK loaders). Config -> Auth -> Config is a
// pre-existing two-file cycle (config.ts already imports Auth); Auth ->
// Provider -> Auth (plus Provider -> Config -> Auth) is not worth opening
// just to save one line.
function isAtlasApiKey(key: unknown): key is string {
  return typeof key === "string" && key.startsWith("thk_")
}

export namespace Auth {
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
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )
  }

  export async function set(key: string, info: Info) {
    await JsonStore.update(filepath, (data) => ({ ...data, [key]: info }))

    // Adding a real (non-Atlas) OpenRouter key while Managed spend is on
    // means the user is bringing their own key - flip the toggle to Own
    // keys so the added key actually wins routing immediately, instead of
    // sitting unused behind the managed route until the user finds the
    // Settings toggle. This is the ONE choke point both `openscience auth
    // login` (CLI - calls Auth.set directly, see cli/cmd/auth.ts) and the
    // Settings UI (PUT /auth/:providerID -> Auth.set) go through, so it
    // belongs here rather than in the HTTP route. A `thk_` Atlas token is
    // never "own key" material and must not flip the mode; other providers
    // and OAuth credentials are untouched.
    if (key === "openrouter" && info.type === "api" && !isAtlasApiKey(info.key)) {
      // Reads the GLOBAL config specifically (not the merged project+global
      // Config.get(), which requires an active Instance/project context that
      // most Auth.set callers - including every CLI auth command - don't
      // have). billing.llm can also be set at project scope; a project-level
      // override is invisible to this check, same asymmetry the byok guard
      // in provider.ts lives with when read outside a project context.
      const cfg = await Config.getGlobal()
      if (cfg.billing?.llm === "managed") {
        await Config.updateGlobal({ billing: { llm: "byok" } })
      }
    }
  }

  export async function remove(key: string) {
    await JsonStore.update(filepath, (data) => {
      delete data[key]
    })
  }
}
