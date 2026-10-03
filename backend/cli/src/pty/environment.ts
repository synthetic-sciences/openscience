import { devNull, hostname } from "node:os"
import path from "node:path"

const inherited = new Set([
  "SHELL_SESSION_DIR",
  "SHELL_SESSION_FILE",
  "SHELL_SESSION_HISTORY",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
])

/** Variables that describe the launcher rather than this terminal. A server
 * started inside tmux or over SSH would otherwise make the person's startup
 * files attach to tmux or behave as a remote login inside the tab. */
const launcher = new Set(["TMUX", "TMUX_PANE", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"])

/** Server-side credentials a user shell must never inherit. */
const server = new Set(["OPENSCIENCE_AUTH_TOKEN"])

export type TerminalMode = "host" | "sandboxed"

const shellName = (command: string) =>
  command
    .replace(/\\/g, "/")
    .split("/")
    .at(-1)
    ?.toLowerCase()
    .replace(/\.exe$/, "")

export function terminalEnv(
  source: NodeJS.ProcessEnv,
  projectID: string,
  sessionID: string,
  command: string,
  machine = hostname(),
  mode: TerminalMode = "host",
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !inherited.has(entry[0]) &&
        !server.has(entry[0]) &&
        !(mode === "host" && launcher.has(entry[0])),
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
    PATH: terminalPath(env),
    ...(shell === "bash" ? { BASH_SILENCE_DEPRECATION_WARNING: "1" } : {}),
    TERM: "xterm-256color",
    // A sandboxed shell has no home directory to keep history in.
    ...(mode === "sandboxed" ? { HISTFILE: devNull } : {}),
    SHELL_SESSIONS_DISABLE: "1",
    OPENSCIENCE_TERMINAL: "1",
    OPENSCIENCE_PROJECT_ID: projectID,
    OPENSCIENCE_SESSION_ID: sessionID,
  }
}

/** GUI-launched apps often inherit only the system PATH. Keep existing entries
 * first and include the usual user-owned installers before shell startup. */
export function terminalPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) {
  const separator = platform === "win32" ? ";" : ":"
  const home = env.HOME ?? env.USERPROFILE
  const join = platform === "win32" ? path.win32.join : path.posix.join
  const entries = [
    ...(env.PATH ?? env.Path ?? "").split(separator),
    ...(home ? [join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".cargo", "bin")] : []),
    ...(platform === "darwin" ? ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] : []),
    ...(platform === "win32" && env.APPDATA ? [join(env.APPDATA, "npm")] : []),
    ...(platform === "win32" ? [] : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
  ]
  return [...new Set(entries.filter(Boolean))].join(separator)
}

export function terminalArgs(command: string, mode: TerminalMode = "host") {
  const shell = shellName(command)
  if (mode === "sandboxed") {
    // The sandbox hides the home directory, so startup files cannot load.
    // Sandboxed zsh also cannot own the host PTY's foreground process group:
    // disable job control so it does not print a false `can't set tty pgrp`.
    if (shell === "zsh") return ["-d", "-f", "+m", "-i"]
    if (shell === "bash") return ["--noprofile", "--norc", "-i"]
    if (shell === "fish") return ["--no-config", "--interactive"]
    if (shell === "sh" || shell === "dash" || shell === "ksh") return ["-i"]
    return []
  }
  // Preserve the user's login/interactive setup (PATH, aliases and version
  // managers). macOS session restoration remains disabled by terminalEnv.
  if (shell === "zsh") return ["-l", "-i"]
  if (shell === "bash") return ["--login", "-i"]
  if (shell === "fish") return ["--login", "--interactive"]
  if (shell === "sh" || shell === "dash" || shell === "ksh") return ["-i"]
  return []
}
