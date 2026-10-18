import { expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import { ComputeJobs } from "../../src/compute/jobs"
import { Flag } from "../../src/flag/flag"
import { Shell } from "../../src/shell/shell"

const root = "C:\\Program Files\\Git"
const bash = `${root}\\bin\\bash.exe`

for (const directory of ["cmd", "bin", "mingw64\\bin", "mingw32\\bin", "ucrt64\\bin", "usr\\bin"]) {
  test(`finds the same Git Bash from Git/${directory.replaceAll("\\", "/")}/git.exe`, () => {
    expect(Shell.windowsGitBash(`${root}\\${directory}\\git.exe`, (file) => file === bash)).toBe(bash)
  })
}

test("supports the Git usr/bin entrypoint without searching unrelated WSL locations", () => {
  const unix = `${root}\\usr\\bin\\bash.exe`
  expect(Shell.windowsGitBash(`${root}\\mingw64\\bin\\git.exe`, (file) => file === unix)).toBe(unix)
  expect(Shell.windowsGitBash("C:\\Windows\\System32\\git.exe", () => true)).toBeUndefined()
  expect(Shell.windowsGitBash(null, () => true)).toBeUndefined()
  expect(Shell.windowsGitBash(`${root}\\cmd\\git.exe`, () => false)).toBeUndefined()
})

test("the generated POSIX script rejects cmd, PowerShell, and the WSL bridge", () => {
  for (const shell of [
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "C:\\Windows\\System32\\bash.exe",
    "C:\\Windows\\Sysnative\\bash.exe",
    "C:\\Windows\\SysWOW64\\bash.exe",
  ]) {
    expect(() => Shell.requirePosix(shell, "win32")).toThrow("Local compute jobs require Git Bash")
  }
  expect(Shell.requirePosix(bash, "win32")).toBe(bash)
  expect(Shell.requirePosix("/bin/zsh", "darwin")).toBe("/bin/zsh")
})

function windows(input: { git?: string; configured?: string; files: string[] }, run: () => void) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  const configured = Object.getOwnPropertyDescriptor(Flag, "OPENSCIENCE_GIT_BASH_PATH")!
  const prior = process.env.SHELL
  const which = spyOn(Bun, "which").mockImplementation((name) => (name === "git" ? (input.git ?? null) : null))
  const exists = spyOn(fs, "existsSync").mockImplementation((file) => input.files.includes(String(file)))
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" })
    Object.defineProperty(Flag, "OPENSCIENCE_GIT_BASH_PATH", { ...configured, value: input.configured })
    process.env.SHELL = "cmd.exe"
    Shell.preferred.reset()
    Shell.acceptable.reset()
    run()
  } finally {
    Object.defineProperty(process, "platform", platform)
    Object.defineProperty(Flag, "OPENSCIENCE_GIT_BASH_PATH", configured)
    if (prior === undefined) delete process.env.SHELL
    else process.env.SHELL = prior
    which.mockRestore()
    exists.mockRestore()
    Shell.preferred.reset()
    Shell.acceptable.reset()
  }
}

test.each(["mingw64", "ucrt64"])("compute selects Git Bash from %s while terminals retain cmd", (directory) => {
  windows({ git: `${root}\\${directory}\\bin\\git.exe`, files: [bash] }, () => {
    expect(Shell.preferred()).toBe("cmd.exe")
    expect(Shell.acceptable()).toBe("cmd.exe")
    expect(ComputeJobs.command({ id: "job-fixture", name: "Shell contract", command: "printf executed" }).argv).toEqual(
      [bash, "-lc", "printf executed"],
    )
  })
})

test("an explicit installed Git Bash override is honored and missing shells fail before a job argv is admitted", () => {
  const configured = "D:\\Portable Git\\bin\\bash.exe"
  windows({ configured, files: [configured] }, () => {
    expect(Shell.posix()).toBe(configured)
  })
  windows({ configured, files: [] }, () => {
    expect(() =>
      ComputeJobs.command({ id: "job-fixture", name: "Shell contract", command: "printf never-executed" }),
    ).toThrow("Configured Git Bash was not found")
  })
  windows({ files: [] }, () => {
    expect(() =>
      ComputeJobs.command({ id: "job-fixture", name: "Shell contract", command: "printf never-executed" }),
    ).toThrow("Local compute jobs require Git Bash")
    expect(Shell.preferred()).toBe("cmd.exe")
  })
})
