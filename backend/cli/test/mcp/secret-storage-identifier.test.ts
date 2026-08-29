import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const temporary = new Set<string>()
const moduleUrl = new URL("../../src/mcp/secret-storage.ts", import.meta.url).href

async function root(name: string) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `openscience-mcp-identifier-${name}-`))
  temporary.add(home)
  return {
    home,
    data: path.join(home, "data"),
    config: path.join(home, "config"),
    cache: path.join(home, "cache"),
    state: path.join(home, "state"),
  }
}

async function identifier(
  location: Awaited<ReturnType<typeof root>>,
  domain: "oauth-authority" | "oauth-flow",
  value: string,
) {
  const script = `
    import { McpSecretStorage } from ${JSON.stringify(moduleUrl)}
    process.stdout.write(await McpSecretStorage.identifier(${JSON.stringify(domain)}, ${JSON.stringify(value)}))
  `
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      OPENSCIENCE_DATA_DIR: location.data,
      OPENSCIENCE_CONFIG_DIR: location.config,
      OPENSCIENCE_TEST_HOME: location.home,
      XDG_CACHE_HOME: location.cache,
      XDG_CONFIG_HOME: location.config,
      XDG_DATA_HOME: path.join(location.home, "xdg-data"),
      XDG_STATE_HOME: location.state,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit, stderr).toBe(0)
  return stdout
}

afterAll(async () => {
  await Promise.all([...temporary].map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

test("MCP identifiers remain stable across processes and data-root relocation", async () => {
  const original = await root("original")
  const value = JSON.stringify({ url: "https://mcp.example", headers: { authorization: "secret" } })
  const first = await identifier(original, "oauth-authority", value)
  const sibling = await identifier(original, "oauth-authority", value)
  expect(sibling).toBe(first)

  const relocated = { ...original, data: `${original.data}-relocated` }
  await fs.rename(original.data, relocated.data)
  const afterRelocation = await identifier(relocated, "oauth-authority", value)
  expect(afterRelocation).toBe(first)
})

test("MCP identifiers are machine-keyed and domain-separated", async () => {
  const firstRoot = await root("first-key")
  const secondRoot = await root("second-key")
  const value = "same-sensitive-input"
  const authority = await identifier(firstRoot, "oauth-authority", value)
  const flow = await identifier(firstRoot, "oauth-flow", value)
  const otherMachine = await identifier(secondRoot, "oauth-authority", value)

  expect(authority).toMatch(/^[a-f0-9]{64}$/)
  expect(flow).not.toBe(authority)
  expect(otherMachine).not.toBe(authority)
})
