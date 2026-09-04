import path from "path"
import { createHash } from "node:crypto"
import z from "zod"
import { Global } from "../global"
import { JsonStore } from "../util/jsonstore"
import { SecretBox } from "../util/secret-box"
import { SecretFile } from "../util/secret-file"
import { isAtlasManagedKey } from "../credentials/managed-key"
import { CredentialLifecycle } from "../credentials/lifecycle"
import { Log } from "../util/log"
import { isDeepStrictEqual } from "node:util"

/** A revocable overlay, never a replacement for this device's own credentials.
 * No dashboard config, executable code, arbitrary environment, or billing
 * preference crosses this boundary. Cached grants expire when offline. */
export namespace WorkspaceCredentials {
  const log = Log.create({ service: "workspace-credentials" })
  /** Hard bound on a cached grant. OpenScience.SYNC_INTERVAL renews well
   * inside it, with retries, so only a genuinely unreachable workspace lets
   * a grant lapse. */
  export const TTL = 5 * 60_000
  /** Retry cadence when publishing an expiry fails (an unwritable data root,
   * a wedged lease). A lapsed grant must be revoked, so retries continue at
   * the last interval until one succeeds or a newer grant replaces it. */
  export const EXPIRE_BACKOFF: readonly number[] = [1_000, 5_000, 15_000, 30_000]
  export const filepath = path.join(Global.Path.data, "workspace-credentials.json")
  let expiry: ReturnType<typeof setTimeout> | undefined
  let deadline = 0

  /** When the cached grant lapses, for refresh diagnostics. */
  export function expiresAt(): number | undefined {
    return deadline || undefined
  }
  type Session = { api_key: string; organization_id?: string }
  const Renewal = z
    .object({
      kind: z.literal("github-app-installation"),
      authority: z.string().regex(/^[a-f0-9]{64}$/),
      expires_at: z.number().int().positive(),
    })
    .strict()
  const Snapshot = z.object({
    organization_id: z.string(),
    auth: z.record(z.string(), z.object({ type: z.literal("api"), key: z.string() })),
    services: z.record(z.string(), z.record(z.string(), z.string())),
    github_renewal: Renewal.optional(),
  })
  export type Snapshot = z.infer<typeof Snapshot>
  const Response = z.object({
    organization_id: z.string().min(1),
    user: z.object({ user_id: z.string() }),
    services: z.record(
      z.string(),
      z.object({
        connected: z.boolean(),
        env: z.record(z.string(), z.string()).default({}),
        metadata: z.object({ source: z.string().optional() }).passthrough().default({}),
      }),
    ),
    portable_credentials: z.record(z.string(), z.object({ fields: z.record(z.string(), z.string()) })).default({}),
  })
  const providers: Record<string, [string, string]> = {
    anthropic: ["anthropic", "ANTHROPIC_API_KEY"],
    openai: ["openai", "OPENAI_API_KEY"],
    gemini: ["google", "GOOGLE_GENERATIVE_AI_API_KEY"],
    openrouter: ["openrouter", "OPENROUTER_API_KEY"],
    meta: ["meta", "META_MODEL_API_KEY"],
    xai: ["xai", "XAI_API_KEY"],
    together: ["togetherai", "TOGETHER_API_KEY"],
    groq: ["groq", "GROQ_API_KEY"],
    fireworks: ["fireworks-ai", "FIREWORKS_API_KEY"],
    mistral: ["mistral", "MISTRAL_API_KEY"],
    deepseek: ["deepseek", "DEEPSEEK_API_KEY"],
    cerebras: ["cerebras", "CEREBRAS_API_KEY"],
    perplexity: ["perplexity", "PERPLEXITY_API_KEY"],
  }

  export function providerEnv(id: string): string[] {
    const name = Object.values(providers).find(([provider]) => provider === id)?.[1]
    if (!name) return []
    return id === "google" ? [name, "GOOGLE_API_KEY", "GEMINI_API_KEY"] : [name]
  }

