// Headless first-run gate. Auto-opens the SetupDialog exactly once when a
// brand-new user (running server, nothing configured, not previously dismissed)
// lands, mirroring the terminal wizard's isConfigured() check (cli/onboard.ts):
// a connected non-demo provider OR an Atlas session OR a configured default
// model. Mounted once in the root Layout; renders nothing.
import { createEffect, onCleanup, onMount, createSignal } from "solid-js"
import { useDialog } from "@synsci/ui/context/dialog"
import { useServer } from "@/context/server"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useProviders } from "@/hooks/use-providers"
import { openSetupDialog, readSetupDismissed } from "@/thesis/SetupDialog"

export function SetupGate() {
  const dialog = useDialog()
  const server = useServer()
  const providers = useProviders()
  const globalSync = useGlobalSync()
  const sdk = useGlobalSDK()

  const [dismissed, setDismissed] = createSignal(readSetupDismissed())
  const [session, setSession] = createSignal(false)
  const [sessionLoaded, setSessionLoaded] = createSignal(false)
  let decided = false

  const loadSession = async () => {
    try {
      const acc = (await sdk.client.account.get()) as { data?: { session?: boolean }; session?: boolean }
      setSession((acc?.data ?? acc)?.session === true)
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

  // Resolve the Atlas session once the server is up, and refresh on focus so a
  // sign-in (or logout) elsewhere is reflected.
  createEffect(() => {
    if (server.healthy() !== true) return
    void loadSession()
  })
  onMount(() => {
    const focus = () => {
      if (server.healthy() === true) void loadSession()
    }
    window.addEventListener("focus", focus)
    onCleanup(() => window.removeEventListener("focus", focus))
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
