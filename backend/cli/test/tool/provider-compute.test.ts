import { expect, test } from "bun:test"
import { ProviderCli } from "../../src/compute/provider-cli"
import { createProviderComputeTool, ProviderComputeParameters } from "../../src/tool/provider-compute"
import type { Tool } from "../../src/tool/tool"

function context(ask: Tool.Context["ask"], abort = new AbortController().signal): Tool.Context {
  return {
    sessionID: "session_provider_compute",
    messageID: "message_provider_compute",
    agent: "research",
    abort,
    messages: [],
    metadata() {},
    ask,
  }
}

test("provider_compute admits only the reviewed read-only argument grammar", () => {
  expect(ProviderComputeParameters.safeParse({ provider: "runpod", operation: "list_resources" }).success).toBe(true)
  expect(
    ProviderComputeParameters.safeParse({ provider: "runpod", operation: "resource_status", resource_id: "pod-123" })
      .success,
  ).toBe(true)
  expect(ProviderComputeParameters.safeParse({ provider: "runpod", operation: "create" }).success).toBe(false)
  expect(ProviderComputeParameters.safeParse({ provider: "runpod", operation: "resource_status" }).success).toBe(false)
  expect(
    ProviderComputeParameters.safeParse({ provider: "runpod", operation: "account", resource_id: "pod-123" }).success,
  ).toBe(false)
  expect(
    ProviderComputeParameters.safeParse({
      provider: "runpod",
      operation: "resource_status",
      resource_id: "pod-123; delete everything",
    }).success,
  ).toBe(false)
})

test("provider_compute owns every executable and exact official read argv", () => {
  const contracts: [ProviderCli.Provider, ProviderCli.Operation, string | undefined, string][] = [
    ["tensorpool", "list_resources", undefined, "tp cluster list"],
    ["tensorpool", "job_status", "job_123", "tp job info job_123"],
    ["lambda", "list_availability", undefined, "curl GET https://cloud.lambda.ai/api/v1/instance-types"],
    ["lambda", "resource_status", "instance:123", "curl GET https://cloud.lambda.ai/api/v1/instances/instance%3A123"],
    ["prime_intellect", "list_resources", undefined, "prime pods list"],
    ["prime_intellect", "resource_status", "pod_123", "prime pods status pod_123"],
    ["vast", "list_resources", undefined, "vastai show instances --raw"],
    ["vast", "resource_status", "123", "vastai show instance 123 --raw"],
    ["runpod", "list_resources", undefined, "runpodctl pod list --all"],
    ["runpod", "resource_status", "pod-123", "runpodctl pod get pod-123"],
  ]
  for (const [provider, operation, id, command] of contracts) {
    expect(ProviderCli.preview(provider, operation, id).command).toBe(command)
  }
  expect(() => ProviderCli.preview("vast", "list_availability")).toThrow("does not support")
  expect(() => ProviderCli.preview("lambda", "resource_status", "../../account")).toThrow("requires")
})

test("provider_compute asks on the exact read before resolving a saved credential and forwards cancellation", async () => {
  const asked: Parameters<Tool.Context["ask"]>[0][] = []
  const calls: unknown[][] = []
  const controller = new AbortController()
  const tool = await createProviderComputeTool({
    preview: ProviderCli.preview,
    async execute(provider, operation, resourceID, options) {
      calls.push([provider, operation, resourceID, options?.signal])
      return {
        ok: true,
        provider: "runpod",
        operation: "resource_status",
        cli: "runpodctl",
        command: "runpodctl pod get pod-123",
        checked_at: "2026-08-29T00:00:00.000Z",
        output: '{"id":"pod-123","status":"RUNNING"}',
      }
    },
  }).init()

  const result = await tool.execute(
    { provider: "runpod", operation: "resource_status", resource_id: "pod-123" },
    context(async (request) => {
      expect(calls).toHaveLength(0)
      asked.push(request)
    }, controller.signal),
  )

  expect(asked).toEqual([
    expect.objectContaining({
      permission: "provider_compute",
      patterns: ["runpod:resource_status:pod-123"],
      always: ["runpod:resource_status:*"],
      metadata: expect.objectContaining({
        provider_compute: expect.objectContaining({ read_only: true, command: "runpodctl pod get pod-123" }),
      }),
    }),
  ])
  expect(calls).toEqual([["runpod", "resource_status", "pod-123", controller.signal]])
  expect(JSON.parse(result.output)).toMatchObject({
    ok: true,
    provider: "runpod",
    operation: "resource_status",
    result: '{"id":"pod-123","status":"RUNNING"}',
  })
})

test("provider_compute never resolves credentials after a rejected read boundary", async () => {
  let executed = false
  const tool = await createProviderComputeTool({
    preview: ProviderCli.preview,
    async execute() {
      executed = true
      throw new Error("must not execute")
    },
  }).init()

  await expect(
    tool.execute(
      { provider: "vast", operation: "list_resources" },
      context(async () => {
        throw new Error("permission rejected")
      }),
    ),
  ).rejects.toThrow("permission rejected")
  expect(executed).toBe(false)
})
