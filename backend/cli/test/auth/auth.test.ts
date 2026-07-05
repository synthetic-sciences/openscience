import { test, expect, beforeEach, afterAll } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { Auth } from "../../src/auth"

const filepath = path.join(Global.Path.data, "auth.json")

async function clean() {
  await fs.mkdir(Global.Path.data, { recursive: true })
  const entries = await fs.readdir(Global.Path.data)
  await Promise.all(
    entries
      .filter((name) => name.startsWith("auth.json"))
      .map((name) => fs.rm(path.join(Global.Path.data, name), { force: true })),
  )
}

beforeEach(clean)
afterAll(clean)

test("concurrent set calls keep every provider", async () => {
  await Promise.all([
    Auth.set("provider-a", { type: "api", key: "key-a" }),
    Auth.set("provider-b", { type: "api", key: "key-b" }),
    Auth.set("provider-c", { type: "oauth", refresh: "refresh-c", access: "access-c", expires: 123 }),
  ])
  const all = await Auth.all()
  expect(Object.keys(all).sort()).toEqual(["provider-a", "provider-b", "provider-c"])
  expect(all["provider-a"]).toEqual({ type: "api", key: "key-a" })

  const leftover = (await fs.readdir(Global.Path.data)).filter((name) => name.endsWith(".tmp"))
  expect(leftover).toEqual([])
})

test("set on a corrupt auth.json throws and leaves a backup instead of wiping", async () => {
  const corrupt = '{"anthropic": {"type": "api", "key": "sk-real"'
  await fs.writeFile(filepath, corrupt)

  await expect(Auth.set("openai", { type: "api", key: "sk-new" })).rejects.toThrow(/backed up/)

  // Original file untouched, backup created alongside
  expect(await Bun.file(filepath).text()).toBe(corrupt)
  expect(await Bun.file(`${filepath}.corrupt-${process.pid}`).text()).toBe(corrupt)

  // Read path still degrades to {} so the CLI can boot
  expect(await Auth.all()).toEqual({})
})

test("remove on a corrupt auth.json throws and leaves a backup", async () => {
  const corrupt = "not json at all"
  await fs.writeFile(filepath, corrupt)

  await expect(Auth.remove("anthropic")).rejects.toThrow(/backed up/)
  expect(await Bun.file(filepath).text()).toBe(corrupt)
  expect(await Bun.file(`${filepath}.corrupt-${process.pid}`).text()).toBe(corrupt)
})

test("remove drops only the named provider", async () => {
  await Auth.set("provider-a", { type: "api", key: "key-a" })
  await Auth.set("provider-b", { type: "api", key: "key-b" })
  await Auth.remove("provider-a")
  const all = await Auth.all()
  expect(Object.keys(all)).toEqual(["provider-b"])
})

test("set preserves entries it does not understand", async () => {
  await fs.writeFile(filepath, JSON.stringify({ future: { type: "hologram", shard: 7 } }))
  await Auth.set("provider-a", { type: "api", key: "key-a" })
  const raw = (await Bun.file(filepath).json()) as Record<string, unknown>
  expect(Object.keys(raw).sort()).toEqual(["future", "provider-a"])
})
