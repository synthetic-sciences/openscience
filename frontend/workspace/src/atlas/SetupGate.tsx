// Headless first-run gate. Auto-opens the SetupDialog exactly once when a
// brand-new user (running server, nothing configured, not previously dismissed)
// lands, mirroring the terminal wizard's isConfigured() check (cli/onboard.ts):
// a connected non-demo provider OR an Atlas session OR a configured default
// model. Mounted once in the root Layout; renders nothing.
import { createEffect, createSignal } from "solid-js"
import { useDialog } from "@synsci/ui/context/dialog"
import { useServer } from "@/context/server"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { useProviders } from "@/hooks/use-providers"
import { openSetupDialog, readSetupDismissed } from "@/atlas/SetupDialog"
import { fetchSetupSession } from "@/atlas/setup-session"

export function SetupGate() {
  const dialog = useDialog()
  const server = useServer()
  const providers = useProviders()
  const globalSync = useGlobalSync()
  const platform = usePlatform()

  const [dismissed, setDismissed] = createSignal(readSetupDismissed())
  const [session, setSession] = createSignal(false)
  const [sessionLoaded, setSessionLoaded] = createSignal(false)
  let decided = false

  const loadSession = async () => {
    try {
      setSession(await fetchSetupSession(server.url, platform.fetch ?? fetch))
    } catch {
      setSession(false)
    } finally {
      setSessionLoaded(true)
    }
  }

  // "synsci" is the managed/demo provider — it can appear connected while signed
  // out, so it does NOT count as a real BYOK provider. Managed is captured via
  // the Atlas session instead.
  const configured = () =>
    providers.connected().some((p) => p.id !== "synsci") || session() || !!globalSync.data.config?.model

  // Resolve local session presence once the server is up. The setup gate makes
  // one decision per mount, so focus-driven refreshes only repeated work after
  // that decision and could never change the result.
  createEffect(() => {
    if (server.healthy() !== true) return
    void loadSession()
  })

  // Decide exactly once, and only after the shell is genuinely settled — a
  // healthy server, the global sync done (so the provider list is populated),
  // and the Atlas session resolved — so setup never flashes at an
  // already-configured user.
  createEffect(() => {
    if (decided) return
    if (dismissed()) return
    if (server.healthy() !== true) return
    if (!globalSync.data.ready) return
    if (!sessionLoaded()) return
    decided = true
    if (!configured()) openSetupDialog(dialog, () => setDismissed(true))
  })

  return null
}
