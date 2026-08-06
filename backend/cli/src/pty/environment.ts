const inherited = new Set([
  "SHELL_SESSION_DIR",
  "SHELL_SESSION_FILE",
  "SHELL_SESSION_HISTORY",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
])

export function terminalEnv(source: NodeJS.ProcessEnv, projectID: string, sessionID: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && !inherited.has(entry[0]),
    ),
  )
  return {
    ...env,
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
