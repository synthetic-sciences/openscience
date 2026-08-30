import { Server } from "../../server/server"
import { Installation } from "../../installation"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { openUrl } from "../../util/open-url"
import { probeProtectedFolderAccess } from "../../file/protected-folder-access"
import { GracefulShutdown } from "../../process/graceful-shutdown"
import {
  LOCAL_WORKSPACE_PORTS,
  findWorkspaceServer,
  localServerBase,
  localWorkspaceUrl,
  probeWorkspaceServer,
} from "../local-server"

async function announceFdaIfNeeded() {
  const result = await probeProtectedFolderAccess()
  if (!result.blocked) return
  UI.empty()
  UI.println(UI.Style.TEXT_WARNING_BOLD + "  ⚠  Project folder access is blocked", UI.Style.TEXT_NORMAL)
  UI.empty()
  UI.println(
    UI.Style.TEXT_NORMAL,
    "  macOS is blocking OpenScience from listing ~/Desktop, ~/Documents and ~/Downloads.",
  )
  UI.println(UI.Style.TEXT_NORMAL, "  Grant access to the terminal or app that launches OpenScience.")
  UI.empty()
  UI.println(UI.Style.TEXT_INFO_BOLD + "  Grant access:", UI.Style.TEXT_NORMAL)
  UI.println(UI.Style.TEXT_NORMAL, "    1. Open System Settings → Privacy & Security → Full Disk Access")
  UI.println(UI.Style.TEXT_NORMAL, "    2. Enable the terminal or desktop app you used to launch OpenScience")
  UI.println(UI.Style.TEXT_NORMAL, "    3. If you launch the binary directly, run `which openscience` to locate it")
  UI.println(UI.Style.TEXT_NORMAL, "    4. Quit (Ctrl+C), grant access, then relaunch `openscience web`")
  UI.empty()
}

export const WebCommand = cmd({
  // Default command: bare `openscience` and `openscience web` both open the
  // workspace in the browser. An optional [project] path runs it in that dir.
  command: ["web", "$0 [project]"],
  builder: (yargs) =>
    withNetworkOptions(yargs).positional("project", {
      type: "string",
      describe: "directory to open the workspace in",
    }),
  describe: "open the OpenScience workspace in your browser",
  handler: async (args) => {
    if (args.project) {
      try {
        process.chdir(args.project as string)
      } catch {
        UI.error(`Cannot open ${args.project}: no such directory`)
        process.exit(1)
      }
    }
    const opts = await resolveNetworkOptions(args)
    const directory = args.project ? process.cwd() : undefined
    const existingPort = opts.port
      ? (await probeWorkspaceServer(localServerBase(opts.port), Installation.VERSION))
        ? opts.port
        : undefined
      : await findWorkspaceServer(Installation.VERSION)
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (existingPort) {
      const target = localWorkspaceUrl(localServerBase(existingPort), directory)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, target)
      UI.empty()
      UI.println(UI.Style.TEXT_DIM, "  Using the OpenScience server that is already running.")
      openUrl(target)
      await announceFdaIfNeeded()
      return
    }

    const server = Server.listen(opts)

    const base = `http://localhost:${server.port}`
    if (opts.port === 0 && !LOCAL_WORKSPACE_PORTS.includes(server.port as (typeof LOCAL_WORKSPACE_PORTS)[number])) {
      const racedPort = await findWorkspaceServer(Installation.VERSION)
      if (racedPort) {
        await server.stop(true)
        const target = localWorkspaceUrl(localServerBase(racedPort), directory)
        UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, target)
        UI.empty()
        UI.println(UI.Style.TEXT_DIM, "  Using the OpenScience server started by the other launch.")
        openUrl(target)
        await announceFdaIfNeeded()
        return
      }
    }

    const target = localWorkspaceUrl(base, directory)
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, target)
    UI.empty()
    UI.println(UI.Style.TEXT_DIM, "  Opening your browser… if it doesn't open, visit the URL above.")

    if (process.env.OPENSCIENCE_RESTARTED !== "1") openUrl(target)

    // macOS-only: warn when the host explicitly denies protected-folder
    // access. System Settings opens only after a deliberate UI action.
    await announceFdaIfNeeded()

    // Wait for a termination signal. Without an explicit handler Bun keeps
    // the process alive (the catch-all promise never resolves) and Ctrl+C
    // is ignored.
    await new Promise<void>((resolve) => {
      const stop = () => resolve()
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
    })
    // Force-close sockets, then await the same bounded runtime/ledger disposal
    // used by the authenticated desktop handoff. A final watchdog still keeps
    // a broken native transport from trapping shutdown forever.
    const watchdog = setTimeout(() => process.exit(1), 10_000)
    watchdog.unref?.()
    try {
      await server.stop(true)
      await GracefulShutdown.run({ timeoutMs: 8_000 })
    } finally {
      clearTimeout(watchdog)
    }
  },
})
