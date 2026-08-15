import { expect, test } from "bun:test"
import { Shell } from "../../src/shell/shell"

/**
 * How a shell is handed one command.
 *
 * Measured on a real Windows 11 machine: `Sandbox.plan` composed
 * `[shell, "-c", command]`, the shell resolved to `cmd.exe`, and cmd does not
 * error on `-c` — it starts an INTERACTIVE shell. Every sandboxed command
 * printed the cmd banner and a prompt, ran nothing, and exited 0. The sandbox
 * self-test then read that banner as a process token and reported a containment
 * failure that had not happened, which cost two debugging cycles.
 *
 * These run on Linux CI, which is the point: the machine that exposes this is
 * not one the suite can run on, so `invocation` must not branch on
 * `process.platform` to reach the Windows answer.
 */

test.each([
  ["cmd.exe", ["/d", "/s", "/c", "echo hi"]],
  ["C:\\Windows\\system32\\cmd.exe", ["/d", "/s", "/c", "echo hi"]],
  // COMSPEC is what Shell.fallback() returns on Windows, and its casing varies.
  ["C:\\WINDOWS\\SYSTEM32\\CMD.EXE", ["/d", "/s", "/c", "echo hi"]],
  ["powershell.exe", ["-NoProfile", "-Command", "echo hi"]],
  ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-Command", "echo hi"]],
  // Git Bash is preferred over cmd by Shell.fallback(), and is POSIX.
  ["C:\\Program Files\\Git\\bin\\bash.exe", ["-c", "echo hi"]],
  ["/bin/sh", ["-c", "echo hi"]],
  ["/bin/zsh", ["-c", "echo hi"]],
  ["/usr/bin/fish", ["-c", "echo hi"]],
])("%s is invoked correctly", (shell, expected) => {
  expect(Shell.invocation(shell, "echo hi")).toEqual(expected)
})

test("cmd never receives -c, whatever path it arrives by", () => {
  // The specific regression. -c is not rejected by cmd; it is ignored, which is
  // why this failed silently rather than loudly.
  for (const shell of ["cmd", "cmd.exe", "C:\\Windows\\System32\\cmd.exe"])
    expect(Shell.invocation(shell, "whoami /groups")).not.toContain("-c")
})

test("the command is passed through untouched", () => {
  // No quoting or escaping here: the argv is handed to spawn as separate
  // arguments, so a shell-quoting pass would corrupt it.
  const command = `printf 'a b' > "/tmp/x y" && echo "done"`
  expect(Shell.invocation("/bin/sh", command)).toEqual(["-c", command])
  expect(Shell.invocation("cmd.exe", command)).toEqual(["/d", "/s", "/c", command])
})

test.each([
  ["cmd.exe", "cmd"],
  ["C:\\WINDOWS\\system32\\CMD.EXE", "cmd"],
  ["powershell.exe", "powershell"],
  ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "powershell"],
  ["C:\\Program Files\\Git\\bin\\bash.exe", "posix"],
  ["/bin/sh", "posix"],
] as Array<[string, ReturnType<typeof Shell.family>]>)("%s speaks %s", (shell, expected) => {
  expect(Shell.family(shell)).toBe(expected)
})

test("family() exists because the flag alone is not enough", async () => {
  // cmd.exe has no printf and no cat. The sandbox self-test probed with
  // `printf hi > f && cat f`, which on Windows failed because neither command
  // exists — and was reported as the sandbox being unable to write inside its
  // own workspace, one layer after the /c fix had made commands run at all.
  const source = await Bun.file(new URL("../../src/sandbox/sandbox.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("export async function selfTest"))
  expect(body).toContain("Shell.family(shell)")
  expect(body).toContain("type ")
  // The POSIX spelling must still be there for Linux and macOS.
  expect(body).toContain("printf ")
})

test("the self-test's own diagnostics never masquerade as the child's error", async () => {
  // The launcher's debug dump shares stderr with the child, so firstLine() was
  // returning the first line of the dump for every failure.
  const source = await Bun.file(new URL("../../src/sandbox/sandbox.ts", import.meta.url).pathname).text()
  const body = source.slice(source.indexOf("function firstLine"), source.indexOf("function runAsync"))
  // Was a single prefix check. That proved insufficient: the structured logger
  // writes INFO lines to the same stderr and one of them was reported as the
  // reason a sandboxed curl failed. The rule is "anything we wrote", not "the
  // one prefix noticed first".
  expect(body).toContain("!ours(value)")
})
