import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { CapabilityEvidence } from "../../src/science/capability/evidence"
import {
  cleanupScientificCapabilityCanaryJob,
  createScientificCapabilityCanaryContext,
  runScientificCapabilityCanary,
} from "../../src/science/capability/canary"
import { tmpdir } from "../fixture/fixture"

function result(
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted",
  output = "{}",
  target: "local" | "modal" = "local",
  closed = false,
) {
  return {
    title: "canary",
    output,
    metadata: {
      compute_job: {
        job: {
          id: "capability-canary-job",
          name: "Capability canary",
          command: "python smoke.py",
          target: { kind: target },
          target_label: target === "local" ? "Local" : "Modal",
          scheduler: "none",
          status,
          created_at: "2026-08-28T00:00:00.000Z",
          ...(closed
            ? {
                lifecycle: {
                  execution: status,
                  delivery: "complete",
                  resource: "closed",
                  recoverable: false,
                },
              }
            : {}),
        },
      },
    },
  }
}

function context() {
  return {
    sessionID: "ses_capability_canary",
    messageID: "msg_capability_canary",
    callID: "prt_capability_canary",
    agent: "research",
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
  }
}

function deliveryResult(
  status: "succeeded" | "failed",
  delivery: "pending" | "complete" | "failed" | "rejected",
  captureError?: string,
) {
  const output = result(status, "{}", "modal")
  return {
    ...output,
    metadata: {
      compute_job: {
        job: {
          ...output.metadata.compute_job.job,
          lifecycle: {
            execution: status,
            delivery,
            resource: "active",
            recoverable: delivery === "failed" || delivery === "rejected",
          },
          ...(captureError ? { capture_error: captureError } : {}),
        },
      },
    },
  }
}

function deliveryCanary(
  states: Array<ReturnType<typeof result> | ReturnType<typeof deliveryResult>>,
  timeoutSeconds = 30,
) {
  const actions: string[] = []
  const tool = {
    async execute(input: { action: string }) {
      actions.push(input.action)
      if (input.action === "doctor") return { title: "doctor", output: "{}", metadata: {} }
      if (input.action === "smoke") return result("running", "{}", "modal")
      if (input.action === "status" || input.action === "wait") {
        const state = states.shift()
        if (!state) throw new Error("unexpected additional wait")
        return state
      }
      if (input.action === "logs") return { title: "logs", output: "bounded canary log", metadata: {} }
      if (input.action === "artifacts" || input.action === "verify")
        return { title: input.action, output: "{}", metadata: {} }
      if (input.action === "release") return result("succeeded", "{}", "modal", true)
      throw new Error(`unexpected ${input.action}`)
    },
  }
  return {
    actions,
    run: () =>
      runScientificCapabilityCanary({
        tool: tool as never,
        ctx: context() as never,
        id: "matplotlib",
        target: "modal",
        timeoutSeconds,
      }),
  }
}