  const services: Record<string, Record<string, string>> = {
    github: { token: "GITHUB_TOKEN" },
    literature: { api_key: "SEMANTIC_SCHOLAR_API_KEY" },
    openalex: { api_key: "OPENALEX_API_KEY", email: "OPENALEX_MAILTO" },
    huggingface: { api_key: "HF_TOKEN" },
    wandb: { api_key: "WANDB_API_KEY" },
    pinecone: { api_key: "PINECONE_API_KEY" },
    langsmith: { api_key: "LANGSMITH_API_KEY" },
    tinker: { api_key: "TINKER_API_KEY", base_url: "TINKER_BASE_URL" },
    nvidia: { api_key: "NVIDIA_API_KEY" },
  }

  export function identity(session: Session): string {
    return createHash("sha256")
      .update(`${session.api_key}\0${session.organization_id ?? ""}`)
      .digest("hex")
  }

  export function parse(value: unknown): { snapshot: Snapshot; user_id: string } {
    const parsed = Response.safeParse(value)
    if (!parsed.success) throw new Error("The workspace returned an invalid credential sync response. Try again.")
    const data = parsed.data
    const snapshot: Snapshot = { organization_id: data.organization_id, auth: {}, services: {} }
    for (const [id, service] of Object.entries(data.services)) {
      if (!service.connected) continue
      // Managed proxy placeholders and OAuth compatibility carriers are not
      // portable provider keys. Ace continues through its existing gateway.
      if (
        !(id === "github" && service.metadata.source === "github_connection") &&
        !["byok", "workspace_byok", "organization_byok", "portable_account", "workspace_credential"].includes(
          service.metadata.source ?? "",
        )
      )
        continue
      const provider = providers[id]
      const key = provider && service.env[provider[1]]
      if (provider && key && !isAtlasManagedKey(key)) snapshot.auth[provider[0]] = { type: "api", key }
      const fields = Object.fromEntries(
        Object.entries(services[id] ?? {}).flatMap(([field, name]) => {
          const value = service.env[name]
          return value && !isAtlasManagedKey(value) ? [[field, value]] : []
        }),
      )
      // Consumers independently restrict portable fields to their reviewed
      // service schema. A sync never enables or selects a compute backend.
      const portable = data.portable_credentials[id]?.fields
      if (portable)
        Object.assign(
          fields,
          Object.fromEntries(Object.entries(portable).filter(([, value]) => value && !isAtlasManagedKey(value))),
        )
      if (Object.keys(fields).length) snapshot.services[id] = fields
      if (
        id === "github" &&
        fields.token &&
        service.metadata.source === "github_connection" &&
        service.metadata.token_kind === "app"
      ) {
        const renewal = Renewal.safeParse(service.metadata.credential_renewal)
        if (renewal.success) snapshot.github_renewal = renewal.data
      }
    }
    return { snapshot, user_id: data.user.user_id }
  }

  /** Never infer renewable authority from a token prefix. The authenticated
   * gateway supplies a receipt for the exact minted installation scope. */
  export function change(
    previous: Snapshot | undefined,
    next: Snapshot,
    now = Date.now(),
  ): "unchanged" | "renew" | "revoke" {
    // Even an identical response cannot extend an explicitly expired grant.
    // Unreasonably distant timestamps are not short-lived GitHub authority.
    for (const receipt of [previous?.github_renewal, next.github_renewal]) {
      if (receipt && (receipt.expires_at <= now || receipt.expires_at > now + 65 * 60_000)) return "revoke"
    }
    if (isDeepStrictEqual(previous, next)) return "unchanged"
    if (!previous) return "revoke"
    const before = previous.github_renewal
    const after = next.github_renewal
    if (!before || !after || before.authority !== after.authority) return "revoke"
    if (!previous.services.github?.token || !next.services.github?.token) return "revoke"
    const stable = (value: Snapshot) => ({
      ...value,
      github_renewal: undefined,
      services: { ...value.services, github: { ...value.services.github, token: undefined } },
    })
    return isDeepStrictEqual(stable(previous), stable(next)) ? "renew" : "revoke"
  }

