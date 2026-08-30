import { Button } from "@synsci/ui/button"
import { For, Show, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { URLS } from "@/config/urls"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { settingsApi } from "./api"
import { formatCreditBalance, walletBalanceLabel } from "./credit-balance"
import { ProviderLogo } from "./ProviderLogo"

export { formatCreditBalance, walletBalanceLabel } from "./credit-balance"

type Mode = "managed" | "byok"
type BillingState = { llm: Mode | null; wallet?: { signedIn: boolean; balanceUsd: number | null } }
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
type AccountStatus = "idle" | "loading" | "ready" | "error"

const ACCOUNT_TIMEOUT_MS = 3_000

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

export async function withAccountDeadline<T>(request: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  const expired = new Promise<never>((_, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Ace account refresh timed out. Try again."))
      controller.abort()
    }, ms)
    controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true })
  })
  return Promise.race([Promise.resolve().then(() => request(controller.signal)), expired]).finally(() =>
    controller.abort(),
  )
}

const accountWallet = (signedIn: boolean): Wallet => ({
  signedIn,
  balanceUsd: null,
  billingMode: null,
  managedSupported: signedIn,
  managedUnlocked: false,
  aceEnabled: false,
})

export function ManagedInference(props: { onError?: (error: string | undefined) => void }) {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const fetchFn = platform.fetch ?? fetch
  const [state, setState] = createStore<{
    wallet?: Wallet
    mode: Mode
    saving: boolean
    signingIn: boolean
    refreshing: boolean
    account: AccountStatus
  }>({
    mode: normalizeMode(globalSync.data.config.billing?.llm),
    saving: false,
    signingIn: false,
    refreshing: false,
    account: "idle",
  })
  const pending: { wallet?: Promise<void>; refresh?: boolean } = {}
  const selected = createMemo(() => MODES.find((item) => item.value === state.mode) ?? MODES[0])

  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const fail = (error: unknown) => props.onError?.(reason(error))
  const loadWallet = () => {
    if (pending.wallet) return pending.wallet
    setState("account", "loading")
    const request = withAccountDeadline(
      (signal) => settingsApi<Wallet>(sdk.url, fetchFn, "/settings/wallet?summary=true", { signal }),
      ACCOUNT_TIMEOUT_MS,
    )
      .then((next) => {
        setState("wallet", next)
        setState("account", "ready")
        if (!state.saving && next.billingMode) setState("mode", normalizeMode(next.billingMode))
      })
      .catch((error) => {
        setState("account", "error")
        fail(error)
      })
      .finally(() => {
        if (pending.wallet !== request) return
        pending.wallet = undefined
        if (!pending.refresh) return
        pending.refresh = false
        void loadWallet()
      })
    pending.wallet = request
    return request
  }
  const loadBilling = () =>
    settingsApi<BillingState>(sdk.url, fetchFn, "/settings/billing")
      .then((next) => {
        if (!state.saving) setState("mode", normalizeMode(next.llm))
        if (!state.wallet && next.wallet) setState("wallet", accountWallet(next.wallet.signedIn))
      })
      .catch(fail)
  const refresh = () => {
    props.onError?.(undefined)
    void loadBilling()
    void loadWallet()
  }
  const syncProviders = (context: string) => {
    setState("refreshing", true)
    return globalSync
      .refreshProviders()
      .catch((error) =>
        props.onError?.(
          `${context}, but the model list could not be reloaded (${reason(error)}). It will catch up on the next refresh.`,
        ),
      )
      .finally(() => setState("refreshing", false))
  }
  const accountChanged = () => {
    props.onError?.(undefined)
    if (pending.wallet) pending.refresh = true
    void loadBilling()
    void loadWallet()
  }

  const update = (value: Mode) => {
    if (state.saving || (value === "managed" && !canSelectManaged(state.wallet))) return
    const previous = state.mode
    setState("mode", value)
    setState("saving", true)
    props.onError?.(undefined)
    void commitBilling(
      () =>
        settingsApi<BillingState>(sdk.url, fetchFn, "/settings/billing", {
          method: "PUT",
          body: JSON.stringify({ llm: value }),
        }),
      (data) => setState("mode", normalizeMode(data.llm)),
    )
      .then(() => {
        // The routing choice is already durable. Provider synchronization is
        // follow-up work and must not keep the controls feeling stuck.
        setState("saving", false)
        void syncProviders("Model access was saved")
      })
      .catch((error) => {
        setState("mode", previous)
        fail(error)
      })
      .finally(() => setState("saving", false))
  }

  const signIn = () => {
    if (state.signingIn) return
    setState("signingIn", true)
    props.onError?.(undefined)
    void settingsApi<LoginResult>(sdk.url, fetchFn, "/account/login-browser", { method: "POST" })
      .then((result) => {
        if (!result.ok) throw new Error(result.error || "Sign in did not complete. Try again.")
        window.dispatchEvent(new Event("openscience:account-changed"))
        void syncProviders("The Ace account changed")
      })
      .catch(fail)
      .finally(() => setState("signingIn", false))
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

  const managedUnavailable = () => state.wallet !== undefined && !canSelectManaged(state.wallet)
  const aceLabel = () => {
    if (!state.wallet) return state.account === "error" ? "Account unavailable" : "Ace account"
    if (!state.wallet.signedIn) return "Account required"
    if (!state.wallet.managedSupported) return "Ace unavailable"
    if (state.wallet.aceEnabled) return "Ace on"
    if (state.wallet.managedUnlocked) return "Wallet funded"
    if (state.wallet.balanceUsd === null) return "Account connected"
    return "No purchased balance"
  }
  const balanceLabel = () => {
    if (state.wallet && !state.wallet.signedIn) return walletBalanceLabel(state.wallet)
    if (!state.wallet || (state.account === "loading" && state.wallet.balanceUsd === null)) return "Purchased Wallet"
    return walletBalanceLabel(state.wallet)
  }
  const accountAction = () => {
    if (state.wallet && !state.wallet.signedIn) return state.signingIn ? "Waiting for browser…" : "Sign in"
    if (state.account === "error") return "Retry"
    if (!state.wallet || (state.account === "loading" && state.wallet.balanceUsd === null)) return "Open Wallet"
    if (state.wallet.balanceUsd === null && !state.wallet.managedUnlocked && !state.wallet.aceEnabled) return "Refresh"
    if (!state.wallet.managedSupported) return "Manage Wallet"
    if (!state.wallet.managedUnlocked) return "Turn on Ace"
    return state.wallet.aceEnabled ? "Manage Ace" : "Manage Wallet"
  }
  const actOnAccount = () => {
    if (state.wallet && !state.wallet.signedIn) {
      signIn()
      return
    }
    if (state.account === "error") {
      refresh()
      return
    }
    if (!state.wallet || (state.account === "loading" && state.wallet.balanceUsd === null)) {
      platform.openLink(URLS.dashboardBilling)
      return
    }
    if (state.wallet.balanceUsd === null && !state.wallet.managedUnlocked && !state.wallet.aceEnabled) {
      refresh()
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
                aria-pressed={state.mode === option.value}
                aria-busy={state.saving}
                disabled={state.saving || (option.value === "managed" && !canSelectManaged(state.wallet))}
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
            {state.saving ? `Saving ${selected().title}…` : selected().body}
            <Show when={!state.saving && state.refreshing}>
              <span class="models-routing__sync"> Updating model availability…</span>
            </Show>
          </p>
          <div class="models-routing__account">
            <span class="models-routing__account-state">{aceLabel()}</span>
            <span aria-live="polite" class="models-account-summary__balance">
              {balanceLabel()}
            </span>
            <Button
              class="settings-panel-action models-secondary-action"
              size="small"
              variant="secondary"
              disabled={state.signingIn}
              onClick={actOnAccount}
            >
              {accountAction()}
            </Button>
          </div>
        </div>
      </div>

      <Show when={state.wallet?.aceContract}>
        {(contract) => (
          <p class="settings-inline-note text-12-regular text-text-weak">{aceContractLabel(contract())}</p>
        )}
      </Show>

      <Show when={state.wallet && !state.wallet.signedIn}>
        <p class="settings-inline-note text-12-regular text-text-weak">
          Sign in to use purchased Wallet funds or authorize Ace. Your own provider connections remain separate.
        </p>
      </Show>
    </div>
  )
}
