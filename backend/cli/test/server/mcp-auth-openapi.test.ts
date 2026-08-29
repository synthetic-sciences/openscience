import { expect, test } from "bun:test"
import path from "node:path"
import { Server } from "../../src/server/server"

type Operation = {
  operationId?: string
  parameters?: Array<{ in?: string; name?: string; required?: boolean; schema?: unknown }>
}

type Spec = {
  paths: Record<string, Partial<Record<"get" | "post" | "delete", Operation>>>
  components?: {
    schemas?: Record<string, unknown>
  }
}

function operation(spec: Spec, route: string, method: "get" | "post" | "delete") {
  const found = spec.paths[route]?.[method]
  expect(found).toBeDefined()
  return found!
}

function assertContract(spec: Spec) {
  expect(operation(spec, "/mcp/{name}/auth", "post").operationId).toBe("mcp.auth.start")
  expect(operation(spec, "/mcp/{name}/auth/pending", "get").operationId).toBe("mcp.auth.pending")

  for (const [route, method, id] of [
    ["/mcp/{name}/auth/wait", "post", "mcp.auth.wait"],
    ["/mcp/{name}/auth/pending", "delete", "mcp.auth.cancel"],
  ] as const) {
    const found = operation(spec, route, method)
    expect(found.operationId).toBe(id)
    expect(found.parameters).toContainEqual({
      in: "query",
      name: "flow_id",
      required: true,
      schema: { type: "string", minLength: 1 },
    })
  }

  expect(spec.components?.schemas?.MCPAuthStart).toEqual({
    anyOf: [
      {
        type: "object",
        properties: {
          state: { type: "string", const: "pending" },
          authorizationUrl: { type: "string" },
          flowId: { type: "string" },
        },
        required: ["state", "authorizationUrl", "flowId"],
      },
      {
        type: "object",
        properties: {
          state: { type: "string", const: "settled" },
          result: { $ref: "#/components/schemas/MCPStatus" },
        },
        required: ["state", "result"],
      },
    ],
  })

  expect(spec.components?.schemas?.MCPAuthPending).toEqual({
    anyOf: [
      {
        type: "object",
        properties: {
          pending: { type: "boolean", const: true },
          authorizationUrl: { type: "string" },
          flowId: { type: "string" },
        },
        required: ["pending", "authorizationUrl", "flowId"],
      },
      {
        type: "object",
        properties: {
          pending: { type: "boolean", const: false },
        },
        required: ["pending"],
      },
    ],
  })
}

test("live and published OpenAPI expose the exact resumable MCP OAuth lifecycle", async () => {
  const root = path.resolve(import.meta.dir, "../../../..")
  const live = (await Server.openapi()) as unknown as Spec
  const repeated = (await Server.openapi()) as unknown as Spec
  const published = JSON.parse(await Bun.file(path.join(root, "tooling/sdk/openapi.json")).text()) as Spec

  assertContract(live)
  assertContract(repeated)
  assertContract(published)
  expect(repeated.components?.schemas?.MCPAuthStart).toEqual(live.components?.schemas?.MCPAuthStart)
  expect(repeated.components?.schemas?.MCPAuthPending).toEqual(live.components?.schemas?.MCPAuthPending)
  expect(published.components?.schemas?.MCPAuthStart).toEqual(live.components?.schemas?.MCPAuthStart)
  expect(published.components?.schemas?.MCPAuthPending).toEqual(live.components?.schemas?.MCPAuthPending)
})
