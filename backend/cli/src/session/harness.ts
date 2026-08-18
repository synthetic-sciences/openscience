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

  const Fields = z.object({
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

  function ordered(tools: z.infer<typeof ToolInfo>[]) {
    const names = tools.map((item) => item.name)
    return new Set(names).size === names.length && names.every((name, index) => name === names.toSorted()[index])
  }

  function valid(value: z.infer<typeof Fields>) {
    const base = {
      version: value.version,
      profile: value.profile,
      mode: value.mode,
      provider: value.provider,
      model: value.model,
      systemHash: value.systemHash,
      instructionsHash: value.instructionsHash,
      tools: value.tools,
    }
    return ordered(value.tools) && value.fingerprint === hash(base)
  }

  function refine(value: z.infer<typeof Fields>, ctx: z.RefinementCtx) {
    if (!ordered(value.tools)) {
      ctx.addIssue({ code: "custom", path: ["tools"], message: "Harness tools must be unique and sorted" })
    }
    if (!valid(value)) {
      ctx.addIssue({
        code: "custom",
        path: ["fingerprint"],
        message: "Harness fingerprint does not match its manifest",
      })
    }
  }

  export const Snapshot = Fields.superRefine(refine)
  export type Snapshot = z.infer<typeof Snapshot>

  export const Entry = Fields.extend({
    messageID: z.string(),
    parentMessageID: z.string(),
    attempt: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
  }).superRefine(refine)
  export type Entry = z.infer<typeof Entry>

  export const Change = z.enum(["profile", "mode", "provider", "model", "system", "instructions", "tools"])
  export type Change = z.infer<typeof Change>

  export const Transition = z.object({
    fromMessageID: z.string(),
    toMessageID: z.string(),
    fromFingerprint: Digest,
    toFingerprint: Digest,
    changes: z.array(Change),
  })

  export const Check = z.object({
    id: z.enum(["composition_integrity", "inference_attribution", "tool_attribution"]),
    status: z.enum(["pass", "fail"]),
    affected: z.array(z.string()),
  })

  export const Report = z.object({
    version: z.literal(1),
    records: z.number().int().nonnegative(),
    fingerprints: z.array(Digest),
    stable: z.boolean(),
    trajectoryHash: Digest,
    transitions: z.array(Transition),
    checks: z.array(Check),
    valid: z.boolean(),
  })
  export type Report = z.infer<typeof Report>

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

  function changes(before: Entry, after: Entry): Change[] {
    return [
      ...(before.profile === after.profile ? [] : (["profile"] as const)),
      ...(before.mode === after.mode ? [] : (["mode"] as const)),
      ...(before.provider === after.provider ? [] : (["provider"] as const)),
      ...(before.model === after.model ? [] : (["model"] as const)),
      ...(before.systemHash === after.systemHash ? [] : (["system"] as const)),
      ...(before.instructionsHash === after.instructionsHash ? [] : (["instructions"] as const)),
      ...(hash(before.tools) === hash(after.tools) ? [] : (["tools"] as const)),
    ]
  }

  export function analyze(input: {
    records: Entry[]
    inference: Array<{ messageID: string; parentMessageID: string; provider: string; model: string; attempt: number }>
    tools: Array<{ id: string; messageID: string; name: string; inputHash: string; status: string }>
  }): Report {
    const records = [...input.records]
    const fingerprints = [...new Set(records.map((item) => item.fingerprint))]
    const transitions = records
      .slice(1)
      .map((item, index) => ({ before: records[index]!, after: item }))
      .filter((pair) => pair.before.fingerprint !== pair.after.fingerprint)
      .map((pair) => ({
        fromMessageID: pair.before.messageID,
        toMessageID: pair.after.messageID,
        fromFingerprint: pair.before.fingerprint,
        toFingerprint: pair.after.fingerprint,
        changes: changes(pair.before, pair.after),
      }))
    const attempts = records.reduce<Record<string, number[]>>(
      (all, item) => ({ ...all, [item.messageID]: [...(all[item.messageID] ?? []), item.attempt] }),
      {},
    )
    const broken = Object.entries(attempts).flatMap(([messageID, values]) =>
      values.every((value, index) => value === index + 1) ? [] : [messageID],
    )
    const exact = (item: (typeof input.inference)[number]) =>
      records.find(
        (record) =>
          record.messageID === item.messageID &&
          record.parentMessageID === item.parentMessageID &&
          record.provider === item.provider &&
          record.model === item.model &&
          record.attempt === item.attempt,
      )
    const missing = input.inference.filter((item) => !exact(item)).map((item) => item.messageID)
    const unknown = input.tools
      .filter((tool) => {
        const inference = input.inference.find((item) => item.messageID === tool.messageID)
        if (!inference) return true
        return !exact(inference)?.tools.some((item) => item.name === tool.name)
      })
      .map((item) => item.id)
    const corrupt = [...records.filter((item) => !valid(item)).map((item) => item.messageID), ...broken]
    const checks: z.infer<typeof Check>[] = [
      { id: "composition_integrity", status: corrupt.length ? "fail" : "pass", affected: corrupt },
      { id: "inference_attribution", status: missing.length ? "fail" : "pass", affected: missing },
      { id: "tool_attribution", status: unknown.length ? "fail" : "pass", affected: unknown },
    ]
    return Report.parse({
      version: 1,
      records: records.length,
      fingerprints,
      stable: fingerprints.length <= 1,
      trajectoryHash: hash({
        compositions: records.map((item) => ({ fingerprint: item.fingerprint, attempt: item.attempt })),
        inference: input.inference.map((item) => ({
          provider: item.provider,
          model: item.model,
          attempt: item.attempt,
        })),
        tools: input.tools.map((item) => ({ name: item.name, inputHash: item.inputHash, status: item.status })),
      }),
      transitions,
      checks,
      valid: checks.every((item) => item.status === "pass"),
    })
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
