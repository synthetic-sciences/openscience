import { test, expect, beforeEach, afterAll } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { McpAuth } from "../../src/mcp/auth"

const filepath = path.join(Global.Path.data, "mcp-auth.json")

async function clean() {
  await fs.mkdir(Global.Path.data, { recursive: true })
  const entries = await fs.readdir(Global.Path.data)
  await Promise.all(
    entries
      .filter((name) => name.startsWith("mcp-auth.json"))
      .map((name) => fs.rm(path.join(Global.Path.data, name), { force: true })),
  )
}

beforeEach(clean)
afterAll(clean)

test("concurrent updates keep every server entry", async () => {
  await Promise.all([
    McpAuth.updateTokens("server-a", { accessToken: "token-a" }, "https://a.example"),
    McpAuth.updateTokens("server-b", { accessToken: "token-b" }, "https://b.example"),
    McpAuth.updateClientInfo("server-c", { clientId: "client-c" }, "https://c.example"),
  ])
  const all = await McpAuth.all()
  expect(Object.keys(all).sort()).toEqual(["server-a", "server-b", "server-c"])
  expect(all["server-a"].tokens?.accessToken).toBe("token-a")
  expect(all["server-c"].clientInfo?.clientId).toBe("client-c")
})

test("updateTokens does not drop the rest of an entry", async () => {
  await McpAuth.updateClientInfo("server-a", { clientId: "client-a" }, "https://a.example")
  await McpAuth.updateTokens("server-a", { accessToken: "token-a" })
  const entry = await McpAuth.get("server-a")
  expect(entry?.clientInfo?.clientId).toBe("client-a")
  expect(entry?.tokens?.accessToken).toBe("token-a")
  expect(entry?.serverUrl).toBe("https://a.example")
})

test("set on a corrupt mcp-auth.json throws and leaves a backup", async () => {
  const corrupt = "{ definitely not json"
  await fs.writeFile(filepath, corrupt)

  await expect(McpAuth.set("server-a", { tokens: { accessToken: "token-a" } })).rejects.toThrow(/backed up/)
  expect(await Bun.file(filepath).text()).toBe(corrupt)
  expect(await Bun.file(`${filepath}.corrupt-${process.pid}`).text()).toBe(corrupt)

  // Read path still degrades to {}
  expect(await McpAuth.all()).toEqual({})
})
