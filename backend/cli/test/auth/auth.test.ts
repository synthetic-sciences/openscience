import { test, expect, beforeEach, afterAll } from "bun:test"
import path from "path"
import fs from "fs/promises"
import os from "os"
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
  if (process.platform !== "win32") {
    expect((await fs.stat(filepath)).mode & 0o777).toBe(0o600)
  }

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

test("independent CLI processes do not overwrite one another's credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-auth-lock-"))
  const runner = path.join(root, "set.ts")
  const auth = new URL("../../src/auth/index.ts", import.meta.url).href
  await Bun.write(
    runner,
    `
import { Auth } from ${JSON.stringify(auth)}
await Auth.set(process.argv[2], { type: "api", key: process.argv[3] })
`,
  )

  try {
    const processes = Array.from({ length: 12 }, (_, index) =>
      Bun.spawn([process.execPath, runner, `provider-${index}`, `key-${index}`], {
        env: {
          ...process.env,
          OPENSCIENCE_DATA_DIR: root,
          OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
          OPENSCIENCE_TEST_HOME: path.join(root, "home"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const results = await Promise.all(
      processes.map(async (proc) => ({
        exit: await proc.exited,
        error: await new Response(proc.stderr).text(),
      })),
    )
    expect(results.filter((result) => result.exit !== 0)).toEqual([])

    const raw = (await Bun.file(path.join(root, "auth.json")).json()) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(Array.from({ length: 12 }, (_, index) => `provider-${index}`).sort())
    const leftovers = (await fs.readdir(root)).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp"))
    expect(leftovers).toEqual([])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("provider logout in one server revokes inherited BYOK children in another", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-auth-revision-"))
  const mutate = path.join(root, "mutate.ts")
  const worker = path.join(root, "worker.ts")
  const ready = path.join(root, "ready")
  const auth = new URL("../../src/auth/index.ts", import.meta.url).href
  const lifecycle = new URL("../../src/credentials/lifecycle.ts", import.meta.url).href
  const openscience = new URL("../../src/openscience/index.ts", import.meta.url).href
  await Bun.write(
    mutate,
    [
      `import { Auth } from ${JSON.stringify(auth)}`,
      `if (process.argv[2] === "remove") await Auth.remove("openai")`,
      `else await Auth.set("openai", { type: "api", key: "sk-cross-process-provider" })`,
    ].join("\n"),
  )
  await Bun.write(
    worker,
    [
      `import fs from "node:fs/promises"`,
      `import { spawn } from "node:child_process"`,
      `import { CredentialLifecycle } from ${JSON.stringify(lifecycle)}`,
      `import { OpenScience } from ${JSON.stringify(openscience)}`,
      `await CredentialLifecycle.ensureFresh()`,
      `const initial = await OpenScience.subprocessEnv(process.env)`,
      `if (initial.OPENAI_API_KEY !== "sk-cross-process-provider") throw new Error("worker did not load provider key")`,
      `const child = spawn(process.execPath, ["-e", "console.log(process.env.OPENAI_API_KEY || 'absent'); setInterval(() => {}, 1000)"], { env: initial, stdio: ["ignore", "pipe", "pipe"] })`,
      `const inherited = await new Promise((resolve, reject) => { child.stdout.once("data", (data) => resolve(String(data).trim())); child.once("error", reject) })`,
      `if (inherited !== "sk-cross-process-provider") throw new Error("child did not inherit provider key")`,
      `let revoked = false`,
      `CredentialLifecycle.onRevoke(async () => { revoked = true; child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)) })`,
      `CredentialLifecycle.watch(25)`,
      `await fs.writeFile(${JSON.stringify(ready)}, "ready")`,
      `for (let i = 0; i < 400 && !revoked; i++) await Bun.sleep(10)`,
      `await CredentialLifecycle.ensureFresh()`,
      `if (!revoked || (child.exitCode === null && child.signalCode === null)) throw new Error("provider child was not revoked")`,
      `const next = await OpenScience.subprocessEnv(process.env)`,
      `if (next.OPENAI_API_KEY !== undefined) throw new Error("new child env retained removed provider key")`,
      `CredentialLifecycle.stopWatching()`,
    ].join("\n"),
  )

  const env = {
    ...process.env,
    OPENSCIENCE_DATA_DIR: root,
    OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  }
  const run = async (args: string[]) => {
    const proc = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" })
    const [exit, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    if (exit !== 0) throw new Error(error)
  }

  try {
    await run([process.execPath, mutate, "set"])
    const live = Bun.spawn([process.execPath, worker], { env, stdout: "pipe", stderr: "pipe" })
    for (let i = 0; i < 400 && !(await Bun.file(ready).exists()); i++) await Bun.sleep(10)
    expect(await Bun.file(ready).exists()).toBe(true)
    await run([process.execPath, mutate, "remove"])
    const [exit, error] = await Promise.all([live.exited, new Response(live.stderr).text()])
    if (exit !== 0) throw new Error(error)
    expect(exit).toBe(0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
