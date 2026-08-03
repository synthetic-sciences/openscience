import { Show, createMemo, createSignal, type Component } from "solid-js"
import { Button } from "@synsci/ui/button"
import { StatusDot } from "@/atlas/shared/StatusDot"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { useProviders } from "@/hooks/use-providers"
import { credentialChange } from "./credential-change"

export const CodexConnection: Component<{
  onError?: (message: string | undefined) => void
  onConnected?: () => void
}> = (props) => {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const providers = useProviders()
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
    if (!window.confirm("Disconnect ChatGPT / Codex from this machine?")) return
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
    <div class="flex flex-col gap-3 rounded-[4px] border border-border-weak-base bg-surface-base/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="text-13-medium text-text-strong">Sign in with ChatGPT</span>
        <span class="text-12-regular text-text-weak">
          Keep Codex model access through your ChatGPT Plus, Pro, or Business plan.
        </span>
      </div>
      <Show
        when={!connected()}
        fallback={
          <div class="flex shrink-0 items-center gap-2">
            <StatusDot status="active" size={8} />
            <span class="text-12-regular text-text-weak">Connected</span>
            <Button size="small" variant="secondary" disabled={busy()} onClick={() => void disconnect()}>
              disconnect
            </Button>
          </div>
        }
      >
        <Button type="button" size="small" variant="primary" disabled={busy()} onClick={() => void connect()}>
          {busy() ? "waiting for ChatGPT…" : "Sign in with ChatGPT"}
        </Button>
      </Show>
    </div>
  )
}

export default CodexConnection
