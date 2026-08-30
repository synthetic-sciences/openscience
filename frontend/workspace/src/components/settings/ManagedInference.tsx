import { Button } from "@synsci/ui/button"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { URLS } from "@/config/urls"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { settingsApi } from "./api"
import { formatCreditBalance, walletBalanceLabel } from "./credit-balance"
import { ProviderLogo } from "./ProviderLogo"

export { formatCreditBalance, walletBalanceLabel } from "./credit-balance"

type Mode = "managed" | "byok"
type BillingState = { llm: Mode | null }
type LoginResult = { ok: boolean; error?: string }
type Wallet = {
  signedIn: boolean
  balanceUsd: number | null
  billingMode: Mode | null
  managedSupported: boolean
  managedUnlocked: boolean
  aceEnabled: boolean
  aceContract?: {
    activationAuthorizationUsd: number
    reloadThresholdUsd: number
    reloadAmountUsd: number
    serviceMarginPercent: number
    processingFeeDisclosedSeparately: boolean
    reloadControlledByAce: boolean
  }
}

export const canSelectManaged = (wallet: Wallet | undefined) =>
  Boolean(wallet?.signedIn && wallet.managedSupported && wallet.managedUnlocked)

export function aceContractLabel(contract: NonNullable<Wallet["aceContract"]>) {
  return `Ace is a $${contract.activationAuthorizationUsd} authorization, not a purchase or subscription. While Ace is on, a purchased Wallet balance below $${contract.reloadThresholdUsd} triggers one fixed $${contract.reloadAmountUsd} reload; the processing fee is disclosed separately before payment.`
}

const MODES: { value: Mode; title: string; body: string }[] = [
  {
    value: "byok",
    title: "BYOK / Subscription",
    body: "Use connected provider keys or models included with an eligible subscription.",
  },
  {
    value: "managed",
    title: "Ace",
    body: "Use supported models with your purchased Wallet balance, without configuring provider keys.",
  },
]

const normalizeMode = (value: unknown): Mode => (value === "managed" ? "managed" : "byok")

/** Apply the small routing write before refreshing the much larger catalog. */
export async function commitBilling<T>(write: () => Promise<T>, apply: (data: T) => void): Promise<void> {
  const result = await write()
  apply(result)
}

