import { describe, expect, test } from "bun:test"
import { isSshSession, manualOAuthGuidance, needsManualOAuthBrowser } from "../../src/cli/mcp-oauth-guidance"

describe("MCP OAuth CLI guidance", () => {
  test("detects SSH and headless shells without treating an interactive desktop as headless", () => {
    expect(isSshSession({ SSH_CONNECTION: "client 123 server 22" })).toBeTrue()
    expect(isSshSession({ SSH_TTY: "/dev/pts/1" })).toBeTrue()
    expect(needsManualOAuthBrowser({ env: { SSH_CLIENT: "client 123 22" }, stdoutIsTTY: true })).toBeTrue()
    expect(needsManualOAuthBrowser({ env: { CI: "1" }, stdoutIsTTY: true })).toBeTrue()
    expect(needsManualOAuthBrowser({ env: {}, platform: "linux", stdoutIsTTY: true })).toBeTrue()
    expect(needsManualOAuthBrowser({ env: { DISPLAY: ":0" }, platform: "linux", stdoutIsTTY: true })).toBeFalse()
    expect(needsManualOAuthBrowser({ env: {}, platform: "darwin", stdoutIsTTY: true })).toBeFalse()
  })

  test("prints an exact loopback tunnel command without inventing an SSH host", () => {
    const url = "https://identity.example/authorize?state=opaque"
    const lines = manualOAuthGuidance({
      authorizationUrl: url,
      callbackPort: 19876,
      env: { SSH_CONNECTION: "client 123 server 22" },
    })

    expect(lines).toEqual([
      "Open a new terminal on your local computer and forward the OAuth callback port:",
      "ssh -L 19876:127.0.0.1:19876 <your-ssh-destination>",
      "Keep that SSH session open, then open this authorization URL in your local browser:",
      url,
    ])
    expect(lines[1]).not.toMatch(/user@|example\.com|localhost/i)
  })
})
