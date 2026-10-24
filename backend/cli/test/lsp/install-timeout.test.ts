import { expect, spyOn, test } from "bun:test"
import { LSPServer } from "../../src/lsp/server"
import { Flag } from "../../src/flag/flag"

test("missing optional Pyright uses a bounded installer without unread output pipes", async () => {
  const flag = Object.getOwnPropertyDescriptor(Flag, "OPENSCIENCE_DISABLE_LSP_DOWNLOAD")!
  const which = spyOn(Bun, "which").mockReturnValue(null)
  const file = spyOn(Bun, "file").mockReturnValue({ exists: async () => false } as never)
  const spawn = spyOn(Bun, "spawn").mockReturnValue({ exited: Promise.resolve(1) } as never)
  try {
    Object.defineProperty(Flag, "OPENSCIENCE_DISABLE_LSP_DOWNLOAD", { ...flag, value: false })
    expect(await LSPServer.Pyright.spawn(process.cwd())).toBeUndefined()
    expect(spawn).toHaveBeenCalledTimes(1)
    const [argv, options] = spawn.mock.calls[0] as unknown as [string[], Record<string, unknown>]
    expect(argv.slice(-2)).toEqual(["install", "pyright"])
    expect(options).toMatchObject({ timeout: 30_000, killSignal: "SIGKILL", stdout: "ignore", stderr: "ignore" })
  } finally {
    Object.defineProperty(Flag, "OPENSCIENCE_DISABLE_LSP_DOWNLOAD", flag)
    which.mockRestore()
    file.mockRestore()
    spawn.mockRestore()
  }
})

test("Bun subprocess timeout actually settles a stalled installer-like child", async () => {
  const started = Date.now()
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    timeout: 250,
    killSignal: "SIGKILL",
    stdout: "ignore",
    stderr: "ignore",
  })
  expect(await child.exited).not.toBe(0)
  expect(Date.now() - started).toBeLessThan(5_000)
}, 10_000)
