import { Server } from "../../server/server"
import { OpenScience } from "../../openscience"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import open from "open"
import { openUrl } from "../../util/open-url"
import { needsOnboarding, runOnboarding, isConfigured } from "../onboard"
import fs from "fs/promises"
import os from "os"
import path from "path"

// macOS TCC probe: try to read ~/Desktop, which is one of the canonical
// dirs blocked unless the running binary has Full Disk Access. An empty
// Desktop dir is rare enough that we treat 0-entries OR EACCES/EPERM as
// "FDA missing" — both are actionable signals on the user's end.
async function probeMacFda(): Promise<{ blocked: boolean; reason?: string }> {
  if (process.platform !== "darwin") return { blocked: false }
  const desktop = path.join(os.homedir(), "Desktop")
  try {
    const entries = await fs.readdir(desktop)
    if (entries.length > 0) return { blocked: false }
    return { blocked: true, reason: "openscience returned 0 entries for ~/Desktop (TCC likely blocking)" }
  } catch (err: any) {
    if (err?.code === "EACCES" || err?.code === "EPERM") {
      return { blocked: true, reason: err.message }
    }
    // ENOENT, etc. — Desktop doesn't exist on this machine; nothing to warn about.
    return { blocked: false }
  }
}

const FDA_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"

async function announceFdaIfNeeded() {
  const result = await probeMacFda()
  if (!result.blocked) return
  const binary = process.execPath || "openscience"
  UI.empty()
  UI.println(UI.Style.TEXT_WARNING_BOLD + "  ⚠  Full Disk Access required", UI.Style.TEXT_NORMAL)
  UI.empty()
  UI.println(
    UI.Style.TEXT_NORMAL,
    "  macOS is blocking OpenScience from listing ~/Desktop, ~/Documents and ~/Downloads.",
  )
  UI.println(UI.Style.TEXT_NORMAL, "  Without Full Disk Access the folder picker and file tree will be empty.")
  UI.empty()
  UI.println(UI.Style.TEXT_INFO_BOLD + "  Grant access:", UI.Style.TEXT_NORMAL)
  UI.println(UI.Style.TEXT_NORMAL, "    1. The Privacy & Security pane just opened — find “Full Disk Access”")
  UI.println(UI.Style.TEXT_NORMAL, "    2. Click +, hit ⌘⇧G, paste the path below, click Open")
  UI.println(UI.Style.TEXT_NORMAL, "    3. Toggle the openscience entry on")
  UI.println(UI.Style.TEXT_NORMAL, "    4. Quit (Ctrl+C) and relaunch `openscience web`")
  UI.empty()
  UI.println(UI.Style.TEXT_INFO_BOLD + "  Path to add:", UI.Style.TEXT_NORMAL, "  " + binary)
  UI.empty()
  // Open System Settings pre-positioned on the FDA pane.
  open(FDA_SETTINGS_URL).catch(() => {})
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
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    // First launch on this machine with nothing configured → walk the user
    // through setup (managed vs BYOK vs skip) before we bind the server, so
    // the browser's first request already sees a usable model.
    if (await needsOnboarding()) {
      await runOnboarding()
      UI.empty()
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
    if (!authed) {
      // Only nudge when there's genuinely no way to run a model. A BYOK key
      // (env var or `keys add`) is a first-class, account-free setup — don't
      // badger those users to connect Atlas.
      if (!(await isConfigured())) {
        UI.println(UI.Style.TEXT_WARNING_BOLD + "  ⚠  No model configured", UI.Style.TEXT_NORMAL)
        UI.println(
          UI.Style.TEXT_NORMAL,
          "  Run `openscience login` for Atlas managed models, or `openscience keys add` for your own key.",
        )
        UI.println(UI.Style.TEXT_DIM, "  Continuing with free demo models for now.")
        UI.empty()
      }
    } else {
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
    UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, base)
    UI.empty()
    UI.println(UI.Style.TEXT_DIM, "  Opening your browser… if it doesn't open, visit the URL above.")

    openUrl(base)

    // macOS-only: warn the user (and pop System Settings) if Full Disk
    // Access is missing — without it the folder picker and file tree silently
    // return empty for ~/Desktop, ~/Documents, ~/Downloads.
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