  export async function write(session: Session, snapshot: Snapshot): Promise<void> {
    const key = await SecretFile.key(path.join(Global.Path.data, "credentials.key"))
    const expires = Date.now() + TTL
    await JsonStore.update(filepath, () => ({
      identity: identity(session),
      expires_at: expires,
      payload: SecretBox.seal(key, JSON.stringify(snapshot)),
    }))
    arm(expires)
  }

  export async function clear(): Promise<void> {
    await JsonStore.update(filepath, () => ({}))
    if (expiry) clearTimeout(expiry)
    deadline = 0
  }

  /** Publish expiry as a real credential revocation so running SDK caches and
   * child processes cannot retain a cloud grant indefinitely while offline.
   *
   * The revision reason is `workspace-sync.expired`, which CredentialTeardown
   * treats as overlay-scoped: the grant is cleared here before the revision is
   * published (no new request can use it), and only children stamped with the
   * overlay are revoked. Disposing every project instance for this reason was
   * wrong: it aborted active model turns that ran on Ace or on the device's
   * own keys and never used the lapsed overlay. */
  export async function expire(): Promise<void> {
    await CredentialLifecycle.mutateIf(
      "workspace-sync.expired",
      async () => {
        const store = await JsonStore.read(filepath)
        const lapsed = typeof store.expires_at === "number" && store.expires_at <= Date.now()
        if (lapsed) {
          const { OpenScience } = await import("./index")
          log.warn("synchronized workspace credentials expired before they could be renewed", {
            expires_at: new Date(store.expires_at as number).toISOString(),
            sync: OpenScience.credentialSyncStatus(),
          })
        }
        return lapsed
      },
      clear,
    )
  }

  function arm(expires: number): void {
    if (deadline === expires) return
    schedule(expires, Math.max(0, expires - Date.now()), 0)
  }

  /** A failed expiry is re-armed with backoff rather than swallowed: until
   * the revision is published, process.env still carries the lapsed values
   * and every child spawned inherits them. */
  function schedule(expires: number, delay: number, attempt: number): void {
    if (expiry) clearTimeout(expiry)
    deadline = expires
    expiry = setTimeout(() => {
      void expire().catch((error) => {
        // A newer grant was armed meanwhile; its own timer owns expiry now.
        if (deadline !== expires) return
        const retry = EXPIRE_BACKOFF[Math.min(attempt, EXPIRE_BACKOFF.length - 1)] ?? 30_000
        log.error("workspace credential expiry failed; retrying", {
          error: error instanceof Error ? error.message : String(error),
          attempt: attempt + 1,
          retry_ms: retry,
          expires_at: new Date(expires).toISOString(),
        })
        schedule(expires, retry, attempt + 1)
      })
    }, delay)
    expiry.unref()
  }

  export async function read(options: { strict?: boolean } = {}): Promise<Snapshot | undefined> {
    const unreadable = () => {
      if (options.strict) throw new Error("Saved workspace credentials could not be read")
      return undefined
    }
    const store = await JsonStore.read(filepath, options).catch((error) => {
      if (options.strict) throw new Error("Saved workspace credentials could not be read")
      throw error
    })
    if (!store || typeof store !== "object" || Array.isArray(store)) return unreadable()
    if (!Object.keys(store).length) return
    if (typeof store.expires_at !== "number" || !Number.isFinite(store.expires_at)) return unreadable()
    if (store.expires_at <= Date.now()) return
    if (typeof store.identity !== "string" || !/^[a-f0-9]{64}$/.test(store.identity)) return unreadable()
    arm(store.expires_at)
    const { OpenScience } = await import("./index")
    const session = await OpenScience.getSession()
    if (!session || identity(session) !== store.identity) return
    if (typeof store.payload !== "string" || !store.payload) return unreadable()
    // Reading must not create a key or silently repair corrupted ciphertext.
    const key = await Bun.file(path.join(Global.Path.data, "credentials.key"))
      .arrayBuffer()
      .catch(() => undefined)
    if (!key) return unreadable()
    try {
      return Snapshot.parse(JSON.parse(SecretBox.open(Buffer.from(key), store.payload)))
    } catch {
      return unreadable()
    }
  }
}
