import { expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { McpRemoteUrl } from "../../src/mcp/remote-url"

test("remote MCP endpoints require confidential transports and header-based credentials", () => {
  for (const url of ["https://mcp.example/tools", "http://127.0.0.1:4096/mcp", "http://localhost:4096/mcp"]) {
    expect(Config.McpRemote.safeParse({ type: "remote", url }).success).toBeTrue()
  }
  for (const url of [
    "http://mcp.example/tools",
    "https://user:password@mcp.example/tools",
    "https://mcp.example/tools?api_key=plaintext",
    "https://mcp.example/tools#token",
  ]) {
    expect(Config.McpRemote.safeParse({ type: "remote", url }).success).toBeFalse()
  }
})

test("discovered OAuth URLs use HTTPS except for explicit loopback development", () => {
  expect(() => McpRemoteUrl.network("https://id.example/authorize?state=opaque")).not.toThrow()
  expect(() =>
    McpRemoteUrl.discovered("http://127.0.0.1:4321/token", "http://localhost:4096/mcp", "OAuth token URL"),
  ).not.toThrow()
  expect(() =>
    McpRemoteUrl.discovered("http://127.0.0.1:4321/token", "https://mcp.example/mcp", "OAuth token URL"),
  ).toThrow(/HTTPS/)
  expect(() => McpRemoteUrl.network("http://id.example/token")).toThrow(/HTTPS/)
  expect(() => McpRemoteUrl.network("https://client:secret@id.example/token")).toThrow(/credentials/)
})
