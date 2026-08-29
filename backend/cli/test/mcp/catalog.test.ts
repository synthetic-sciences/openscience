import { describe, expect, test } from "bun:test"
import { ConnectorCatalog } from "../../src/mcp/catalog"

describe("connector catalog", () => {
  test("lists five reviewed setup records without claiming write-back", () => {
    const entries = ConnectorCatalog.list()
    expect(entries.map((entry) => entry.id)).toEqual(["github", "benchling", "box", "dropbox", "s3"])
    expect(entries.every((entry) => entry.writes_enabled_by_catalog === false)).toBe(true)
    expect(entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.revision))).toBe(true)
    const benchling = entries.find((entry) => entry.id === "benchling")
    expect(benchling?.status).toBe("manual_review")
    expect(benchling?.setup).toBeUndefined()
    expect(benchling?.source_url).toContain("help.benchling.com")
    expect(benchling?.requirements).toContain("The exact https://<tenant>.mcp.benchling.com/mcp endpoint")
  })

  test("prefills only official remote endpoints and never credentials", () => {
    const github = ConnectorCatalog.get("github")
    const box = ConnectorCatalog.get("box")
    const s3 = ConnectorCatalog.get("s3")
    expect(github?.setup).toEqual({
      type: "remote",
      name: "github",
      url: "https://api.githubcopilot.com/mcp/",
      oauth: "auto",
    })
    expect(box?.setup).toMatchObject({ url: "https://mcp.box.com", oauth: "client" })
    expect(s3?.setup?.url).toContain("aws-mcp.us-east-1.api.aws")
    expect(JSON.stringify(ConnectorCatalog.list())).not.toMatch(/client_secret|api_key|access_token/i)
  })
})
