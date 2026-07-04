import { execFile } from "child_process"

// Fire-and-forget URL opener. Uses execFile (no shell) so the URL can't be
// interpreted as a shell expression and we don't depend on PowerShell being
// reachable on Windows. On Windows we invoke `explorer.exe URL` which hands
// the target to the default browser without flashing a console window —
// `cmd /c start "" "URL"` and the `open` npm package's PowerShell path can
// both pop a visible console when spawned from a Bun-compiled binary.
export function openUrl(url: string): void {
  try {
    if (process.platform === "darwin") {
      execFile("open", [url], { windowsHide: true }, () => {})
    } else if (process.platform === "win32") {
      execFile("explorer.exe", [url], { windowsHide: true }, () => {})
    } else {
      execFile("xdg-open", [url], { windowsHide: true }, () => {})
    }
  } catch {}
}
