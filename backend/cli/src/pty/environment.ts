import { devNull, hostname } from "node:os"

const inherited = new Set([
  "SHELL_SESSION_DIR",
  "SHELL_SESSION_FILE",
  "SHELL_SESSION_HISTORY",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
])

const shellName = (command: string) => command.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase()

export function terminalEnv(
  source: NodeJS.ProcessEnv,
  projectID: string,
  sessionID: string,
  command: string,
  machine = hostname(),
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && !inherited.has(entry[0]),
    ),
  )
  const host = machine.split(".")[0]?.replace(/[^a-zA-Z0-9_-]/g, "") || "localhost"
  const shell = shellName(command)
  const prompt: Record<string, string> =
    shell === "zsh"
      ? { PROMPT: `${host} %1~ %# `, RPROMPT: "", PROMPT_EOL_MARK: "" }
      : shell === "bash" || shell === "sh" || shell === "dash" || shell === "ksh"
        ? { PS1: `${host} \\W \\$ ` }
        : {}
  return {
    ...env,
    ...prompt,
    ...(shell === "bash" ? { BASH_SILENCE_DEPRECATION_WARNING: "1" } : {}),
    TERM: "xterm-256color",
    HISTFILE: devNull,
    SHELL_SESSIONS_DISABLE: "1",
    OPENSCIENCE_TERMINAL: "1",
    OPENSCIENCE_PROJECT_ID: projectID,
    OPENSCIENCE_SESSION_ID: sessionID,
  }
}

export function terminalArgs(command: string) {
  const shell = shellName(command)
  // Sandboxed zsh cannot own the host PTY's foreground process group. Disable
  // job control before interactive startup so it does not print a false
  // `can't set tty pgrp` warning; foreground commands remain fully interactive.
  if (shell === "zsh") return ["-d", "-f", "+m", "-i"]
  if (shell === "bash") return ["--noprofile", "--norc", "-i"]
  if (shell === "fish") return ["--no-config", "--interactive"]
  if (shell === "sh" || shell === "dash" || shell === "ksh") return ["-i"]
  return []
}
