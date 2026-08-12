import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"

const marker = process.env.OPENSCIENCE_MCP_DESCENDANT_MARKER
if (!marker) throw new Error("Missing MCP descendant marker")
const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
})
escaped.unref()
await fs.writeFile(marker, String(escaped.pid))

const server = new McpServer({ name: "descendant-test", version: "1.0.0" })
server.registerTool("alive", { description: "Keeps the fixture connected" }, async () => ({
  content: [{ type: "text", text: "ok" }],
}))
await server.connect(new StdioServerTransport())
