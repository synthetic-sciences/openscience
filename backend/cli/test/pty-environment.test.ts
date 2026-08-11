import { expect, test } from "bun:test"
import { terminalArgs, terminalEnv } from "@/pty/environment"

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

  expect(env.PATH).toBe("/usr/bin:/bin")
  expect(env.TERM).toBe("xterm-256color")
  expect(env.HISTFILE).toBe("/dev/null")
  expect(env.SHELL_SESSIONS_DISABLE).toBe("1")
  expect(env.OPENSCIENCE_PROJECT_ID).toBe("project_1")
  expect(env.OPENSCIENCE_SESSION_ID).toBe("ses_1")
  expect(env.PROMPT).toBe("%n@workstation %1~ %# ")
  expect(env.PS1).toBeUndefined()
  expect(env.TERM_SESSION_ID).toBeUndefined()
  expect(env.TERM_PROGRAM).toBeUndefined()
  expect(env.SHELL_SESSION_DIR).toBeUndefined()
  expect(env.SHELL_SESSION_FILE).toBeUndefined()
  expect(env.SHELL_SESSION_HISTORY).toBeUndefined()
})

test("project terminals show the current workspace folder in common shell prompts", () => {
  expect(terminalEnv({}, "project_1", "ses_1", "/bin/zsh", "Aayams-MacBook-Pro-3.local").PROMPT).toBe(
    "%n@Aayams-MacBook-Pro-3 %1~ %# ",
  )
  expect(terminalEnv({}, "project_1", "ses_1", "/bin/bash", "Aayams-MacBook-Pro-3.local").PS1).toBe(
    "\\u@Aayams-MacBook-Pro-3 \\W \\$ ",
  )
  expect(terminalEnv({}, "project_1", "ses_1", "nu", "workstation.local").PROMPT).toBeUndefined()
})

test("zsh keeps user startup files but skips the global history override", () => {
  expect(terminalArgs("/bin/zsh")).toEqual(["-d", "-l"])
  expect(terminalArgs("/bin/bash")).toEqual(["-l"])
  expect(terminalArgs("nu")).toEqual([])
})
