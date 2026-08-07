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
  )

  expect(env.PATH).toBe("/usr/bin:/bin")
  expect(env.TERM).toBe("xterm-256color")
  expect(env.HISTFILE).toBe("/dev/null")
  expect(env.SHELL_SESSIONS_DISABLE).toBe("1")
  expect(env.OPENSCIENCE_PROJECT_ID).toBe("project_1")
  expect(env.OPENSCIENCE_SESSION_ID).toBe("ses_1")
  expect(env.TERM_SESSION_ID).toBeUndefined()
  expect(env.TERM_PROGRAM).toBeUndefined()
  expect(env.SHELL_SESSION_DIR).toBeUndefined()
  expect(env.SHELL_SESSION_FILE).toBeUndefined()
  expect(env.SHELL_SESSION_HISTORY).toBeUndefined()
})

test("zsh keeps user startup files but skips the global history override", () => {
  expect(terminalArgs("/bin/zsh")).toEqual(["-d", "-l"])
  expect(terminalArgs("/bin/bash")).toEqual(["-l"])
  expect(terminalArgs("nu")).toEqual([])
})
