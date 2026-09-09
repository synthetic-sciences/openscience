import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"
import { Global } from "@/global"
import { Storage } from "@/storage/storage"
import { FileLease } from "@/util/file-lease"
import { Log } from "@/util/log"

/**
 * Fusion binds one lead Research session to one persistent worker session.
 *
 * The lead keeps the objective, methodological decisions and compact evidence;
 * the worker keeps the detailed tool history of the work it was handed. Every
 * `execute` dispatch under the Fusion strategy resumes the bound worker instead
 * of minting a fresh child, so context set-up is paid once per lineage rather
 * than once per Task call. The record below is the durable binding: it survives
 * process restarts, and the worker model it names is the one that runs, not
 * whatever the preference says later.
 */
export namespace Fusion {
  const log = Log.create({ service: "fusion" })

  export const POLICY_VERSION = 1
  export const DEFAULT_MAX_HANDOFFS_PER_TURN = 6

  export const Model = z.object({ providerID: z.string(), modelID: z.string() })
  export type Model = z.infer<typeof Model>

  export const Usage = z.object({
    cost: z.number().nonnegative(),
    tokens: z.object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cache: z.object({ read: z.number().nonnegative(), write: z.number().nonnegative() }),
    }),
  })
  export type Usage = z.infer<typeof Usage>

  export const Binding = z
    .object({
      version: z.literal(1),
      parentSessionID: z.string(),
      workerSessionID: z.string(),
      worker: Model,
      policy: z.object({
        version: z.number().int().positive(),
        maxHandoffsPerTurn: z.number().int().positive(),
      }),
      /** Increments when a materially different worker (model/route) replaces
       * the previous one. Earlier workers remain ordinary child sessions. */
      generation: z.number().int().positive(),
      /** Completed handoffs across the lineage's whole life. */
      handoffs: z.number().int().nonnegative(),
      /** Handoffs started in the current lead turn, keyed by the lead's user message. */
      turn: z.object({ userMessageID: z.string(), handoffs: z.number().int().nonnegative() }).optional(),
      usage: Usage,
      lastResult: z
        .object({
          callID: z.string(),
          outcome: z.enum(["completed", "partial", "error"]),
          stopReason: z.string(),
          at: z.number(),
        })
        .optional(),
      createdAt: z.number(),
      updatedAt: z.number(),
    })
    .meta({ ref: "FusionBinding" })
  export type Binding = z.infer<typeof Binding>

  /** The model-facing refusal when a turn has used its handoff budget. */
  export class HandoffBudgetError extends Error {
    constructor(
      readonly parentSessionID: string,
      readonly limit: number,
    ) {
      super(
        `Fusion handoff budget reached: this turn already made ${limit} handoffs to the worker. No new work was dispatched. Finish with what the worker returned, or ask the user before continuing.`,
      )
      this.name = "FusionHandoffBudgetError"
    }
  }

  const emptyUsage = (): Usage => ({ cost: 0, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } })

  function key(parentSessionID: string) {
    return ["fusion", parentSessionID]
  }

  function leasePath(parentSessionID: string) {
    const digest = createHash("sha256").update(parentSessionID).digest("hex")
    return path.join(Global.Path.data, "fusion", `${digest}.lock`)
  }

  export async function get(parentSessionID: string): Promise<Binding | undefined> {
    const raw = await Storage.read<unknown>(key(parentSessionID)).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return undefined
      throw error
    })
    if (raw === undefined) return undefined
    const parsed = Binding.safeParse(raw)
    if (parsed.success) return parsed.data
    log.warn("discarding unreadable fusion binding", { parentSessionID, issues: parsed.error.issues })
    return undefined
  }

  /** Idempotent: a lead deleted without a binding is not an error. */
  export async function remove(parentSessionID: string) {
    await Storage.remove(key(parentSessionID)).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
  }

  export function same(a: Model, b: Model) {
    return a.providerID === b.providerID && a.modelID === b.modelID
  }

  /**
   * Serialize binding decisions for one lead. Two Task calls dispatched in the
   * same assistant step must observe each other, or each would mint its own
   * worker and the lineage would fork.
   */
  export async function exclusive<T>(parentSessionID: string, action: () => Promise<T>, signal?: AbortSignal) {
    await using lease = await FileLease.acquire(leasePath(parentSessionID), 30_000, signal)
    return lease.during(action)
  }

  export type Resolution = {
    binding: Binding
    /** True when this call created the binding or started a new lineage. */
    fresh: boolean
  }

  /**
   * Resolve the worker for a dispatch. Reuses the bound worker while its model
   * matches the configured one; a different configured model starts a new
   * lineage (fresh worker session, generation + 1) so a preference change never
   * re-routes a live worker's history to another model. Enforces the per-turn
   * handoff budget before any child work exists.
   */
  export async function resolve(input: {
    parentSessionID: string
    userMessageID: string
    worker: Model
    maxHandoffsPerTurn?: number
    mint: () => string
  }): Promise<Resolution> {
    const limit = input.maxHandoffsPerTurn ?? DEFAULT_MAX_HANDOFFS_PER_TURN
    const now = Date.now()
    const existing = await get(input.parentSessionID)
    const turn =
      existing?.turn?.userMessageID === input.userMessageID
        ? existing.turn
        : { userMessageID: input.userMessageID, handoffs: 0 }
    if (turn.handoffs >= limit) throw new HandoffBudgetError(input.parentSessionID, limit)

    const reuse = existing && same(existing.worker, input.worker)
    const binding: Binding = reuse
      ? {
          ...existing,
          policy: { version: POLICY_VERSION, maxHandoffsPerTurn: limit },
          turn: { ...turn, handoffs: turn.handoffs + 1 },
          updatedAt: now,
        }
      : {
          version: 1,
          parentSessionID: input.parentSessionID,
          workerSessionID: input.mint(),
          worker: input.worker,
          policy: { version: POLICY_VERSION, maxHandoffsPerTurn: limit },
          generation: (existing?.generation ?? 0) + 1,
          handoffs: 0,
          turn: { ...turn, handoffs: turn.handoffs + 1 },
          usage: emptyUsage(),
          createdAt: now,
          updatedAt: now,
        }
    if (existing && !reuse) {
      log.info("starting a new fusion lineage", {
        parentSessionID: input.parentSessionID,
        from: existing.worker,
        to: input.worker,
        generation: binding.generation,
      })
    }
    await Storage.write(key(input.parentSessionID), binding)
    return { binding, fresh: !reuse }
  }

  /** Record a settled handoff: cumulative usage and the last outcome. */
  export async function settle(input: {
    parentSessionID: string
    callID: string
    outcome: "completed" | "partial" | "error"
    stopReason: string
    usage: Usage
  }) {
    const existing = await get(input.parentSessionID)
    if (!existing) return
    if (existing.lastResult?.callID === input.callID) return existing
    const next: Binding = {
      ...existing,
      handoffs: existing.handoffs + 1,
      usage: {
        cost: existing.usage.cost + input.usage.cost,
        tokens: {
          input: existing.usage.tokens.input + input.usage.tokens.input,
          output: existing.usage.tokens.output + input.usage.tokens.output,
          cache: {
            read: existing.usage.tokens.cache.read + input.usage.tokens.cache.read,
            write: existing.usage.tokens.cache.write + input.usage.tokens.cache.write,
          },
        },
      },
      lastResult: { callID: input.callID, outcome: input.outcome, stopReason: input.stopReason, at: Date.now() },
      updatedAt: Date.now(),
    }
    await Storage.write(key(input.parentSessionID), next)
    return next
  }

  /** Lead-facing guidance appended to the effort reminder while Fusion is on. */
  export function leadPosture(input: { lead: Model; worker: Model }) {
    const pair = same(input.lead, input.worker)
      ? `Fusion is on with the same model as worker (${input.worker.providerID}/${input.worker.modelID}); it keeps a persistent execution context but does not lower the price of a turn.`
      : `Fusion is on. Lead: ${input.lead.providerID}/${input.lead.modelID}. Worker: ${input.worker.providerID}/${input.worker.modelID}.`
    return [
      pair,
      "Delegate substantial, well-specified work to the worker with the task tool (subagent_type execute): source extraction against a defined question, dataset inspection, implementing a specified analysis, reproducing a figure from pinned inputs, running checks, formatting outputs, repairing a known implementation error. The runtime resumes the same worker for every execute task in this conversation, so continue and refine instead of restating context; successive implementation and repair handoffs to it are expected, and the general advice against sequential delegation does not apply to your Fusion worker.",
      "Keep the judgment: which claim is tested, whether the data supports it, fitting and model assumptions, inclusion and exclusion, leakage, interpretation of conflicting results, the final conclusions. Repetitive is not harmless: unit conversion, joins, filtering and outlier treatment change the claim.",
      "Write a five-part brief: objective, inputs and files, interfaces, constraints, verification. Do not dictate code. Read only the decisive evidence the worker returns; do not re-do or narrate its work. Small tasks and serial reasoning stay with you.",
    ].join(" ")
  }

  /** Worker-facing contract appended to the child guidance while Fusion is on. */
  export function workerContract(generation: number, handoff: number) {
    return [
      `You are the lead's persistent Fusion worker (lineage ${generation}, handoff ${handoff}). Your session keeps the history of earlier handoffs; build on it rather than re-reading what you already established.`,
      "Begin your handoff with one status line: Status: completed | partial | blocked | needs-decision. Then report what you did, the output and source references, the checks you actually ran and their results, limitations, and any decision the lead must make.",
      "Report conflicting columns, missing units or ambiguous inputs before making a methodological choice. Do not choose a new fit, exclude data points or reinterpret the objective on your own.",
      "Never launch paid compute or publish results; those stay with the lead.",
    ].join("\n")
  }
}
