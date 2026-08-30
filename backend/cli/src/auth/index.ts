import path from "path"
import { Global } from "../global"
import { JsonStore } from "../util/jsonstore"
import z from "zod"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { CredentialLifecycle } from "../credentials/lifecycle"
import { isAtlasManagedKey } from "../credentials/managed-key"

export const OAUTH_DUMMY_KEY = "synsc-oauth-dummy-key"

const log = Log.create({ service: "auth" })

export namespace Auth {
  /** A managed Atlas wallet credential (`osk_*` or legacy `thk_*`), as opposed to a user-owned
   *  (BYOK) key. Canonical home: `auth/index.ts` is a near-leaf module (only
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
        acc[key] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )
  }

  export async function set(key: string, info: Info) {
    await CredentialLifecycle.mutate(`provider-auth.set:${key}`, () =>
      JsonStore.update(filepath, (data) => ({ ...data, [key]: info })),
    )

    // Adding a real (non-Atlas) OpenRouter key while Managed spend is on
    // means the user is bringing their own key - flip the toggle to Own
    // keys so the added key actually wins routing immediately, instead of
    // sitting unused behind the managed route until the user finds the
    // Settings toggle. This is the ONE choke point both `openscience auth
    // login` (CLI - calls Auth.set directly, see cli/cmd/auth.ts) and the
    // Settings UI (PUT /auth/:providerID -> Auth.set) go through, so it
    // belongs here rather than in the HTTP route. An Atlas workspace token is
    // never "own key" material and must not flip the mode; other providers
    // and OAuth credentials are untouched.
    if (key === "openrouter" && info.type === "api" && !isAtlasApiKey(info.key)) {
      try {
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
      } catch (e) {
        // A malformed global config (a hand-edited openscience.jsonc with a
        // trailing comma, say) makes Config.getGlobal()/updateGlobal() throw.
        // That must not take down Auth.set - the credential above is already
        // persisted, and Auth.set has 11 call sites, at least one with no
        // try/catch of its own (the CLI's "paste the code" OAuth branch,
        // cli/cmd/auth.ts:143-170). Degrade to "key saved, mode not flipped"
        // rather than losing the key the user just added - but log it at
        // warn: silently swallowing would leave the user's mode silently
        // disagreeing with the key they just added, with no signal at all.
        log.warn("failed to flip billing.llm to byok after adding an OpenRouter key", {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  export async function remove(key: string) {
    await CredentialLifecycle.mutate(`provider-auth.remove:${key}`, () =>
      JsonStore.update(filepath, (data) => {
        delete data[key]
      }),
    )
  }
}
