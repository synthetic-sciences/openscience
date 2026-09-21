import path from "node:path"

/**
 * The directory the shell's logs belong in, or undefined to keep Electron's default.
 *
 * On macOS that default is `~/Library/Logs/<app name>`: it follows the app's name, not its `userData`. A shell
 * run from source, or any launch given `--user-data-dir`, carries the installed app's name, so it would rotate
 * and overwrite the log a person attaches to a bug report. Such a launch keeps its logs with the rest of its
 * data; an installed app started normally keeps the platform's location.
 *
 * @param {{ packaged: boolean, relocated: boolean, userData: string }} shell
 * @returns {string | undefined}
 */
export function logsDirectory(shell) {
  if (shell.packaged && !shell.relocated) return
  return path.join(shell.userData, "logs")
}
