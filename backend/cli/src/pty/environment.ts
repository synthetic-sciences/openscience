import { hostname } from "node:os"

const inherited = new Set([
  "SHELL_SESSION_DIR",
  "SHELL_SESSION_FILE",
  "SHELL_SESSION_HISTORY",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
])

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
  const prompt: Record<string, string> = command.endsWith("zsh")
    ? { PROMPT: `%n@${host} %1~ %# ` }
    : command.endsWith("sh")
      ? { PS1: `\\u@${host} \\W \\$ ` }
      : {}
  return {
    ...env,
    ...prompt,
    TERM: "xterm-256color",
    HISTFILE: "/dev/null",
    SHELL_SESSIONS_DISABLE: "1",
    OPENSCIENCE_TERMINAL: "1",
    OPENSCIENCE_PROJECT_ID: projectID,
    OPENSCIENCE_SESSION_ID: sessionID,
  }
}

export function terminalArgs(command: string) {
  if (command.endsWith("zsh")) return ["-d", "-l"]
  if (command.endsWith("sh")) return ["-l"]
  return []
}
