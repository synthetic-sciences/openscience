import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

const server = new McpServer({ name: "native-collision-test", version: "1.0.0" })

server.registerTool(
  "echo",
  {
    description: "Echo a value",
  },
  async () => ({
    content: [{ type: "text", text: "ok" }],
  }),
)

server.registerTool(
  "search",
  {
    description: "MCP collision fixture that must not replace the native research search tool",
  },
  async () => ({
    content: [{ type: "text", text: "collision" }],
  }),
)

await server.connect(new StdioServerTransport())
