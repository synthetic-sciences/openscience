import { describe, expect, test, beforeEach } from "bun:test"
import { spawn } from "node:child_process"
import path from "path"
import { LSPClient } from "../../src/lsp/client"
import { LSPServer } from "../../src/lsp/server"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

// Minimal fake LSP server that speaks JSON-RPC over stdio
function spawnFakeServer() {
  const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
  return {
    process: spawn(process.execPath, [serverPath], {
      stdio: "pipe",
    }),
  }
}

function spawnScript(script: string) {
  return {
    process: spawn(process.execPath, ["-e", script], {
      stdio: "pipe",
    }),
  }
}

describe("LSPClient interop", () => {
  beforeEach(async () => {
    await Log.init({ print: true })
  })

  test("handles workspace/workspaceFolders request", async () => {
    const handle = spawnFakeServer() as any

    const client = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "workspace/workspaceFolders",
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(client.connection).toBeDefined()

    await client.shutdown()
  })

  test("handles client/registerCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/registerCapability",
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(client.connection).toBeDefined()

    await client.shutdown()
  })

  test("handles client/unregisterCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/unregisterCapability",
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(client.connection).toBeDefined()

    await client.shutdown()
  })

  test("fails promptly when the server exits during initialization", async () => {
    const handle = spawnScript("process.exit(17)") as unknown as LSPServer.Handle
    const started = Date.now()

    await expect(
      Instance.provide({
        directory: process.cwd(),
        fn: () =>
          LSPClient.create({
            serverID: "dead",
            server: handle,
            root: process.cwd(),
            initializationTimeoutMs: 5_000,
          }),
      }),
    ).rejects.toThrow("LSPInitializeError")

    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("bounds initialization when a live server never responds", async () => {
    const handle = spawnScript("process.stdin.resume()") as unknown as LSPServer.Handle
    const started = Date.now()

    try {
      await expect(
        Instance.provide({
          directory: process.cwd(),
          fn: () =>
            LSPClient.create({
              serverID: "blocked",
              server: handle,
              root: process.cwd(),
              initializationTimeoutMs: 50,
            }),
        }),
      ).rejects.toThrow("LSPInitializeError")

      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      handle.process.kill()
    }
  })
})
