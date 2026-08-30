import path from "path"
import { createHash } from "node:crypto"
import z from "zod"
import { Global } from "../global"
import { JsonStore } from "../util/jsonstore"
import { SecretBox } from "../util/secret-box"
import { SecretFile } from "../util/secret-file"
import { isAtlasManagedKey } from "../credentials/managed-key"
import { CredentialLifecycle } from "../credentials/lifecycle"

/** A revocable overlay, never a replacement for this device's own credentials.
 * No dashboard config, executable code, arbitrary environment, or billing
 * preference crosses this boundary. Cached grants expire when offline. */
export namespace WorkspaceCredentials {
  export const TTL = 5 * 60_000
  export const filepath = path.join(Global.Path.data, "workspace-credentials.json")
  let expiry: ReturnType<typeof setTimeout> | undefined
  let deadline = 0
  type Session = { api_key: string; organization_id?: string }
  const Snapshot = z.object({
    organization_id: z.string(),
    auth: z.record(z.string(), z.object({ type: z.literal("api"), key: z.string() })),
    services: z.record(z.string(), z.record(z.string(), z.string())),
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
    }
    return { snapshot, user_id: data.user.user_id }
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
   * child processes cannot retain a cloud grant indefinitely while offline. */
  export async function expire(): Promise<void> {
    await CredentialLifecycle.mutateIf(
      "workspace-sync.expired",
      async () => {
        const store = await JsonStore.read(filepath)
        return typeof store.expires_at === "number" && store.expires_at <= Date.now()
      },
      clear,
    )
  }

  function arm(expires: number): void {
    if (deadline === expires) return
    if (expiry) clearTimeout(expiry)
    deadline = expires
    expiry = setTimeout(() => void expire().catch(() => undefined), Math.max(0, expires - Date.now()))
    expiry.unref()
  }

  export async function read(): Promise<Snapshot | undefined> {
    const store = await JsonStore.read(filepath)
    if (typeof store.expires_at !== "number" || store.expires_at <= Date.now() || typeof store.payload !== "string")
      return
    arm(store.expires_at)
    const { OpenScience } = await import("./index")
    const session = await OpenScience.getSession()
    if (!session || identity(session) !== store.identity) return
    // Reading must not create a key or silently repair corrupted ciphertext.
    const key = await Bun.file(path.join(Global.Path.data, "credentials.key"))
      .arrayBuffer()
      .catch(() => undefined)
    if (!key) return
    try {
      return Snapshot.parse(JSON.parse(SecretBox.open(Buffer.from(key), store.payload)))
    } catch {
      return
    }
  }
}
