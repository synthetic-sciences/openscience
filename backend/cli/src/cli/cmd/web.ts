import { Server } from "../../server/server"
import { OpenScience } from "../../openscience"
import { Installation } from "../../installation"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { openUrl } from "../../util/open-url"
import { probeProtectedFolderAccess } from "../../file/protected-folder-access"
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

    // Run the dashboard sync BEFORE starting the server — and without
    // the 5s race timeout the global middleware uses. The model picker
    // and provider whitelist live in ~/.config/openscience/openscience-synced.json;
    // Config.state() reads that file once on first request and caches
    // for the process lifetime. If we start the HTTP server first, the
    // browser can race the sync and the picker shows the previous run's
    // catalogue. Doing it here, await-ed, guarantees the next browser
    // request sees the freshly-synced whitelist.
    const authed = await OpenScience.isAuthenticated()
    if (authed) {
      // Sync managed config before binding so the browser's first request sees
      // the fresh provider whitelist. But cap the wait: syncServices() has no
      // internal timeout, so a slow/unresponsive backend would otherwise hang
      // the launch forever (the server never binds). If the sync outlasts the
      // cap, bind anyway and let it finish in the background — the global
      // middleware also syncs per-request as a backstop.
      const SYNC_BUDGET_MS = 6000
      const synced = OpenScience.syncServices().catch(() => null)
      const result = await Promise.race([
        synced,
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), SYNC_BUDGET_MS)),
      ])
      if (result === "timeout") {
        UI.println(
          UI.Style.TEXT_DIM,
          "  (managed-config sync is slow — continuing; the model picker will refresh shortly)",
        )
        UI.empty()
      } else if (result) {
        const noun = result.credentials === 1 ? "credential" : "credentials"
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  ✓ Synced",
          UI.Style.TEXT_NORMAL,
          `${result.credentials} ${noun} from connected services`,
        )
        UI.empty()
      } else {
        UI.println(UI.Style.TEXT_DIM, "  (sync skipped — using cached config from previous run)")
        UI.empty()
      }
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
    // Hard-exit on Ctrl+C. Force-close active connections first, but never let
    // a stalled server.stop() (long-lived `/event` SSE streams) or an in-flight
    // background config sync (a pending fetch keeps Bun's loop alive) block the
    // exit — a watchdog forces it, and process.exit ignores dangling sockets.
    const watchdog = setTimeout(() => process.exit(0), 2000)
    watchdog.unref?.()
    try {
      await server.stop(true)
    } catch {
      // ignore — exiting regardless
    }
    process.exit(0)
  },
})