describe("scientific capability release canary", () => {
  test("binds release evidence to the source embedded in the artifact", () => {
    const source = "a".repeat(40)
    expect(CapabilityEvidence.releaseSource({ artifactSource: source, declaredSource: source })).toBe(source)
    expect(() => CapabilityEvidence.releaseSource({ artifactSource: source, declaredSource: "b".repeat(40) })).toThrow(
      "release source mismatch",
    )
    expect(CapabilityEvidence.releaseSource({ declaredSource: source })).toBeUndefined()
    expect(() => CapabilityEvidence.releaseSource({ artifactVersion: "2.0.54", declaredSource: source })).toThrow(
      "artifact does not embed a release source",
    )
    expect(() => CapabilityEvidence.releaseSource({ artifactSource: source, declaredSource: "not-a-sha" })).toThrow(
      "not an exact lowercase Git SHA",
    )
    expect(() =>
      CapabilityEvidence.releaseSource({
        artifactSource: source,
        declaredSource: source,
        githubSource: "b".repeat(40),
      }),
    ).toThrow("release source mismatch")
    expect(() => CapabilityEvidence.releaseSource({ artifactSource: "not-a-sha" })).toThrow(
      "artifact source is invalid",
    )
  })

  test("creates a provider-free internal tool context on a clean installation", async () => {
    await using tmp = await tmpdir()
    const originalFetch = globalThis.fetch
    let fetches = 0
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      fetches++
      throw new Error("the non-inference canary context must not use the network")
    }) as unknown as typeof fetch
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ctx = await createScientificCapabilityCanaryContext({
            name: "research",
            mode: "all",
            permission: [],
            options: {},
            native: true,
          } as never)
          const messages = await Session.messages({ sessionID: ctx.sessionID })
          const assistant = messages.flatMap((message) => message.info).find((message) => message.role === "assistant")
          expect(assistant).toMatchObject({
            providerID: "openscience-internal",
            modelID: "scientific-capability-canary",
          })
        },
      })
      expect(fetches).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("runs setup, the bounded smoke, verification, and terminal cleanup", async () => {
    const actions: string[] = []
    const tool = {
      async execute(input: { action: string }) {
        actions.push(input.action)
        if (input.action === "setup") return { title: "setup", output: "{}", metadata: {} }
        if (input.action === "doctor") return { title: "doctor", output: '{"state":"ready"}', metadata: {} }
        if (input.action === "smoke") return result("running")
        if (input.action === "status") return result("running")
        if (input.action === "wait") return result("succeeded")
        if (input.action === "logs") return { title: "logs", output: "smoke ok", metadata: {} }
        if (input.action === "artifacts") {
          return { title: "artifacts", output: '{"artifacts":["capability-result.json"]}', metadata: {} }
        }
        if (input.action === "verify") {
          return {
            title: "verified",
            output: JSON.stringify({ validation: { ok: true }, evidence: { release_sha: "a".repeat(40) } }),
            metadata: {},
          }
        }
        throw new Error(`unexpected ${input.action}`)
      },
    }

    const output = await runScientificCapabilityCanary({
      tool: tool as never,
      ctx: context() as never,
      id: "scipy",
      target: "local",
      timeoutSeconds: 30,
    })

    expect(actions).toEqual(["setup", "doctor", "smoke", "status", "wait", "logs", "artifacts", "verify"])
    expect(output).toMatchObject({
      capability: "scipy",
      target: "local",
      job_id: "capability-canary-job",
      status: "succeeded",
      doctor: { state: "ready" },
      logs: "smoke ok",
      artifacts: { artifacts: ["capability-result.json"] },
      verification: { validation: { ok: true } },
      cleanup: { status: "not_applicable" },
    })
  })

  test("reports bounded logs and releases a failed terminal job without redispatching", async () => {
    const actions: string[] = []
    const tool = {
      async execute(input: { action: string }) {
        actions.push(input.action)
        if (input.action === "doctor") return { title: "doctor", output: '{"state":"configured"}', metadata: {} }
        if (input.action === "smoke") return result("running", "{}", "modal")
        if (input.action === "status") return result("running", "{}", "modal")
        if (input.action === "wait") return result("failed", "{}", "modal")
        if (input.action === "logs") return { title: "logs", output: "bounded failure log", metadata: {} }
        if (input.action === "release") return result("failed", "{}", "modal", true)
        throw new Error(`unexpected ${input.action}`)
      },
    }

    await expect(
      runScientificCapabilityCanary({
        tool: tool as never,
        ctx: context() as never,
        id: "rdkit",
        target: "modal",
        timeoutSeconds: 30,
      }),
    ).rejects.toThrow("bounded failure log")
    expect(actions).toEqual(["doctor", "smoke", "status", "wait", "logs", "release"])
  })

  test.each(["status", "wait"])("waits for artifact delivery after %s reports success", async (first) => {
    const pending = deliveryResult("succeeded", "pending")
    const complete = deliveryResult("succeeded", "complete")
    const states = [...(first === "wait" ? [result("running", "{}", "modal")] : []), pending, pending, complete]
    const canary = deliveryCanary(states)
    await expect(canary.run()).resolves.toMatchObject({ status: "succeeded", cleanup: { status: "closed" } })
    expect(canary.actions).toEqual([
      "doctor",
      "smoke",
      "status",
      ...Array.from({ length: first === "wait" ? 3 : 2 }, () => "wait"),
      "logs",
      "artifacts",
      "verify",
      "release",
    ])
  })

  test.each([
    { delivery: "failed" as const, captureError: undefined, error: "failed" },
    { delivery: "rejected" as const, captureError: undefined, error: "rejected" },
    { delivery: "complete" as const, captureError: "immutable capture failed", error: "immutable capture failed" },
  ])("fails $delivery delivery without verification or retry", async ({ delivery, captureError, error }) => {
    const canary = deliveryCanary([
      deliveryResult("succeeded", "pending"),
      deliveryResult("succeeded", delivery, captureError),
    ])
    await expect(canary.run()).rejects.toThrow(`could not deliver its artifacts: ${error}.\nbounded canary log`)
    expect(canary.actions).toEqual(["doctor", "smoke", "status", "wait", "logs", "release"])
  })

  test("times out pending delivery without cancelling completed execution", async () => {
    const canary = deliveryCanary([deliveryResult("succeeded", "pending")], 0)
    await expect(canary.run()).rejects.toThrow("timed out")
    expect(canary.actions).toEqual(["doctor", "smoke", "status", "release"])
  })

  test("cancels and releases a running job when the bounded deadline expires", async () => {
    const actions: string[] = []
    const tool = {
      async execute(input: { action: string }) {
        actions.push(input.action)
        if (input.action === "doctor") return { title: "doctor", output: '{"state":"configured"}', metadata: {} }
        if (input.action === "smoke" || input.action === "status") return result("running", "{}", "modal")
        if (input.action === "cancel") return result("cancelled", "{}", "modal")
        if (input.action === "release") return result("cancelled", "{}", "modal", true)
        throw new Error(`unexpected ${input.action}`)
      },
    }

    await expect(
      runScientificCapabilityCanary({
        tool: tool as never,
        ctx: context() as never,
        id: "matplotlib",
        target: "modal",
        timeoutSeconds: 0,
      }),
    ).rejects.toThrow("timed out")
    expect(actions).toEqual(["doctor", "smoke", "status", "cancel", "release"])
  })

  test("fails a valid Modal canary on retained resources and allows an explicit release retry", async () => {
    const actions: string[] = []
    const tool = {
      async execute(input: { action: string }) {
        actions.push(input.action)
        if (input.action === "doctor") return { title: "doctor", output: '{"state":"configured"}', metadata: {} }
        if (input.action === "smoke" || input.action === "status") return result("succeeded", "{}", "modal")
        if (input.action === "logs") return { title: "logs", output: "smoke ok", metadata: {} }
        if (input.action === "artifacts") return { title: "artifacts", output: '{"artifacts":[]}', metadata: {} }
        if (input.action === "verify") {
          return { title: "verified", output: '{"validation":{"ok":true}}', metadata: {} }
        }
        if (input.action === "release") throw new Error("provider release unavailable")
        throw new Error(`unexpected ${input.action}`)
      },
    }

    await expect(
      runScientificCapabilityCanary({
        tool: tool as never,
        ctx: context() as never,
        id: "biopython",
        target: "modal",
        timeoutSeconds: 30,
      }),
    ).rejects.toThrow(
      "produced valid evidence but could not close paid resources for job capability-canary-job: provider release unavailable",
    )
    expect(actions.filter((action) => action === "release")).toHaveLength(1)

    const retryActions: string[] = []
    const retry = await cleanupScientificCapabilityCanaryJob({
      tool: {
        async execute(input: { action: string }) {
          retryActions.push(input.action)
          if (input.action === "status") return result("succeeded", "{}", "modal")
          if (input.action === "release") return result("succeeded", "{}", "modal", true)
          throw new Error(`unexpected ${input.action}`)
        },
      } as never,
      ctx: context() as never,
      id: "biopython",
      jobID: "capability-canary-job",
    })
    expect(retryActions).toEqual(["status", "release"])
    expect(retry).toMatchObject({ status: "closed", job: { id: "capability-canary-job" } })
  })
})
