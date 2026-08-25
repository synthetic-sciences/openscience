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

type Mode = Exclude<SettingsBillingGetResponse["llm"], null>
type Wallet = {
  signedIn: boolean
  balanceUsd: number | null
  billingMode: "managed" | "byok" | null
  managedSupported: boolean
  aceEnabled: boolean
}

const MODES: { value: Mode; title: string; body: string }[] = [
  {
    value: "byok",
    title: "BYOK / Subscription",
    body: "Use connected provider keys or models included with an eligible subscription.",
  },
  {
    value: "managed",
    title: "Managed",
    body: "Use your Ace balance for supported models without configuring a provider key.",
  },
]

const normalizeMode = (value: SettingsBillingGetResponse["llm"] | undefined): Mode =>
  value === "managed" ? "managed" : "byok"

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
  const [mode, setMode] = createSignal<Mode>(normalizeMode(globalSync.data.config.billing?.llm))
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
          if (!busy()) setMode(normalizeMode(result.data.llm))
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
    if (
      value === "managed" &&
      wallet() &&
      (!wallet()!.signedIn || !wallet()!.managedSupported || !wallet()!.aceEnabled)
    ) {
      platform.openLink(URLS.dashboardBilling)
      return
    }
    const previous = mode()
    // Immediate visual acknowledgement: the network write may include account
    // synchronization, but the pressed state should never wait on that work.
    setMode(value)
    setBusy(true)
    props.onError?.(undefined)
    void commitBilling(
      () => sdk.client.settings.billing.update({ llm: value }),
      (data) => {
        setMode(normalizeMode(data.llm))
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
    const visibility = () => {
      if (document.visibilityState === "visible") void loadWallet()
    }
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadWallet()
    }, 15_000)
    document.addEventListener("visibilitychange", visibility)
    onCleanup(() => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", visibility)
    })
  })
  onCleanup(() => {
    window.removeEventListener("focus", refresh)
    unsubscribe()
  })

  const needsAce = () => wallet() !== undefined && (!wallet()!.signedIn || !wallet()!.aceEnabled)
  const aceLabel = () => {
    if (!wallet()) return "Checking account"
    if (!wallet()!.signedIn) return "Account required"
    if (wallet()!.aceEnabled) return "Ace on"
    return "Ace off"
  }

  return (
    <div class="models-inference">
      <div class="models-routing" aria-label="Inference routing">
        <div class="models-routing__header">
          <div class="models-routing__title">
            <span class="text-13-medium text-text-strong">Model access</span>
            <span class="text-11-regular text-text-weak">Choose who bills each model call.</span>
          </div>
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
                  disabled={busy() || wallet() === undefined}
                  class="models-routing__option"
                  title={option.value === "managed" && needsAce() ? "Enable Ace to use Managed models" : undefined}
                  onClick={() => update(option.value)}
                >
                  <span class="models-routing__option-label">
                    <span>{option.title}</span>
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
        <div class="models-routing__details">
          <p id="managed-inference-description" class="models-routing__description" aria-live="polite">
            {busy() ? `Saving ${selected().title.toLowerCase()}…` : selected().body}
            <Show when={!busy() && refreshing()}>
              <span class="models-routing__sync"> Updating model availability…</span>
            </Show>
          </p>
          <div class="models-routing__account">
            <span class="models-routing__account-state">{aceLabel()}</span>
            <span aria-live="polite" class="models-account-summary__balance">
              <Show when={wallet()} fallback="Checking balance…">
                {walletBalanceLabel(wallet()!)}
              </Show>
            </span>
            <Button
              class="settings-panel-action models-secondary-action"
              size="small"
              variant="secondary"
              onClick={() => platform.openLink(URLS.dashboardBilling)}
            >
              {!wallet()?.signedIn ? "Sign in" : needsAce() ? "Turn on Ace" : "Manage Ace"}
            </Button>
          </div>
        </div>
      </div>

      <Show when={wallet() && !wallet()!.signedIn}>
        <p class="settings-inline-note text-12-regular text-text-weak">
          Managed access requires a Synthetic Sciences account with Ace enabled.
        </p>
      </Show>
    </div>
  )
}
