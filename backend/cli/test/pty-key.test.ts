import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { OpenScience } from "@/openscience"
import { terminalArgs, terminalEnv } from "@/pty/environment"
import { TerminalKey } from "@/pty/key"
import { TerminalMode } from "@/pty/mode"
import { Server } from "@/server/server"

afterEach(() => TerminalKey.forget())

test("only a keyed, local, permitted request gets the person's own shell", () => {
  const cases: [Parameters<typeof TerminalMode.decide>[0], ReturnType<typeof TerminalMode.decide>][] = [
    [{ key: true, local: true }, { mode: "host" }],
    [{ setting: "host", key: true, local: true }, { mode: "host" }],
    [
      { key: false, local: true },
      { mode: "sandboxed", reason: "no_key" },
    ],
    [
      { key: true, local: false },
      { mode: "sandboxed", reason: "not_local" },
    ],
    [
      { key: false, local: false },
      { mode: "sandboxed", reason: "not_local" },
    ],
    [
      { setting: "sandboxed", key: true, local: true },
      { mode: "sandboxed", reason: "policy" },
    ],
  ]
  for (const [input, expected] of cases) expect(TerminalMode.decide(input)).toEqual(expected)
  expect(TerminalMode.local({})).toBe(true)
  expect(TerminalMode.local({ OPENSCIENCE_AUTH_TOKEN: "deployment" })).toBe(false)
})

test("a launch code is spent once and becomes a key", async () => {
  const code = await TerminalKey.mintCode()
  const key = await TerminalKey.exchange(code)
  expect(key).toBeString()
  expect(await TerminalKey.valid(key)).toBe(true)
  expect(await TerminalKey.exchange(code)).toBeUndefined()
  expect(await TerminalKey.valid("not-a-key")).toBe(false)
  expect(await TerminalKey.valid(undefined)).toBe(false)
})

test("expired codes and forgotten keys are refused", async () => {
  const stale = "s".repeat(43)
  await TerminalKey.adoptCode(stale, -1)
  expect(await TerminalKey.exchange(stale)).toBeUndefined()

  const key = await TerminalKey.exchange(await TerminalKey.mintCode())
  await TerminalKey.forget()
  expect(await TerminalKey.valid(key)).toBe(false)
})

test("the key store holds hashes only, is private, and is hidden from sandboxed processes", async () => {
  const code = await TerminalKey.mintCode()
  const key = await TerminalKey.exchange(code)
  const text = await Bun.file(TerminalKey.filepath()).text()
  expect(text).not.toContain(code)
  expect(text).not.toContain(key!)
  if (process.platform !== "win32") expect((await fs.stat(TerminalKey.filepath())).mode & 0o777).toBe(0o600)
  expect(OpenScience.kernelSensitivePaths()).toContain(TerminalKey.filepath())
})

test("the desktop app's code is adopted once and removed from the environment", async () => {
  const code = "d".repeat(43)
  const env: NodeJS.ProcessEnv = { [TerminalKey.DESKTOP_CODE_ENV]: code }
  expect(await TerminalKey.adoptDesktopCode(env)).toBe(true)
  expect(env[TerminalKey.DESKTOP_CODE_ENV]).toBeUndefined()
  expect(await TerminalKey.adoptDesktopCode(env)).toBe(false)
  expect(await TerminalKey.exchange(code)).toBeString()
  // The variable's prefix is already withheld from every child process.
  expect(OpenScience.filterControlPlaneEnv({ [TerminalKey.DESKTOP_CODE_ENV]: code })).toEqual({})
})

test("the person's shell drops launcher and server variables; a sandboxed one keeps no history", () => {
  const source = {
    PATH: "/usr/bin",
    TMUX: "/tmp/tmux-1000/default,1,0",
    TMUX_PANE: "%1",
    SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22",
    SSH_CLIENT: "10.0.0.1 1 22",
    SSH_TTY: "/dev/pts/3",
    OPENSCIENCE_AUTH_TOKEN: "deployment",
    EDITOR: "nvim",
  }
  const host = terminalEnv(source, "project_1", "ses_1", "/bin/zsh", "workstation", "host")
  for (const name of ["TMUX", "TMUX_PANE", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "OPENSCIENCE_AUTH_TOKEN"])
    expect(host[name]).toBeUndefined()
  expect(host.EDITOR).toBe("nvim")
  expect(host.HISTFILE).toBeUndefined()

  const sandboxed = terminalEnv(source, "project_1", "ses_1", "/bin/zsh", "workstation", "sandboxed")
  expect(sandboxed.OPENSCIENCE_AUTH_TOKEN).toBeUndefined()
  expect(sandboxed.HISTFILE).toBe(process.platform === "win32" ? "\\\\.\\nul" : "/dev/null")

  expect(terminalArgs("/bin/zsh", "host")).toEqual(["-l", "-i"])
  expect(terminalArgs("/bin/zsh", "sandboxed")).toEqual(["-d", "-f", "+m", "-i"])
  expect(terminalArgs("/bin/bash", "sandboxed")).toEqual(["--noprofile", "--norc", "-i"])
})

test("the exchange route sets an HttpOnly cookie and refuses a spent code", async () => {
  const fetch = Server.internalFetch()
  const code = await TerminalKey.mintCode()
  const exchange = () =>
    fetch("http://openscience.internal/pty/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    })
  const first = await exchange()
  expect(await first.json()).toBe(true)
  const cookie = first.headers.get("set-cookie") ?? ""
  expect(cookie).toStartWith(`${TerminalKey.cookieName("")}=`)
  expect(cookie).toContain("HttpOnly")
  expect(cookie).toContain("SameSite=Strict")
  const key = cookie.split(";")[0]!.split("=").slice(1).join("=")
  expect(await TerminalKey.valid(key)).toBe(true)

  const second = await exchange()
  expect(await second.json()).toBe(false)
  expect(second.headers.get("set-cookie")).toBeNull()
})
