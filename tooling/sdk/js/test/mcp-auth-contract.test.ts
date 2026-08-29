import assert from "node:assert/strict"
import { test } from "node:test"
import { createOpenScienceClient } from "../src/v2/client.js"
import type { McpAuthStartResponse } from "../src/v2/gen/types.gen.js"

const pending: McpAuthStartResponse = {
  state: "pending",
  authorizationUrl: "https://provider.example/authorize",
  flowId: "flow_exact",
}

const settled: McpAuthStartResponse = {
  state: "settled",
  result: { status: "connected" },
}

const resumable = {
  pending: true as const,
  authorizationUrl: "https://provider.example/authorize",
  flowId: "flow_exact",
}

test("generated MCP OAuth client preserves start, pending, wait, and exact cancel requests", async () => {
  const requests: Request[] = []
  const responses = [pending, resumable, { status: "connected" }, { success: true }, settled] as const
  const client = createOpenScienceClient({
    baseUrl: "http://sdk.test",
    throwOnError: true,
    fetch: async (input) => {
      requests.push(input instanceof Request ? input : new Request(input))
      return Response.json(responses[requests.length - 1])
    },
  })

  const started = await client.mcp.auth.start({ name: "givemeanode" }, { throwOnError: true })
  assert.deepEqual(started.data, pending)
  if (started.data.state !== "pending") throw new Error("Expected a pending OAuth start")
  assert.equal(started.data.flowId, "flow_exact")

  const resumed = await client.mcp.auth.pending({ name: "givemeanode" }, { throwOnError: true })
  assert.deepEqual(resumed.data, resumable)
  if (!resumed.data.pending) throw new Error("Expected a resumable OAuth flow")
  assert.equal(resumed.data.flowId, "flow_exact")

  await client.mcp.auth.wait({ name: "givemeanode", flow_id: "flow_exact" }, { throwOnError: true })
  await client.mcp.auth.cancel({ name: "givemeanode", flow_id: "flow_exact" }, { throwOnError: true })
  const restarted = await client.mcp.auth.start({ name: "givemeanode" }, { throwOnError: true })
  assert.deepEqual(restarted.data, settled)
  if (restarted.data.state !== "settled") throw new Error("Expected a settled OAuth start")
  assert.equal(restarted.data.result.status, "connected")

  assert.deepEqual(
    requests.map((request) => ({
      method: request.method,
      url: request.url,
    })),
    [
      { method: "POST", url: "http://sdk.test/mcp/givemeanode/auth" },
      { method: "GET", url: "http://sdk.test/mcp/givemeanode/auth/pending" },
      { method: "POST", url: "http://sdk.test/mcp/givemeanode/auth/wait?flow_id=flow_exact" },
      { method: "DELETE", url: "http://sdk.test/mcp/givemeanode/auth/pending?flow_id=flow_exact" },
      { method: "POST", url: "http://sdk.test/mcp/givemeanode/auth" },
    ],
  )
})
