import fs from "node:fs/promises"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const marker = process.env.OPENSCIENCE_MCP_LIST_MARKER
if (!marker) throw new Error("OPENSCIENCE_MCP_LIST_MARKER is required")

const server = new Server(
  { name: "tool-cache-test", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await fs.appendFile(marker, "list\n")
  return {
    tools: [
      {
        name: "echo",
        description: "Echo a value",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: String(request.params.arguments?.value ?? "") }],
}))

await server.connect(new StdioServerTransport())
