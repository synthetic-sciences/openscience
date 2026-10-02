import { expect, test } from "bun:test"
import { terminalArgs, terminalEnv, terminalPath } from "@/pty/environment"

test("project terminals do not inherit the parent macOS terminal session", () => {
  const env = terminalEnv(
    {
      PATH: "/usr/bin:/bin",
      TERM_SESSION_ID: "restored-session",
      TERM_PROGRAM: "Apple_Terminal",
      TERM_PROGRAM_VERSION: "999",
      SHELL_SESSION_DIR: "/tmp/sessions",
      SHELL_SESSION_FILE: "/tmp/session",
      SHELL_SESSION_HISTORY: "/tmp/history",
    },
    "project_1",
    "ses_1",
    "/bin/zsh",
    "workstation.local",
  )

  expect(env.PATH.split(":").slice(0, 2)).toEqual(["/usr/bin", "/bin"])
  expect(env.TERM).toBe("xterm-256color")
  expect(env.HISTFILE).toBeUndefined()
  expect(env.SHELL_SESSIONS_DISABLE).toBe("1")
  expect(env.OPENSCIENCE_PROJECT_ID).toBe("project_1")
  expect(env.OPENSCIENCE_SESSION_ID).toBe("ses_1")
  expect(env.PROMPT).toBe("workstation %1~ %# ")
  expect(env.RPROMPT).toBe("")
  expect(env.PROMPT_EOL_MARK).toBe("")
  expect(env.PS1).toBeUndefined()
  expect(env.TERM_SESSION_ID).toBeUndefined()
  expect(env.TERM_PROGRAM).toBeUndefined()
  expect(env.SHELL_SESSION_DIR).toBeUndefined()
  expect(env.SHELL_SESSION_FILE).toBeUndefined()
  expect(env.SHELL_SESSION_HISTORY).toBeUndefined()
})

test("project terminals show the current workspace folder in common shell prompts", () => {
  expect(terminalEnv({}, "project_1", "ses_1", "/bin/zsh", "Aayams-MacBook-Pro-3.local").PROMPT).toBe(
    "Aayams-MacBook-Pro-3 %1~ %# ",
  )
  expect(terminalEnv({}, "project_1", "ses_1", "/bin/bash", "Aayams-MacBook-Pro-3.local").PS1).toBe(
    "Aayams-MacBook-Pro-3 \\W \\$ ",
  )
  expect(terminalEnv({}, "project_1", "ses_1", "nu", "workstation.local").PROMPT).toBeUndefined()
  expect(terminalEnv({}, "project_1", "ses_1", "C:\\Program Files\\Git\\bin\\bash", "workstation.local")).toMatchObject(
    {
      PS1: "workstation \\W \\$ ",
      BASH_SILENCE_DEPRECATION_WARNING: "1",
    },
  )
})

test("interactive shells load login configuration for installed commands", () => {
  expect(terminalArgs("/bin/zsh")).toEqual(["-l", "-i"])
  expect(terminalArgs("/bin/bash")).toEqual(["--login", "-i"])
  expect(terminalArgs("/usr/local/bin/fish")).toEqual(["--login", "--interactive"])
  expect(terminalArgs("/bin/dash")).toEqual(["-i"])
  expect(terminalArgs("nu")).toEqual([])
})

test("GUI terminal PATH finds user installers without dropping or reordering existing entries", () => {
  const env = { HOME: "/home/researcher", PATH: "/custom/bin:/usr/bin:/bin" }
  const entries = terminalPath(env, "darwin").split(":")
  expect(entries.slice(0, 3)).toEqual(["/custom/bin", "/usr/bin", "/bin"])
  expect(entries).toContain("/home/researcher/.local/bin")
  expect(entries).toContain("/home/researcher/.bun/bin")
  expect(entries).toContain("/opt/homebrew/bin")
  expect(new Set(entries).size).toBe(entries.length)
  expect(
    terminalPath(
      { USERPROFILE: "C:\\Users\\Researcher", APPDATA: "C:\\Users\\Researcher\\AppData\\Roaming", Path: "C:\\Windows" },
      "win32",
    ).split(";"),
  ).toContain("C:\\Users\\Researcher\\AppData\\Roaming\\npm")
  expect(terminalArgs("C:\\Program Files\\Git\\bin\\bash.exe")).toEqual(["--login", "-i"])
})
