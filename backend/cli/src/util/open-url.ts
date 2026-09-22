import { execFile } from "child_process"
import path from "path"
import { Log } from "./log"

const log = Log.create({ service: "open-url" })

export type Launcher = {
  file: string
  args: string[]
  /** Whether this exit status means the URL was handed to a browser. */
  launched: (code: number | null) => boolean
}

/**
 * The commands that hand a URL to the default browser, in the order to try
 * them. Each runs through execFile (no shell), so the URL is never a shell
 * expression and nothing depends on PowerShell being reachable.
 *
 * Windows is the platform that needs more than one. `explorer.exe URL` is the
 * usual no-console way to open a link, but Explorer parses its own command
 * line first: a URL with query arguments (`?state=…&redirect=…`, which every
 * sign-in approval page carries) is not one it recognises, so it opens a
 * File Explorer window instead of the browser and exits as if it succeeded
 * (microsoft/WSL#3832). `rundll32 url.dll,FileProtocolHandler URL` passes the
 * whole URL to ShellExecute, the same call the Run dialog makes, and keeps
 * the query string; it is what the GitHub CLI and Go's browser package use.
 * Both are named by their absolute path under SystemRoot, so a PATH that
 * lost `C:\Windows` cannot take the browser with it. Explorer stays as the
 * fallback for a machine without url.dll, and because it exits 1 even when
 * it did open the link, only its failure to start counts against it.
 */
export function launchers(url: string, options?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): Launcher[] {
  const platform = options?.platform ?? process.platform
  const env = options?.env ?? process.env
  if (platform === "darwin") return [{ file: "open", args: [url], launched: (code) => code === 0 }]
  if (platform === "win32") {
    const root = env.SystemRoot || env.windir || "C:\\Windows"
    return [
      {
        file: path.win32.join(root, "System32", "rundll32.exe"),
        args: ["url.dll,FileProtocolHandler", url],
        launched: (code) => code === 0,
      },
      { file: path.win32.join(root, "explorer.exe"), args: [url], launched: () => true },
    ]
  }
  return [{ file: "xdg-open", args: [url], launched: (code) => code === 0 }]
}

function run(launcher: Launcher) {
  return new Promise<boolean>((resolve) => {
    try {
      const child = execFile(launcher.file, launcher.args, { windowsHide: true }, (error) => {
        // A process that could not start has no exit status; one that ran
        // reports it through the error's code when it is not zero.
        if (error && typeof error.code !== "number") return resolve(false)
        resolve(launcher.launched(error ? (error.code as number) : (child.exitCode ?? 0)))
      })
    } catch {
      resolve(false)
    }
  })
}

/**
 * Open a URL in the default browser. Resolves true when one of the platform's
 * launchers accepted it. Callers that only need to fire it may ignore the
 * result; the surface that started the request should still show the URL,
 * since no launcher can prove a browser appeared.
 */
export async function openUrl(url: string): Promise<boolean> {
  for (const launcher of launchers(url)) {
    if (await run(launcher)) return true
  }
  log.warn("no launcher opened the url", { url })
  return false
}
