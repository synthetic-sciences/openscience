import crypto from "node:crypto"
import path from "node:path"
import { Global } from "../global"
import { SecretBox } from "../util/secret-box"
import { SecretFile } from "../util/secret-file"

/**
 * Versioned, machine-local sealing for MCP configuration and OAuth state.
 *
 * Ciphertexts remain ordinary strings so existing JSON/JSONC schemas and
 * editors can carry them without gaining a second persistence format. Only
 * this module knows the prefix; runtime callers always receive plaintext.
 */
export namespace McpSecretStorage {
  export const PREFIX = "openscience-secret:v1:"
  export const BOUND_PREFIX = "openscience-secret:v2:"
  const keyPath = path.join(Global.Path.data, "credentials.key")
  const reference = /^\{(?:env|file):[^}]+\}$/

  async function key(): Promise<Buffer> {
    return SecretFile.key(keyPath)
  }

  export type IdentifierDomain = "connector-operation-lock" | "oauth-authority" | "oauth-flow" | "oauth-settlement-lock"

  /**
   * Produce a stable, machine-local identifier without publishing a digest of
   * low-entropy credential material. The fixed prefix and closed domain set
   * prevent one identifier class from being replayed as another; the existing
   * credentials key keeps the output deterministic across processes and data
   * root relocation while denying an offline guessing oracle to anyone who
   * only obtains a fingerprint or lock filename.
   */
  export async function identifier(domain: IdentifierDomain, value: string): Promise<string> {
    const hmac = crypto.createHmac("sha256", await key())
    hmac.end(`openscience:mcp:identifier:v1\0${domain}\0${value}`)
    const digest = hmac.read()
    if (!Buffer.isBuffer(digest)) throw new Error("MCP identifier HMAC did not finalize synchronously")
    return digest.toString("hex")
  }

  export function sealed(value: string): boolean {
    return value.startsWith(PREFIX) || value.startsWith(BOUND_PREFIX)
  }

  export async function seal(value: string, context?: string): Promise<string> {
    if (reference.test(value) || value === "••••••••") return value
    if (!context) {
      if (sealed(value)) return value
      return `${PREFIX}${SecretBox.seal(await key(), value)}`
    }
    if (value.startsWith(BOUND_PREFIX)) {
      await open(value, context)
      return value
    }
    const literal = value.startsWith(PREFIX) ? await open(value) : value
    return `${BOUND_PREFIX}${SecretBox.seal(await key(), JSON.stringify({ context, value: literal }))}`
  }

  /** Seal provider-controlled OAuth authority as literal data. Config-only
   * references such as `{env:NAME}` and the UI mask have no special meaning in
   * a token response, and preserving them would write live authority in
   * plaintext (or make a malicious prefix look like trusted ciphertext). */
  export async function sealAuthority(value: string): Promise<string> {
    return `${PREFIX}${SecretBox.seal(await key(), value)}`
  }

  export async function open(value: string, context?: string): Promise<string> {
    if (value.startsWith(BOUND_PREFIX)) {
      if (!context) throw new Error("Bound MCP secret is missing its authority context")
      const decoded: unknown = JSON.parse(SecretBox.open(await key(), value.slice(BOUND_PREFIX.length)))
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new Error("Bound MCP secret payload is invalid")
      }
      const payload = decoded as { context?: unknown; value?: unknown }
      if (payload.context !== context || typeof payload.value !== "string") {
        throw new Error("MCP secret was moved to a different connector authority or field")
      }
      return payload.value
    }
    if (!value.startsWith(PREFIX)) return value
    return SecretBox.open(await key(), value.slice(PREFIX.length))
  }

  export interface SecretPath {
    path: string[]
    value: string
    context: string
  }

  function authority(name: string, entry: Record<string, unknown>): string {
    if (entry.type === "local") {
      return JSON.stringify({ name, type: "local", command: entry.command })
    }
    const oauth =
      entry.oauth && typeof entry.oauth === "object" && !Array.isArray(entry.oauth) ? entry.oauth : undefined
    const rawUrl = typeof entry.url === "string" ? entry.url : ""
    let url = rawUrl
    try {
      url = new URL(rawUrl).toString()
    } catch {}
    return JSON.stringify({
      name,
      type: "remote",
      url,
      oauth:
        oauth && typeof oauth === "object"
          ? {
              clientId: (oauth as Record<string, unknown>).clientId,
              scope: (oauth as Record<string, unknown>).scope,
            }
          : (oauth ?? null),
    })
  }

  function fieldContext(authorityValue: string, path: string[]): string {
    return JSON.stringify({ authority: authorityValue, field: path })
  }

  /** Locate only fields whose values grant MCP authority. Public client IDs,
   * endpoints, scopes, timeouts, and commands deliberately remain readable. */
  export function paths(value: unknown): SecretPath[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return []
    const mcp = (value as { mcp?: unknown }).mcp
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return []
    const result: SecretPath[] = []
    for (const [name, candidate] of Object.entries(mcp)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
      const entry = candidate as Record<string, unknown>
      const authorityValue = authority(name, entry)
      if (entry.type === "local") {
        const environment = entry.environment
        if (!environment || typeof environment !== "object" || Array.isArray(environment)) continue
        for (const [key, secret] of Object.entries(environment)) {
          const secretPath = ["mcp", name, "environment", key]
          if (typeof secret === "string") {
            result.push({ path: secretPath, value: secret, context: fieldContext(authorityValue, secretPath) })
          }
        }
        continue
      }
      if (entry.type !== "remote") continue
      const headers = entry.headers
      if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        for (const [key, secret] of Object.entries(headers)) {
          const secretPath = ["mcp", name, "headers", key.toLowerCase()]
          if (typeof secret === "string") {
            result.push({
              path: ["mcp", name, "headers", key],
              value: secret,
              context: fieldContext(authorityValue, secretPath),
            })
          }
        }
      }
      const oauth = entry.oauth
      if (oauth && typeof oauth === "object" && !Array.isArray(oauth)) {
        const secret = (oauth as Record<string, unknown>).clientSecret
        const secretPath = ["mcp", name, "oauth", "clientSecret"]
        if (typeof secret === "string") {
          result.push({ path: secretPath, value: secret, context: fieldContext(authorityValue, secretPath) })
        }
      }
    }
    return result
  }

  export async function protect<T>(value: T): Promise<T> {
    const copy = structuredClone(value)
    for (const item of paths(copy)) {
      let owner = copy as Record<string, unknown>
      for (const segment of item.path.slice(0, -1)) owner = owner[segment] as Record<string, unknown>
      owner[item.path.at(-1)!] = await seal(item.value, item.context)
    }
    return copy
  }

  export async function reveal<T>(value: T): Promise<T> {
    const copy = structuredClone(value)
    for (const item of paths(copy)) {
      if (!sealed(item.value)) continue
      let owner = copy as Record<string, unknown>
      for (const segment of item.path.slice(0, -1)) owner = owner[segment] as Record<string, unknown>
      owner[item.path.at(-1)!] = await open(item.value, item.context)
    }
    return copy
  }
}
