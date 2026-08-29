import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import fs from "node:fs/promises"

const server = new McpServer({ name: "capability-test", version: "1.0.0" })

server.registerTool(
  "echo",
  {
    description: "Echo a value",
  },
  async () => {
    const ready = process.env.OPENSCIENCE_MCP_REQUEST_READY
    const release = process.env.OPENSCIENCE_MCP_REQUEST_RELEASE
    if (ready && release) {
      await fs.writeFile(ready, "ready")
      for (let attempt = 0; attempt < 500; attempt++) {
        if (
          await fs.stat(release).then(
            () => true,
            () => false,
          )
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    return {
      content: [{ type: "text", text: "ok" }],
    }
  },
)

server.registerResource(
  "guide",
  "memory://guide",
  {
    description: "Connector guide",
    mimeType: "text/plain",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, text: "guide" }],
  }),
)

server.registerPrompt(
  "review",
  {
    description: "Review a result",
  },
  async () => ({
    messages: [{ role: "user", content: { type: "text", text: "review" } }],
  }),
)

await server.connect(new StdioServerTransport())
