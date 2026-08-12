import { describe, expect, test } from "bun:test"
import { blankConnectorForm, buildConnectorConfig, connectorFormFromConfig, connectorIdentity } from "./connector-form"

describe("Connector Settings form behavior", () => {
  test("turns a quoted local command and environment fields into the persisted MCP payload", () => {
    const state = {
      ...blankConnectorForm("local"),
      name: "filesystem",
      command: 'npx -y "@modelcontextprotocol/server-filesystem" "/tmp/research data"',
      env: '{"TOKEN":"secret"}',
      timeout: "5000",
    }

    expect(buildConnectorConfig(state)).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp/research data"],
      environment: { TOKEN: "secret" },
      timeout: 5000,
    })
  })

  test("round-trips masked remote secrets without exposing or erasing the saved values", () => {
    const original = {
      type: "remote" as const,
      url: "https://mcp.example.org/mcp",
      headers: { Authorization: "Bearer original" },
      oauth: { clientId: "client", clientSecret: "original-secret", scope: "tools" },
    }
    const form = connectorFormFromConfig("remote", original)

    expect(form.headers).toContain("••••••••")
    expect(form.clientSecret).toBe("••••••••")
    expect(buildConnectorConfig(form)).toEqual(original)
  })

  test("rejects invalid JSON, URLs, and timeout values before an SDK write", () => {
    expect(() =>
      buildConnectorConfig({ ...blankConnectorForm("local"), command: "node server.js", env: "[]" }),
    ).toThrow("Environment must be a JSON object")
    expect(() => buildConnectorConfig({ ...blankConnectorForm("remote"), url: "not a url" })).toThrow(
      "Remote URL is invalid",
    )
    expect(() =>
      buildConnectorConfig({ ...blankConnectorForm("remote"), url: "https://mcp.example.org", timeout: "1.5" }),
    ).toThrow("Timeout must be a positive whole number")
  })

  test("uses recognizable connector identities and transport-specific fallbacks", () => {
    expect(
      connectorIdentity("code", {
        type: "remote",
        url: "https://api.github.com/mcp",
      }),
    ).toEqual({ icon: "github", label: "GitHub" })
    expect(
      connectorIdentity("research files", {
        type: "local",
        command: ["npx", "@modelcontextprotocol/server-filesystem", "."],
      }),
    ).toEqual({ icon: "folder", label: "Filesystem" })
    expect(
      connectorIdentity("literature", {
        type: "remote",
        url: "https://mcp.example.org/mcp",
      }),
    ).toEqual({ icon: "cloud", label: "Hosted server" })
    expect(
      connectorIdentity("analysis", {
        type: "local",
        command: ["uvx", "analysis-mcp"],
      }),
    ).toEqual({ icon: "console", label: "Local process" })
  })
})
