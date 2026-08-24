import type { SettingsBillingGetResponse } from "@synsci/sdk/v2/client"
import { Button } from "@synsci/ui/button"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { URLS } from "@/config/urls"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { settingsApi } from "./api"
import { formatCreditBalance, walletBalanceLabel } from "./credit-balance"

export { formatCreditBalance, walletBalanceLabel } from "./credit-balance"

type Mode = SettingsBillingGetResponse["llm"]
type Wallet = {
  signedIn: boolean
  balanceUsd: number | null
  billingMode: "managed" | "byok" | null
  managedSupported: boolean
}

const MODES: { value: Mode; title: string; body: string }[] = [
  {
    value: null,
    title: "Automatic",
    body: "Use the selected model's best available account, local, or credit route.",
  },
  {
    value: "managed",
    title: "Credits",
    body: "Use your Ace wallet for supported models. No provider account is required.",
  },
  {
    value: "byok",
    title: "Accounts",
    body: "Use only connected provider accounts, keys, and eligible subscriptions.",
  },
]

/**
 * Persist and apply the small billing response independently of the much larger
 * provider-catalog refresh. The mode control must become usable as soon as the
 * save finishes; reloading every provider/model is follow-up synchronization,
 * not part of the button's acknowledgement path.
 */
export async function commitBilling<T>(write: () => Promise<{ data?: T }>, apply: (data: T) => void): Promise<boolean> {
  const result = await write()
  if (!result.data) return false
  apply(result.data)
  return true
}

export function ManagedInference(props: { onError?: (error: string | undefined) => void }) {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const [wallet, setWallet] = createSignal<Wallet>()
  const [mode, setMode] = createSignal<Mode>(globalSync.data.config.billing?.llm ?? null)
  const [busy, setBusy] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)
  const selected = createMemo(() => MODES.find((item) => item.value === mode()) ?? MODES[0])

  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const fail = (error: unknown) => {
    props.onError?.(reason(error))
  }
  const loadWallet = () =>
    settingsApi<Wallet>(sdk.url, platform.fetch ?? fetch, "/settings/wallet")
      .then(setWallet)
      .catch(fail)
  const loadBilling = () =>
    sdk.client.settings.billing
      .get()
      .then((result) => {
        if (result.data) {
          if (!busy()) setMode(result.data.llm)
          return
        }
        fail("Couldn't load model access settings.")
      })
      .catch(fail)
  const refresh = () => {
    props.onError?.(undefined)
    void Promise.all([loadWallet(), loadBilling()])
  }
  const update = (value: Mode) => {
    if (busy()) return
    const previous = mode()
    // Immediate visual acknowledgement: the network write may include account
    // synchronization, but the pressed state should never wait on that work.
    setMode(value)
    setBusy(true)
    props.onError?.(undefined)
    void commitBilling(
      () => sdk.client.settings.billing.update({ llm: value }),
      (data) => {
        setMode(data.llm)
      },
    )
      .then((ok) => {
        if (!ok) {
          setMode(previous)
          fail("Couldn't save model access settings.")
          return
        }

        // Re-enable the mode controls before the multi-scope provider catalog
        // reload. This fetch can be several megabytes and must not make the
        // already-saved setting feel stuck.
        setBusy(false)
        setRefreshing(true)
        void globalSync
          .refreshProviders()
          .catch((error) =>
            props.onError?.(
              `Model access was saved, but the model list could not be reloaded (${reason(error)}). It will catch up on the next refresh.`,
            ),
          )
          .finally(() => setRefreshing(false))
      })
      .catch((error) => {
        setMode(previous)
        fail(error)
      })
      .finally(() => setBusy(false))
  }

  // The mode can change without this panel touching it: saving an own provider
  // key in Provider keys below makes the server flip billing.llm managed →
  // byok (Auth.set). That happens in the same window, so no `focus` event ever
  // fires and the toggle would keep showing Credits — highlighted, and
  // contradicting the row underneath — until a reload. Every credential change
  // already funnels through refreshProviders, so re-read the mode there.
  const unsubscribe = globalSync.onProvidersRefreshed(() => void loadBilling())

  onMount(() => {
    refresh()
    window.addEventListener("focus", refresh)
  })
  onCleanup(() => {
    window.removeEventListener("focus", refresh)
    unsubscribe()
  })

  const unsupported = (value: Mode) =>
    value === "managed" && wallet() !== undefined && (!wallet()!.signedIn || !wallet()!.managedSupported)

  return (
    <div class="models-inference">
      <div class="models-routing" aria-label="Inference routing">
        <div
          class="models-routing__options"
          role="group"
          aria-label="Inference routing mode"
          aria-describedby="managed-inference-description"
        >
          <For each={MODES}>
            {(option) => (
              <button
                type="button"
                aria-pressed={mode() === option.value}
                aria-busy={busy()}
                disabled={busy() || unsupported(option.value)}
                class="models-routing__option"
                title={
                  unsupported(option.value)
                    ? "Credits require a signed-in Synthetic Sciences account with Ace enabled"
                    : undefined
                }
                onClick={() => update(option.value)}
              >
                <span class="models-routing__option-label">
                  <span>{option.title}</span>
                </span>
              </button>
            )}
          </For>
        </div>
        <p id="managed-inference-description" class="models-routing__description" aria-live="polite">
          {busy() ? `Saving ${selected().title.toLowerCase()}…` : selected().body}
          <Show when={!busy() && refreshing()}>
            <span class="models-routing__sync"> Updating model availability…</span>
          </Show>
        </p>
      </div>

      <div class="settings-row models-compact-row models-account-summary">
        <div class="models-account-summary__identity">
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-12-regular text-text-weak">Wallet balance</span>
            <span aria-live="polite">
              <Show when={wallet()} fallback={<span class="text-13-medium text-text-weak">Checking account…</span>}>
                <span class="models-account-summary__balance text-13-medium text-text-strong">
                  {walletBalanceLabel(wallet()!)}
                </span>
              </Show>
            </span>
          </div>
        </div>
        <span class="models-row-action">
          <Button
            class="settings-panel-action models-secondary-action"
            size="small"
            variant="secondary"
            onClick={() => platform.openLink(URLS.dashboardBilling)}
          >
            Open billing
          </Button>
        </span>
      </div>

      <Show when={wallet() && !wallet()!.signedIn}>
        <p class="settings-inline-note text-12-regular text-text-weak">
          Sign in from General to use Credits. Automatic routing and connected accounts remain available.
        </p>
      </Show>
    </div>
  )
}
