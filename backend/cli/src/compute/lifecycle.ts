import z from "zod"

export namespace ComputeLifecycle {
  export const Execution = z.enum([
    "planned",
    "awaiting_approval",
    "queued",
    "starting",
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "interrupted",
  ])
  export type Execution = z.infer<typeof Execution>

  export const Delivery = z.enum(["none", "pending", "complete", "rejected", "failed"])
  export type Delivery = z.infer<typeof Delivery>

  export const Resource = z.enum(["none", "starting", "active", "closed", "unknown"])
  export type Resource = z.infer<typeof Resource>

  export const ErrorKind = z.enum([
    "provider_disabled",
    "image_build_failed",
    "unauthorized",
    "quota_exhausted",
    "rate_limited",
    "ownership_mismatch",
    "result_rejected",
    "harvest_failed",
    "input_changed",
    "session_concurrency_full",
    "invalid_request",
    "not_found",
  ])
  export type ErrorKind = z.infer<typeof ErrorKind>

  export const State = z.object({
    execution: Execution,
    delivery: Delivery,
    resource: Resource,
    recoverable: z.boolean(),
    error_kind: ErrorKind.optional(),
    system_hint: z.string().optional(),
    deadline_fired: z.boolean().optional(),
  })
  export type State = z.infer<typeof State>

  export const Event = z.discriminatedUnion("type", [
    z.object({ type: z.literal("review") }),
    z.object({ type: z.literal("approve") }),
    z.object({ type: z.literal("queue") }),
    z.object({ type: z.literal("start") }),
    z.object({ type: z.literal("run") }),
    z.object({
      type: z.literal("finish"),
      outcome: z.enum(["succeeded", "failed", "timed_out"]),
      kind: ErrorKind.optional(),
      message: z.string().optional(),
    }),
    z.object({ type: z.literal("collect") }),
    z.object({ type: z.literal("deliver") }),
    z.object({ type: z.literal("reject"), message: z.string().optional() }),
    z.object({ type: z.literal("delivery_fail"), message: z.string().optional() }),
    z.object({ type: z.literal("retry_delivery") }),
    z.object({ type: z.literal("cancel") }),
    z.object({ type: z.literal("interrupt") }),
    z.object({ type: z.literal("close") }),
    z.object({ type: z.literal("lose") }),
    z.object({ type: z.literal("abandon") }),
  ])
  export type Event = z.infer<typeof Event>

  export type Legacy = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted"

  const done = new Set<Execution>(["succeeded", "failed", "timed_out", "cancelled", "interrupted"])

  export function initial(): State {
    return State.parse({ execution: "planned", delivery: "none", resource: "none", recoverable: false })
  }

  export function from(status: Legacy): State {
    if (status === "queued") {
      return State.parse({ execution: "queued", delivery: "none", resource: "none", recoverable: false })
    }
    if (status === "running") {
      return State.parse({ execution: "running", delivery: "none", resource: "active", recoverable: false })
    }
    if (status === "interrupted") {
      return State.parse({ execution: "interrupted", delivery: "none", resource: "unknown", recoverable: false })
    }
    return State.parse({ execution: status, delivery: "none", resource: "closed", recoverable: false })
  }

  export function legacy(state: State): Legacy {
    if (state.execution === "planned" || state.execution === "awaiting_approval") return "queued"
    if (state.execution === "starting") return "queued"
    if (state.execution === "running") return "running"
    if (state.execution === "timed_out") return "failed"
    return state.execution
  }

  export function terminal(state: State): boolean {
    return done.has(state.execution)
  }

  export function transition(input: State, value: Event): State {
    const state = State.parse(input)
    const event = Event.parse(value)
    const invalid = () => {
      throw new Error(`Invalid compute lifecycle transition: ${state.execution} → ${event.type}`)
    }
    const accepts = (values: Execution[]) => {
      if (!values.includes(state.execution)) return invalid()
    }

    if (event.type === "review") {
      accepts(["planned"])
      return State.parse({ ...state, execution: "awaiting_approval" })
    }
    if (event.type === "approve") {
      accepts(["awaiting_approval"])
      return State.parse({ ...state, execution: "queued" })
    }
    if (event.type === "queue") {
      accepts(["planned"])
      return State.parse({ ...state, execution: "queued" })
    }
    if (event.type === "start") {
      accepts(["queued"])
      return State.parse({ ...state, execution: "starting", resource: "starting" })
    }
    if (event.type === "run") {
      accepts(["queued", "starting"])
      return State.parse({ ...state, execution: "running", resource: "active" })
    }
    if (event.type === "finish") {
      accepts(["queued", "starting", "running"])
      return State.parse({
        ...state,
        execution: event.outcome,
        ...(event.kind ? { error_kind: event.kind } : {}),
        ...(event.message ? { system_hint: event.message } : {}),
        ...(event.outcome === "timed_out" ? { deadline_fired: true } : {}),
      })
    }
    if (event.type === "collect") {
      accepts(["succeeded", "failed", "timed_out"])
      if (state.delivery === "complete") return invalid()
      return State.parse({ ...state, delivery: "pending" })
    }
    if (event.type === "deliver") {
      if (state.delivery !== "pending") return invalid()
      return State.parse({ ...state, delivery: "complete", recoverable: false })
    }
    if (event.type === "reject") {
      if (state.delivery !== "pending") return invalid()
      return State.parse({
        ...state,
        delivery: "rejected",
        recoverable: true,
        error_kind: "result_rejected",
        ...(event.message ? { system_hint: event.message } : {}),
      })
    }
    if (event.type === "delivery_fail") {
      if (state.delivery !== "pending") return invalid()
      return State.parse({
        ...state,
        delivery: "failed",
        recoverable: true,
        error_kind: "harvest_failed",
        ...(event.message ? { system_hint: event.message } : {}),
      })
    }
    if (event.type === "retry_delivery") {
      if (state.delivery !== "failed" && state.delivery !== "rejected") return invalid()
      return State.parse({
        ...state,
        delivery: "pending",
        recoverable: true,
        error_kind: undefined,
        system_hint: undefined,
      })
    }
    if (event.type === "cancel") {
      if (terminal(state)) return invalid()
      return State.parse({ ...state, execution: "cancelled" })
    }
    if (event.type === "interrupt") {
      if (terminal(state)) return invalid()
      return State.parse({ ...state, execution: "interrupted", resource: "unknown" })
    }
    if (event.type === "close") {
      if (state.recoverable) {
        throw new Error("Cannot close compute resource while it holds the only recoverable copy of an output")
      }
      return State.parse({ ...state, resource: "closed" })
    }
    if (event.type === "lose") return State.parse({ ...state, resource: "unknown" })
    if (event.type === "abandon") {
      if (!state.recoverable) return invalid()
      return State.parse({ ...state, recoverable: false })
    }
    return invalid()
  }
}
