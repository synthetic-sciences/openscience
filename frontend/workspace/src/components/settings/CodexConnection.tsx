import { Show, createMemo, createSignal, type Component } from "solid-js"
import { Button } from "@synsci/ui/button"
import { useDialog } from "@synsci/ui/context/dialog"
import { confirmDialog } from "@/atlas/dialogs"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { useProviders } from "@/hooks/use-providers"
import { credentialChange } from "./credential-change"
import { ProviderLogo } from "./ProviderLogo"

export const CodexConnection: Component<{
  onError?: (message: string | undefined) => void
  onConnected?: () => void
}> = (props) => {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const providers = useProviders()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const connected = createMemo(() => providers.connected().some((provider) => provider.id === "openai-codex"))

  const connect = async () => {
    if (busy()) return
    setBusy(true)
    props.onError?.(undefined)
    // The sign-in only shows up once the catalog is re-read; waiting on the
    // event stream to say so is how a completed sign-in looked like a failed
    // one. The re-read can fail on its own though, and that is not the sign-in
    // failing — credentialChange keeps the two outcomes apart.
    const outcome = await credentialChange({
      write: async () => {
        const result = await sdk.client.provider.oauth.authorize({ providerID: "openai-codex", method: 0 })
        if (result.data?.url) platform.openLink(result.data.url)
        await sdk.client.provider.oauth.callback({ providerID: "openai-codex", method: 0 })
        await sdk.client.global.sync()
      },
      refresh: () => globalSync.refreshProviders(),
      done: "Signed in with ChatGPT",
    })
    setBusy(false)
    props.onError?.(outcome.notice)
    if (outcome.ok) props.onConnected?.()
  }

  const disconnect = async () => {
    const confirmed = await confirmDialog(dialog, {
      title: "Disconnect ChatGPT / Codex?",
      message: "This removes the saved sign-in from this machine. You can sign in again at any time.",
      confirmLabel: "Disconnect",
      danger: true,
    })
    if (!confirmed) return
    setBusy(true)
    props.onError?.(undefined)
    const outcome = await credentialChange({
      write: async () => {
        await sdk.client.auth.remove({ providerID: "openai-codex" })
        await sdk.client.global.dispose()
      },
      refresh: () => globalSync.refreshProviders(),
      done: "Disconnected",
    })
    setBusy(false)
    props.onError?.(outcome.notice)
  }

  return (
    <div class="models-connection-card">
      <div class="settings-row models-compact-row models-connection-row">
        <div class="models-connection-identity">
          <ProviderLogo id="openai-codex" label="OpenAI" />
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-13-medium text-text-strong">ChatGPT / Codex</span>
            <span class="text-12-regular text-text-weak">Use models included with your ChatGPT plan.</span>
          </div>
        </div>
        <Show
          when={!connected()}
          fallback={
            <div class="models-connection-actions">
              <div class="settings-status" data-tone="ready">
                <span class="settings-status__dot" aria-hidden="true" />
                Connected
              </div>
              <Button
                class="settings-panel-action settings-panel-action--quiet models-secondary-action"
                size="small"
                variant="secondary"
                disabled={busy()}
                onClick={() => void disconnect()}
              >
                Disconnect
              </Button>
            </div>
          }
        >
          <span class="models-row-action">
            <Button
              class="settings-panel-action models-primary-action"
              type="button"
              size="small"
              variant="primary"
              disabled={busy()}
              onClick={() => void connect()}
            >
              {busy() ? "Waiting for ChatGPT…" : "Sign in"}
            </Button>
          </span>
        </Show>
      </div>
    </div>
  )
}

export default CodexConnection
