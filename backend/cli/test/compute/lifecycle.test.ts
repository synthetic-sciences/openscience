import { describe, expect, test } from "bun:test"
import { ComputeLifecycle } from "../../src/compute/lifecycle"

describe("ComputeLifecycle", () => {
  test("projects the existing job statuses without changing their public meaning", () => {
    const statuses = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted"] as const

    expect(statuses.map((status) => ComputeLifecycle.legacy(ComputeLifecycle.from(status)))).toEqual([...statuses])
  })

  test("moves one approved job through launch, execution, delivery, and teardown", () => {
    const planned = ComputeLifecycle.initial()
    const approval = ComputeLifecycle.transition(planned, { type: "review" })
    const queued = ComputeLifecycle.transition(approval, { type: "approve" })
    const starting = ComputeLifecycle.transition(queued, { type: "start" })
    const running = ComputeLifecycle.transition(starting, { type: "run" })
    const finished = ComputeLifecycle.transition(running, { type: "finish", outcome: "succeeded" })
    const collecting = ComputeLifecycle.transition(finished, { type: "collect" })
    const delivered = ComputeLifecycle.transition(collecting, { type: "deliver" })
    const closed = ComputeLifecycle.transition(delivered, { type: "close" })

    expect(closed).toEqual({
      execution: "succeeded",
      delivery: "complete",
      resource: "closed",
      recoverable: false,
    })
    expect(ComputeLifecycle.legacy(closed)).toBe("succeeded")
    expect(ComputeLifecycle.terminal(closed)).toBe(true)
  })

  test("keeps execution and delivery independent when a deadline preserves partial outputs", () => {
    const running = ComputeLifecycle.transition(
      ComputeLifecycle.transition(ComputeLifecycle.initial(), { type: "queue" }),
      {
        type: "run",
      },
    )
    const timed = ComputeLifecycle.transition(running, { type: "finish", outcome: "timed_out" })
    const collecting = ComputeLifecycle.transition(timed, { type: "collect" })
    const delivered = ComputeLifecycle.transition(collecting, { type: "deliver" })

    expect(delivered).toMatchObject({
      execution: "timed_out",
      delivery: "complete",
      deadline_fired: true,
    })
    expect(ComputeLifecycle.legacy(delivered)).toBe("failed")
  })

  test("protects a remote resource while it holds the only recoverable output", () => {
    const active = ComputeLifecycle.State.parse({
      execution: "succeeded",
      delivery: "pending",
      resource: "active",
      recoverable: false,
    })
    const failed = ComputeLifecycle.transition(active, {
      type: "delivery_fail",
      message: "The result stream stopped before completion.",
    })

    expect(failed).toMatchObject({
      delivery: "failed",
      resource: "active",
      recoverable: true,
      error_kind: "harvest_failed",
    })
    expect(() => ComputeLifecycle.transition(failed, { type: "close" })).toThrow("only recoverable copy")

    const retrying = ComputeLifecycle.transition(failed, { type: "retry_delivery" })
    expect(retrying).toMatchObject({ delivery: "pending", recoverable: true })
    expect(ComputeLifecycle.transition(retrying, { type: "deliver" })).toMatchObject({
      delivery: "complete",
      recoverable: false,
    })

    const abandoned = ComputeLifecycle.transition(failed, { type: "abandon" })
    expect(ComputeLifecycle.transition(abandoned, { type: "close" }).resource).toBe("closed")
  })

  test("rejects impossible transitions instead of manufacturing history", () => {
    expect(() =>
      ComputeLifecycle.transition(ComputeLifecycle.initial(), { type: "finish", outcome: "succeeded" }),
    ).toThrow("planned → finish")
    expect(() => ComputeLifecycle.transition(ComputeLifecycle.from("succeeded"), { type: "run" })).toThrow(
      "succeeded → run",
    )
  })

  test("records an interrupted resource as unknown rather than closed", () => {
    const running = ComputeLifecycle.from("running")
    const interrupted = ComputeLifecycle.transition(running, { type: "interrupt" })

    expect(interrupted).toMatchObject({ execution: "interrupted", resource: "unknown" })
  })
})
