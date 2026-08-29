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
  managedUnlocked: boolean
  aceEnabled: boolean
}

export const canSelectManaged = (wallet: Wallet | undefined) =>
  Boolean(wallet?.signedIn && wallet.managedSupported && wallet.managedUnlocked)

const MODES: { value: Mode; title: string; body: string }[] = [
  {
    value: "byok",
    title: "BYOK / Subscription",
    body: "Use connected provider keys or models included with an eligible subscription.",
  },
  {
    value: "managed",
    title: "Managed",
    body: "Use your Wallet balance for supported models without configuring a provider key.",
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

export async function refreshAccount(
  wallet: () => Promise<unknown>,
  billing: () => Promise<unknown>,
  providers: () => Promise<unknown>,
): Promise<void> {
  await Promise.all([wallet(), billing(), providers()])
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
  const sync = (context: string) => {
    setRefreshing(true)
    return globalSync
      .refreshProviders()
      .catch((error) =>
        props.onError?.(
          `${context}, but the model list could not be reloaded (${reason(error)}). It will catch up on the next refresh.`,
        ),
      )
      .finally(() => setRefreshing(false))
  }
  const account = () => {
    props.onError?.(undefined)
    void refreshAccount(loadWallet, loadBilling, () => sync("The funding account changed"))
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
        void sync("Model access was saved")
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
    window.addEventListener("openscience:account-changed", account)
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
    window.removeEventListener("openscience:account-changed", account)
    unsubscribe()
  })

  const managedUnavailable = () => wallet() !== undefined && !canSelectManaged(wallet())
  const aceLabel = () => {
    if (!wallet()) return "Checking account"
    if (!wallet()!.signedIn) return "Account required"
    if (!wallet()!.managedSupported) return "Managed unavailable"
    if (!wallet()!.managedUnlocked) return "No Wallet balance"
    if (wallet()!.aceEnabled) return "Ace on"
    return "Wallet funded"
  }
  const aceAction = () => {
    if (!wallet()?.signedIn) return "Sign in"
    if (!wallet()?.managedSupported) return "Manage Wallet"
    if (!wallet()?.managedUnlocked) return "Turn on Ace"
    return wallet()?.aceEnabled ? "Manage Ace" : "Manage Wallet"
  }

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
                disabled={busy() || (option.value === "managed" && !canSelectManaged(wallet()))}
                class="models-routing__option"
                title={
                  option.value === "managed" && managedUnavailable()
                    ? "Add Wallet funds or turn on Ace to use Managed models"
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
        <div class="models-routing__details">
          <p id="managed-inference-description" class="models-routing__description" aria-live="polite">
            {busy() ? `Saving ${selected().title.toLowerCase()}…` : selected().body}
            <Show when={!busy() && refreshing()}>
              <span class="models-routing__sync"> Updating model availability…</span>
            </Show>
          </p>
          <Show when={mode() === "managed" || managedUnavailable()}>
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
                {aceAction()}
              </Button>
            </div>
          </Show>
        </div>
      </div>

      <Show when={wallet() && !wallet()!.signedIn}>
        <p class="settings-inline-note text-12-regular text-text-weak">
          Managed access requires a Synthetic Sciences account with Wallet funds or Ace auto reload.
        </p>
      </Show>
    </div>
  )
}
