import { For, Show, createMemo, createSignal } from "solid-js"
import { Button } from "@synsci/ui/button"
import { useDialog } from "@synsci/ui/context/dialog"
import { Icon } from "@synsci/ui/icon"
import { Select } from "@synsci/ui/select"
import type { Provider } from "@synsci/sdk/v2/client"
import { confirmDialog } from "@/atlas/dialogs"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useProviders } from "@/hooks/use-providers"
import { MODEL_PROVIDERS, MODEL_PROVIDER_LABELS, modelProvider } from "./model-providers"
import { ProviderLogo } from "./ProviderLogo"

/**
 * `note` says where a key that this panel cannot delete actually lives, so the
 * reader knows where to go and change it. Every non-removable source used to
 * render one blanket "external", which is wrong for a key the user
 * set themselves in a .env or a config file — nobody else manages it, and the
 * phrase suggests an administrator does.
 */
type ProviderSource = Provider["source"] | "managed"

const SOURCES: Record<ProviderSource, { label: string; removable: boolean; title: string; note?: string }> = {
  api: {
    label: "local file",
    removable: true,
    title: "API key stored in the owner-only OpenScience auth file, not the system keychain",
  },
  env: {
    label: "environment",
    removable: false,
    note: "set in your .env or shell",
    title: "API key supplied by an environment variable; remove it where it is defined",
  },
  config: {
    label: "config",
    removable: false,
    note: "set in openscience.json",
    title: "API key supplied by openscience.json; edit that file to remove it",
  },
  custom: {
    label: "custom",
    removable: false,
    note: "set in openscience.json",
    title: "Custom provider supplied by openscience.json; edit that file to remove it",
  },
  managed: {
    label: "Ace",
    removable: false,
    note: "managed through your Ace account",
    title: "Ace model access; manage it in the Ace section above",
  },
}