export function ManagedInference(props: { onError?: (error: string | undefined) => void }) {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const fetchFn = platform.fetch ?? fetch
  const [wallet, setWallet] = createSignal<Wallet>()
  const [mode, setMode] = createSignal<Mode>(normalizeMode(globalSync.data.config.billing?.llm))
  const [saving, setSaving] = createSignal(false)
  const [signingIn, setSigningIn] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)
  const selected = createMemo(() => MODES.find((item) => item.value === mode()) ?? MODES[0])

  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const fail = (error: unknown) => props.onError?.(reason(error))
  const loadWallet = () =>
    settingsApi<Wallet>(sdk.url, fetchFn, "/settings/wallet")
      .then((next) => {
        setWallet(next)
        if (!saving() && next.billingMode) setMode(normalizeMode(next.billingMode))
      })
      .catch(fail)
  const loadBilling = () =>
    settingsApi<BillingState>(sdk.url, fetchFn, "/settings/billing")
      .then((next) => {
        if (!saving()) setMode(normalizeMode(next.llm))
      })
      .catch(fail)
  const refresh = () => {
    props.onError?.(undefined)
    void Promise.all([loadWallet(), loadBilling()])
  }
  const syncProviders = (context: string) => {
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
  const accountChanged = () => {
    props.onError?.(undefined)
    void Promise.all([loadWallet(), loadBilling()])
  }

  const update = (value: Mode) => {
    if (saving() || (value === "managed" && !canSelectManaged(wallet()))) return
    const previous = mode()
    setMode(value)
    setSaving(true)
    props.onError?.(undefined)
    void commitBilling(
      () =>
        settingsApi<BillingState>(sdk.url, fetchFn, "/settings/billing", {
          method: "PUT",
          body: JSON.stringify({ llm: value }),
        }),
      (data) => setMode(normalizeMode(data.llm)),
    )
      .then(() => {
        // The routing choice is already durable. Provider synchronization is
        // follow-up work and must not keep the controls feeling stuck.
        setSaving(false)
        void syncProviders("Model access was saved")
      })
      .catch((error) => {
        setMode(previous)
        fail(error)
      })
      .finally(() => setSaving(false))
  }

  const signIn = () => {
    if (signingIn()) return
    setSigningIn(true)
    props.onError?.(undefined)
    void settingsApi<LoginResult>(sdk.url, fetchFn, "/account/login-browser", { method: "POST" })
      .then((result) => {
        if (!result.ok) throw new Error(result.error || "Sign in did not complete. Try again.")
        window.dispatchEvent(new Event("openscience:account-changed"))
        void syncProviders("The Ace account changed")
      })
      .catch(fail)
      .finally(() => setSigningIn(false))
  }

  const unsubscribe = globalSync.onProvidersRefreshed(() => void loadBilling())
  onMount(() => {
    refresh()
    window.addEventListener("focus", refresh)
    window.addEventListener("openscience:account-changed", accountChanged)
  })
  onCleanup(() => {
    window.removeEventListener("focus", refresh)
    window.removeEventListener("openscience:account-changed", accountChanged)
    unsubscribe()
  })

  const managedUnavailable = () => wallet() !== undefined && !canSelectManaged(wallet())
  const aceLabel = () => {
    if (!wallet()) return "Checking account"
    if (!wallet()!.signedIn) return "Account required"
    if (!wallet()!.managedSupported) return "Ace unavailable"
    if (!wallet()!.managedUnlocked) return "No purchased balance"
    if (wallet()!.aceEnabled) return "Ace on"
    return "Wallet funded"
  }
  const accountAction = () => {
    if (!wallet()?.signedIn) return signingIn() ? "Waiting for browser…" : "Sign in"
    if (!wallet()?.managedSupported) return "Manage Wallet"
    if (!wallet()?.managedUnlocked) return "Turn on Ace"
    return wallet()?.aceEnabled ? "Manage Ace" : "Manage Wallet"
  }
  const actOnAccount = () => {
    if (!wallet()?.signedIn) {
      signIn()
      return
    }
    platform.openLink(URLS.dashboardBilling)
  }

  return (
    <div class="models-inference">
      <div class="models-routing" aria-label="Model access">
        <div class="models-routing__identity">
          <ProviderLogo id="synsci" label="Ace" />
          <div class="models-routing__identity-copy">
            <strong>Ace</strong>
            <span>Managed models, one purchased Wallet.</span>
          </div>
        </div>
        <div
          class="models-routing__options"
          role="group"
          aria-label="Model access mode"
          aria-describedby="managed-inference-description"
        >
          <For each={MODES}>
            {(option) => (
              <button
                type="button"
                aria-pressed={mode() === option.value}
                aria-busy={saving()}
                disabled={saving() || (option.value === "managed" && !canSelectManaged(wallet()))}
                class="models-routing__option"
                title={
                  option.value === "managed" && managedUnavailable()
                    ? "Sign in, add purchased Wallet funds, or turn on Ace to use managed models"
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
            {saving() ? `Saving ${selected().title}…` : selected().body}
            <Show when={!saving() && refreshing()}>
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
              disabled={signingIn()}
              onClick={actOnAccount}
            >
              {accountAction()}
            </Button>
          </div>
        </div>
      </div>

      <Show when={wallet()?.aceContract}>
        {(contract) => (
          <p class="settings-inline-note text-12-regular text-text-weak">{aceContractLabel(contract())}</p>
        )}
      </Show>

      <Show when={wallet() && !wallet()!.signedIn}>
        <p class="settings-inline-note text-12-regular text-text-weak">
          Sign in to use purchased Wallet funds or authorize Ace. Your own provider connections remain separate.
        </p>
      </Show>
    </div>
  )
}
