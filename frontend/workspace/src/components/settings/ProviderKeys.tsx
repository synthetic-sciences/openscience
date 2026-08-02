import { For, Show, createMemo, createSignal } from "solid-js"
import { Button } from "@synsci/ui/button"
import type { Provider } from "@synsci/sdk/v2/client"
import { StatusDot } from "@/atlas/shared/StatusDot"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useProviders } from "@/hooks/use-providers"
import { isUserProviderConnection } from "@/context/model-catalog"
import { MODEL_PROVIDERS, MODEL_PROVIDER_LABELS, modelProvider } from "./model-providers"

const SOURCES: Record<Provider["source"], { label: string; removable: boolean; title: string }> = {
  api: {
    label: "local file",
    removable: true,
    title: "API key stored in the owner-only OpenScience auth file, not the system keychain",
  },
  env: {
    label: "environment",
    removable: false,
    title: "API key supplied by an environment variable; remove it where it is defined",
  },
  config: {
    label: "config",
    removable: false,
    title: "API key supplied by openscience.json; edit that file to remove it",
  },
  custom: {
    label: "custom",
    removable: false,
    title: "Custom provider supplied by openscience.json; edit that file to remove it",
  },
}

export function ProviderKeys(props: { onError?: (error: string | undefined) => void }) {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const providers = useProviders()
  const [provider, setProvider] = createSignal<string>(MODEL_PROVIDERS[0].id)
  const [key, setKey] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const connected = createMemo(() =>
    providers
      .connected()
      .filter((item) => MODEL_PROVIDERS.some((provider) => provider.id === item.id))
      .filter((item) =>
        isUserProviderConnection({
          providerID: item.id,
          source: item.source,
          billing: sync.data.config.billing?.llm,
        }),
      ),
  )
  const source = (item: { id: string }) => SOURCES[(item as { source?: Provider["source"] }).source ?? "api"]

  const save = async () => {
    const value = key().trim()
    if (!value || saving()) return
    setSaving(true)
    props.onError?.(undefined)
    try {
      await sdk.client.auth.set({ providerID: provider(), auth: { type: "api", key: value } })
      setKey("")
      await sdk.client.global.dispose()
    } catch (error) {
      props.onError?.(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (providerID: string) => {
    if (!window.confirm(`Remove the ${MODEL_PROVIDER_LABELS[providerID] ?? providerID} key from this machine?`)) return
    props.onError?.(undefined)
    try {
      await sdk.client.auth.remove({ providerID })
      await sdk.client.global.dispose()
    } catch (error) {
      props.onError?.(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div class="flex flex-col gap-3">
      <form
        class="grid grid-cols-1 gap-2 rounded-[4px] border border-border-weak-base bg-surface-base/40 p-4 sm:grid-cols-[180px_1fr_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label class="flex flex-col gap-1.5">
          <span class="text-12-medium text-text-weak">Provider</span>
          <select
            value={provider()}
            onChange={(event) => setProvider(event.currentTarget.value)}
            class="h-8 rounded-[4px] border border-border-weak-base bg-surface-base px-2.5 text-13-regular text-text-strong outline-none focus:border-border-strong-base"
          >
            <For each={MODEL_PROVIDERS}>{(provider) => <option value={provider.id}>{provider.label}</option>}</For>
          </select>
        </label>
        <label class="flex min-w-0 flex-col gap-1.5">
          <span class="text-12-medium text-text-weak">API key</span>
          <input
            type="password"
            autocomplete="off"
            spellcheck={false}
            value={key()}
            onInput={(event) => setKey(event.currentTarget.value)}
            placeholder={modelProvider(provider()).placeholder}
            class="h-8 rounded-[4px] border border-border-weak-base bg-surface-base px-2.5 font-mono text-13-regular text-text-strong outline-none placeholder:text-text-weak focus:border-border-strong-base"
          />
        </label>
        <Button type="submit" size="small" variant="primary" disabled={saving() || !key().trim()}>
          {saving() ? "saving…" : "save key"}
        </Button>
      </form>

      <Show when={connected().length > 0}>
        <div class="overflow-hidden rounded-[4px] border border-border-weak-base bg-surface-base/40">
          <For each={connected()}>
            {(item) => (
              <div class="flex items-center justify-between gap-3 border-b border-border-weak-base px-4 py-3 last:border-none">
                <div class="flex min-w-0 items-center gap-2.5">
                  <StatusDot status="active" />
                  <span class="truncate text-13-medium text-text-strong">
                    {MODEL_PROVIDER_LABELS[item.id] ?? item.id}
                  </span>
                  <span
                    class="flex-shrink-0 rounded-[4px] border border-border-weak-base px-1.5 py-0.5 text-11-regular text-text-weak"
                    title={source(item).title}
                  >
                    {source(item).label}
                  </span>
                </div>
                <Show
                  when={source(item).removable}
                  fallback={
                    <span class="text-11-regular text-text-weak" title={source(item).title}>
                      managed externally
                    </span>
                  }
                >
                  <Button size="small" variant="secondary" onClick={() => void remove(item.id)}>
                    remove
                  </Button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