export function ProviderKeys(props: { onError?: (error: string | undefined) => void }) {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const providers = useProviders()
  const dialog = useDialog()
  const [provider, setProvider] = createSignal<string>(MODEL_PROVIDERS[0].id)
  const [key, setKey] = createSignal("")
  const [adding, setAdding] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const connected = createMemo(() =>
    providers
      .connected()
      .filter((item) => item.source !== "managed" && MODEL_PROVIDERS.some((provider) => provider.id === item.id)),
  )
  const source = (item: { id: string; source?: ProviderSource }) => SOURCES[item.source ?? "api"]
  const refreshAfterSave = (done: string) => {
    void sync
      .refreshProviders()
      .catch((error) =>
        props.onError?.(
          `${done}, but the model list could not be reloaded (${reason(error)}). It will catch up on the next refresh.`,
        ),
      )
  }
  const save = async () => {
    const value = key().trim()
    if (!value || saving()) return
    setSaving(true)
    props.onError?.(undefined)
    try {
      await sdk.client.auth.set({ providerID: provider(), auth: { type: "api", key: value } })
      setKey("")
      setAdding(false)
      // The credential is on disk now. Re-enable the form before rebuilding
      // the large provider catalog; auth.set already invalidates the server's
      // provider map, so disposing every workspace here only added latency.
      setSaving(false)
      refreshAfterSave("Key saved")
    } catch (error) {
      props.onError?.(reason(error))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (providerID: string) => {
    if (saving()) return
    const label = MODEL_PROVIDER_LABELS[providerID] ?? providerID
    const confirmed = await confirmDialog(dialog, {
      title: `Remove ${label} key?`,
      message:
        "This removes the saved API key from this machine. Provider access through other sources is not changed.",
      confirmLabel: "Remove key",
      danger: true,
    })
    if (!confirmed) return
    setSaving(true)
    props.onError?.(undefined)
    try {
      await sdk.client.auth.remove({ providerID })
      setSaving(false)
      refreshAfterSave("Key removed")
    } catch (error) {
      props.onError?.(reason(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="models-provider-keys">
      <div class="settings-row models-compact-row models-provider-key-heading">
        <div class="models-provider-identity">
          <span class="models-provider-key-heading__icon" aria-hidden="true">
            <Icon name="link" size="small" />
          </span>
          <div class="models-provider-copy">
            <span class="text-13-medium text-text-strong">Provider API keys</span>
            <span class="text-11-regular text-text-weak">Stored in the owner-only local auth file.</span>
          </div>
        </div>
        <span class="models-row-action">
          <Button
            class="settings-panel-action models-secondary-action"
            type="button"
            size="small"
            variant="secondary"
            aria-expanded={adding()}
            aria-controls="models-add-provider-key"
            disabled={saving()}
            onClick={() => {
              if (adding()) setKey("")
              setAdding((open) => !open)
            }}
          >
            {adding() ? "Cancel" : "Add key"}
          </Button>
        </span>
      </div>

      <Show when={adding()}>
        <form
          id="models-add-provider-key"
          class="settings-provider-key-form models-provider-key-form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label class="models-key-field">
            <span class="text-12-medium text-text-weak">Provider</span>
            <div class="models-provider-select">
              <span class="models-provider-select__mark">
                <ProviderLogo id={provider()} label={modelProvider(provider()).label} size="small" />
              </span>
              <Select
                aria-label="Model provider"
                class="models-provider-options"
                options={[...MODEL_PROVIDERS]}
                current={modelProvider(provider())}
                value={(item) => item.id}
                label={(item) => item.label}
                disabled={saving()}
                onSelect={(item) => item && setProvider(item.id)}
                variant="secondary"
                size="small"
                triggerVariant="settings"
                triggerStyle={{
                  width: "100%",
                  "justify-content": "space-between",
                  "padding-left": "34px",
                }}
              >
                {(item) => (
                  <Show when={item}>
                    {(entry) => (
                      <span class="flex min-w-0 items-center gap-2.5">
                        <ProviderLogo id={entry().id} label={entry().label} size="small" />
                        <span class="min-w-0 truncate">{entry().label}</span>
                      </span>
                    )}
                  </Show>
                )}
              </Select>
            </div>
          </label>
          <label class="models-key-field">
            <span class="text-12-medium text-text-weak">API key</span>
            <input
              type="password"
              autocomplete="off"
              spellcheck={false}
              disabled={saving()}
              value={key()}
              onInput={(event) => setKey(event.currentTarget.value)}
              placeholder={modelProvider(provider()).placeholder}
              class="settings-field settings-provider-key models-key-input"
            />
          </label>
          <Button
            class="settings-panel-action models-primary-action models-save-key"
            type="submit"
            size="small"
            variant="primary"
            disabled={saving() || !key().trim()}
          >
            {saving() ? "Saving…" : "Save key"}
          </Button>
        </form>
      </Show>

      <Show when={connected().length > 0}>
        <div class="models-connected-providers">
          <For each={connected()}>
            {(item) => (
              <div class="settings-row models-compact-row models-provider-row">
                <div class="models-provider-identity min-w-0 flex-1 basis-[220px]">
                  <ProviderLogo id={item.id} label={MODEL_PROVIDER_LABELS[item.id] ?? item.id} />
                  <div class="models-provider-copy">
                    <span class="truncate text-13-medium text-text-strong">
                      {MODEL_PROVIDER_LABELS[item.id] ?? item.id}
                    </span>
                    <div class="models-provider-meta">
                      <div class="settings-status" data-tone="ready">
                        <span class="settings-status__dot" aria-hidden="true" />
                        Available
                      </div>
                      <span class="models-provider-source" title={source(item).title}>
                        {source(item).label}
                      </span>
                    </div>
                  </div>
                </div>
                <Show
                  when={source(item).removable}
                  fallback={
                    <span class="models-provider-note text-11-regular text-text-weak" title={source(item).title}>
                      {source(item).note ?? "configured externally"}
                    </span>
                  }
                >
                  <span class="models-row-action">
                    <Button
                      class="settings-panel-action settings-panel-action--quiet models-secondary-action"
                      size="small"
                      variant="secondary"
                      disabled={saving()}
                      onClick={() => void remove(item.id)}
                    >
                      Remove
                    </Button>
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={connected().length === 0 && !adding()}>
        <p class="models-provider-empty" role="status">
          No provider API keys connected.
        </p>
      </Show>
    </div>
  )
}
