import { Show, createSignal, type JSX } from "solid-js"
import { Dialog } from "@synsci/ui/dialog"
import { useDialog } from "@synsci/ui/context/dialog"
import { Button } from "@synsci/ui/button"
import { TextField } from "@synsci/ui/text-field"
import { settingsApi } from "@/components/settings/api"
import { URLS } from "@/config/urls"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"

/** Kept for compatibility with callers from older workspace bundles. Account
 * setup can no longer be dismissed in favor of an accountless provider path. */
export const SETUP_DISMISS_KEY = "openscience.setup.dismissed"
export function readSetupDismissed(): boolean {
  return false
}

export function openSetupDialog(dialog: ReturnType<typeof useDialog>, onConnected?: () => void) {
  dialog.show(() => <SetupDialog onConnected={onConnected} />)
}

export function SetupDialog(props: { onConnected?: () => void }): JSX.Element {
  const dialog = useDialog()
  const server = useServer()
  const platform = usePlatform()
  const [key, setKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const connect = async () => {
    const value = key().trim()
    if (!value || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await settingsApi<{ ok: boolean; error?: string }>(
        server.url,
        platform.fetch ?? fetch,
        "/account/login-key",
        { method: "POST", body: JSON.stringify({ key: value }) },
      )
      if (!result.ok) {
        setError(result.error || "That key was not accepted. Check it and try again.")
        return
      }
      props.onConnected?.()
      dialog.close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect this device.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Connect OpenScience">
      <div style={{ display: "flex", "flex-direction": "column", gap: "14px", "max-width": "360px" }}>
        <p class="text-13-regular text-text-weak" style={{ margin: 0, "line-height": 1.55 }}>
          Sign in to Synthetic Sciences once. This device stays connected with a revocable API key.
        </p>
        <div>
          <Button variant="primary" size="small" onClick={() => platform.openLink(URLS.dashboardCli)}>
            Open Synthetic Sciences
          </Button>
        </div>
        <label style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
          <span class="text-12-medium text-text-weak">Synthetic Sciences API key</span>
          <TextField
            type="password"
            hideLabel
            placeholder="thk_…"
            value={key()}
            disabled={busy()}
            onChange={setKey}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              void connect()
            }}
          />
        </label>
        <Show when={error()}>
          <p class="text-12-regular" style={{ margin: 0, color: "var(--color-error)" }} role="status">
            {error()}
          </p>
        </Show>
        <div style={{ display: "flex", "justify-content": "flex-end", "min-height": "36px" }}>
          <Button variant="primary" size="small" disabled={busy() || !key().trim()} onClick={() => void connect()}>
            {busy() ? "Connecting…" : "Continue"}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
