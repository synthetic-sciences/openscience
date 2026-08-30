import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  blankConnectorForm,
  buildConnectorConfig,
  catalogPresetConfig,
  connectorFormFromCatalog,
  connectorFormFromConfig,
  connectorConflictsWithCatalogPreset,
  connectorIdentity,
  connectorMatchesCatalogSetup,
} from "./connector-form"

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

  test("prefills reviewed catalog setup without saving or enabling it", () => {
    const form = connectorFormFromCatalog({
      type: "remote",
      name: "box",
      url: "https://mcp.box.com",
      oauth: "client",
      scope: "item_readwrite",
    })

    expect(form).toMatchObject({
      type: "remote",
      name: "box",
      url: "https://mcp.box.com",
      oauth: "client",
      scope: "item_readwrite",
      initiallyDisabled: true,
      requireClientSecret: false,
    })
    expect(form.previous).toBeUndefined()
    expect(buildConnectorConfig({ ...form, clientId: "box-client" })).toMatchObject({ enabled: false })
    expect(
      connectorMatchesCatalogSetup(buildConnectorConfig({ ...form, clientId: "box-client" }), {
        type: "remote",
        url: form.url,
        oauth: "client",
        scope: form.scope,
      }),
    ).toBe(true)
    expect(
      connectorMatchesCatalogSetup(
        { type: "remote", url: "https://attacker.example/mcp" },
        { type: "remote", url: "https://mcp.box.com", oauth: "client" },
      ),
    ).toBe(false)
    expect(
      connectorMatchesCatalogSetup(
        { type: "remote", url: "https://mcp.box.com", oauth: false },
        { type: "remote", url: "https://mcp.box.com", oauth: "client" },
      ),
    ).toBe(false)
    expect(() =>
      buildConnectorConfig({
        ...form,
        clientId: "box-client",
        clientSecret: "",
        requireClientSecret: true,
      }),
    ).toThrow("OAuth client secret is required")
  })

  test("keeps the recommended preset disabled without starting OAuth", () => {
    const setup = {
      type: "remote",
      name: "givemeanode",
      url: "https://mcp.givemeanode.com",
      oauth: "auto",
      one_click_connect: true,
    } as const
    const config = catalogPresetConfig(setup)

    expect(config).toEqual({
      type: "remote",
      url: "https://mcp.givemeanode.com",
      oauth: {},
      enabled: false,
    })
    expect(JSON.stringify(config)).not.toMatch(/api[_-]?key|authorization|clientSecret/i)
    expect(connectorConflictsWithCatalogPreset(undefined, setup)).toBe(false)
    expect(connectorConflictsWithCatalogPreset(config, setup)).toBe(false)
    expect(connectorConflictsWithCatalogPreset({ ...config, headers: { Authorization: "Bearer custom" } }, setup)).toBe(
      true,
    )
    expect(connectorConflictsWithCatalogPreset({ ...config, timeout: 60_000 }, setup)).toBe(true)
    expect(
      connectorConflictsWithCatalogPreset({ type: "remote", url: "https://different.example", oauth: {} }, setup),
    ).toBe(true)
    expect(() =>
      catalogPresetConfig({
        type: "remote",
        name: "manual",
        url: "https://mcp.example.com",
        oauth: "auto",
      }),
    ).toThrow("requires setup review")
  })

  test("runs the recommended preset as setup, browser OAuth, inspection, with rollback on failure", () => {
    const source = readFileSync(new URL("./Connectors.tsx", import.meta.url), "utf8")
    const start = source.indexOf("async function addCatalogPreset")
    const end = source.indexOf("function editConnector", start)
    const preset = source.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(preset).toContain("catalogPresetConfig(setup)")
    expect(preset).toContain("sdk.client.mcp.config.set")
    expect(preset).toContain("beginAuthentication(setup.name)")
    expect(preset).toContain("await inspect(setup.name)")
    expect(preset).toContain('.remove({ name: setup.name, scope: "global" })')
  })

  test("treats an already-authorized start as settled instead of waiting on a dead browser flow", () => {
    const source = readFileSync(new URL("./Connectors.tsx", import.meta.url), "utf8")
    const start = source.indexOf("async function beginAuthentication")
    const end = source.indexOf("async function restorePendingAuthorizations", start)
    const authentication = source.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(authentication).toContain('started.state === "settled"')
    expect(authentication).toContain("acceptAuthenticationResult(name, started.result)")
    expect(authentication).toContain("waitForAuthentication(name, started)")
  })

  test("uses recognizable connector identities and transport-specific fallbacks", () => {
    expect(
      connectorIdentity("code", {
        type: "remote",
        url: "https://api.github.com/mcp",
      }),
    ).toEqual({ icon: "github", label: "GitHub", providerLogo: "github" })
    expect(
      connectorIdentity("givemeanode", {
        type: "remote",
        url: "https://mcp.givemeanode.com",
      }),
    ).toEqual({ icon: "cloud", label: "GiveMeANode", providerLogo: "givemeanode" })
    expect(
      connectorIdentity("box", {
        type: "remote",
        url: "https://mcp.box.com",
      }),
    ).toEqual({ icon: "cloud", label: "Box", providerLogo: "box" })
    expect(
      connectorIdentity("lab records", {
        type: "remote",
        url: "https://tenant.mcp.benchling.com/mcp",
      }),
    ).toEqual({ icon: "cloud", label: "Benchling", providerLogo: "benchling" })
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
    ).toEqual({ icon: "cloud", label: "Remote server" })
    expect(
      connectorIdentity("analysis", {
        type: "local",
        command: ["uvx", "analysis-mcp"],
      }),
    ).toEqual({ icon: "console", label: "Local process" })
  })

  test("keeps connection truth visible in narrow layouts", () => {
    const css = readFileSync(new URL("./connectors.css", import.meta.url), "utf8")
    expect(css).not.toMatch(/\.connectors-status\s*\{\s*display:\s*none/u)
    expect(css).toContain(".connectors-status {\n    grid-column: 2;\n    grid-row: 2;")
  })
})
