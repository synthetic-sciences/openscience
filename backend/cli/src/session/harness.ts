import { asSchema, type Tool } from "ai"
import type { Agent } from "@/agent/agent"
import z from "zod"

export namespace SessionHarness {
  const Digest = z.string().regex(/^[a-f0-9]{64}$/)

  export const ToolInfo = z.object({
    name: z.string(),
    descriptionHash: Digest,
    schemaHash: Digest,
  })

  export const Snapshot = z.object({
    version: z.literal(1),
    profile: z.string(),
    mode: z.enum(["subagent", "primary", "all"]),
    provider: z.string(),
    model: z.string(),
    systemHash: Digest,
    instructionsHash: Digest.optional(),
    tools: z.array(ToolInfo),
    fingerprint: Digest,
  })
  export type Snapshot = z.infer<typeof Snapshot>

  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }

  export function hash(value: unknown) {
    const text = typeof value === "string" ? value : (JSON.stringify(canonical(value)) ?? "undefined")
    return new Bun.CryptoHasher("sha256").update(text).digest("hex")
  }

  export async function snapshot(input: {
    agent: Pick<Agent.Info, "name" | "mode">
    provider: string
    model: string
    system: string[]
    instructions?: string
    tools: Record<string, Tool>
  }): Promise<Snapshot> {
    const tools = await Promise.all(
      Object.entries(input.tools).map(async ([name, item]) => ({
        name,
        descriptionHash: hash(item.description ?? ""),
        schemaHash: hash(await asSchema(item.inputSchema).jsonSchema),
      })),
    ).then((items) => items.toSorted((a, b) => a.name.localeCompare(b.name)))
    const base = {
      version: 1 as const,
      profile: input.agent.name,
      mode: input.agent.mode,
      provider: input.provider,
      model: input.model,
      systemHash: hash(input.system),
      instructionsHash: input.instructions ? hash(input.instructions) : undefined,
      tools,
    }
    return Snapshot.parse({ ...base, fingerprint: hash(base) })
  }
}
