import { Button } from "@synsci/ui/button"
import { For, Show, createMemo, createUniqueId, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { URLS } from "@/config/urls"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { settingsApi } from "./api"
import { LoginApproval } from "./LoginApproval"
import { formatCreditBalance } from "./credit-balance"
import { createAccountRecovery } from "./account-recovery"
import { ACCOUNT_DEADLINE_MS } from "./account-deadline"

export { formatCreditBalance, walletBalanceLabel } from "./credit-balance"

type Mode = "managed" | "byok"
type BillingState = { llm: Mode | null; wallet?: { signedIn: boolean; balanceUsd: number | null } }
type LoginResult = { ok: boolean; error?: string }
type Wallet = {
  signedIn: boolean
  balanceUsd: number | null
  /** The purchased balance minus holds for turns in flight; absent when the server does not know it. */
  availableUsd?: number | null
  balanceRedacted?: boolean
  accessVerified?: boolean
  billingMode: Mode | null
  managedSupported: boolean
  managedUnlocked: boolean
  aceEnabled: boolean
  aceContract?: {
    activationAuthorizationUsd: number
    reloadThresholdUsd: number
    reloadAmountUsd: number
    processingFeeDisclosedSeparately: boolean
    reloadControlledByAce: boolean
  }
  /** The workspace the credential is billed to, when the account named it. */
  workspace?: { organizationId: string; name: string; personal: boolean }
  /** browser: a device key from sign-in; key: an API key the user pasted. */
  origin?: "browser" | "key"
  /** True when these are the stored values and the server is reading newer ones. */
  refreshing?: boolean
  refreshedAt?: number | null
  /** Why the server's latest refresh failed while stored values are shown. */
  error?: string
}
type AccountStatus = "idle" | "loading" | "ready" | "error"
type Services = {
  sdk: Pick<ReturnType<typeof useGlobalSDK>, "url">
  sync: {
    data: { config: { billing?: { llm?: Mode | null } } }
    refreshProviders: (options?: { force?: boolean }) => Promise<void>
    onProvidersRefreshed: (callback: () => void) => () => void
    onAccountRefreshed: (callback: () => void) => () => void
  }
  platform: Pick<ReturnType<typeof usePlatform>, "fetch" | "openLink">
}

export const canSelectManaged = (wallet: Wallet | undefined) =>
  Boolean(wallet?.signedIn && wallet.accessVerified === true && wallet.managedSupported && wallet.managedUnlocked)

export const accountUnavailable = (wallet: Wallet) =>
  wallet.signedIn &&
  (wallet.accessVerified !== true || (wallet.balanceUsd === null && !wallet.balanceRedacted && wallet.managedSupported))

const MODES: { value: Mode; title: string; body: string }[] = [
  {
    value: "byok",
    title: "Keys & subscriptions",
    body: "Your connected keys and eligible subscriptions. The Wallet still funds what they cannot: models without a key, web search without a Firecrawl key, and image generation.",
  },
  {
    value: "managed",
    title: "Ace",
    body: "Your purchased Wallet for supported models. Your own keys cover the rest.",
  },
]

const normalizeMode = (value: unknown): Mode => (value === "managed" ? "managed" : "byok")

export { withAccountDeadline } from "./account-deadline"

const accountWallet = (signedIn: boolean): Wallet => ({
  signedIn,
  balanceUsd: null,
  billingMode: null,
  managedSupported: signedIn,
  managedUnlocked: false,
  aceEnabled: false,
})

export function ManagedInference(props: {
  onError?: (error: string | undefined) => void
  services?: Services
  /** The host page has its own sign-in control (the Account card on Ace), so the Ace row must not repeat it. */
  accountOwnedByHost?: boolean
}) {
  const sdk = props.services?.sdk ?? useGlobalSDK()
  const globalSync = props.services?.sync ?? useGlobalSync()
  const platform = props.services?.platform ?? usePlatform()
  const fetchFn = platform.fetch ?? fetch
  const description = `managed-inference-${createUniqueId()}`
  const [state, setState] = createStore<{
    wallet?: Wallet
    mode: Mode
    saving: boolean
    signingIn: boolean
    refreshing: boolean
    account: AccountStatus
    /** The "Use an API key" field: closed, open, or submitting. */
    keyEntry: "closed" | "open" | "submitting"
    key: string
  }>({
    mode: normalizeMode(globalSync.data.config.billing?.llm),
    saving: false,
    signingIn: false,
    refreshing: false,
    account: "idle",
    keyEntry: "closed",
    key: "",
  })
  const lifecycle = { epoch: 0, preference: 0, billingRead: 0, disposed: false }
  const selected = createMemo(() => MODES.find((item) => item.value === state.mode) ?? MODES[0])

  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const fail = (error: unknown) => props.onError?.(reason(error))
  const recovery = createAccountRecovery<Wallet>({
    read: (signal) => settingsApi<Wallet>(sdk.url, fetchFn, "/settings/wallet?summary=true", { signal }),
    timeoutMs: ACCOUNT_DEADLINE_MS,
    active: () => document.visibilityState !== "hidden",
    loading: () => setState("account", "loading"),
    apply: (next) => {
      // Stored values arrive at once (possibly marked `refreshing`); the
      // server announces the newer summary and this surface re-reads it.
      setState("wallet", next)
      setState("account", accountUnavailable(next) ? "error" : "ready")
      // Wallet summaries may be cached. Only /settings/billing owns the
      // routing preference; a delayed summary must not undo a saved choice.
      props.onError?.(
        accountUnavailable(next)
          ? "Account refresh temporarily unavailable. Retrying automatically."
          : next.error
            ? `Showing the last known account state. ${next.error}`
            : undefined,
      )
    },
    failed: (error) => {
      setState("account", "error")
      // Do not present a stale balance or stale eligibility as current proof.
      setState("wallet", undefined)
      fail(error)
    },
    // A summary still marked refreshing is re-read on the recovery schedule
    // too: the server announces the refresh's outcome, but a missed
    // announcement must not leave "Refreshing…" on screen indefinitely.
    retry: (next) => accountUnavailable(next) || next.error !== undefined || next.refreshing === true,
  })
  const loadWallet = recovery.load
  const loadBilling = () => {
    // Reads started during a write can observe the previous server value but
    // arrive after its acknowledgement. The write response already refreshes it.
    if (state.saving) return
    const epoch = lifecycle.epoch
    const preference = lifecycle.preference
    const read = ++lifecycle.billingRead
    const current = () =>
      !lifecycle.disposed &&
      epoch === lifecycle.epoch &&
      preference === lifecycle.preference &&
      read === lifecycle.billingRead
    return settingsApi<BillingState>(sdk.url, fetchFn, "/settings/billing")
      .then((next) => {
        if (!current()) return
        if (!state.saving) setState("mode", normalizeMode(next.llm))
        if (!state.wallet && next.wallet) setState("wallet", accountWallet(next.wallet.signedIn))
      })
      .catch((error) => {
        if (current()) fail(error)
      })
  }
  const refresh = () => {
    props.onError?.(undefined)
    void loadBilling()
    void loadWallet()
  }
  const syncProviders = (context: string) => {
    const epoch = lifecycle.epoch
    setState("refreshing", true)
    return globalSync
      .refreshProviders()
      .catch((error) => {
        if (lifecycle.disposed || epoch !== lifecycle.epoch) return
        props.onError?.(
          `${context}, but the model list could not be reloaded (${reason(error)}). It will catch up on the next refresh.`,
        )
      })
      .finally(() => {
        if (!lifecycle.disposed && epoch === lifecycle.epoch) setState("refreshing", false)
      })
  }
  const accountChanged = () => {
    lifecycle.epoch++
    recovery.invalidate()
    setState({ wallet: undefined, mode: "byok", saving: false, refreshing: false, account: "loading" })
    props.onError?.(undefined)
    void loadBilling()
    void loadWallet()
  }

  const resumed = () => {
    if (document.visibilityState !== "hidden") refresh()
  }

  const update = (value: Mode) => {
    if (
      value === state.mode ||
      state.saving ||
      (value === "managed" && (state.account !== "ready" || !canSelectManaged(state.wallet)))
    )
      return
    const previous = state.mode
    const epoch = lifecycle.epoch
    const preference = ++lifecycle.preference
    const current = () => !lifecycle.disposed && epoch === lifecycle.epoch && preference === lifecycle.preference
    setState("mode", value)
    setState("saving", true)
    props.onError?.(undefined)
    void settingsApi<BillingState>(sdk.url, fetchFn, "/settings/billing", {
      method: "PUT",
      body: JSON.stringify({ llm: value }),
    })
      .then((data) => {
        if (!current()) return
        setState("mode", normalizeMode(data.llm))
        // The routing choice is already durable. Provider synchronization is
        // follow-up work and must not keep the controls feeling stuck.
        setState("saving", false)
        void syncProviders("Model access was saved")
      })
      .catch((error) => {
        if (!current()) return
        setState("mode", previous)
        fail(error)
      })
      .finally(() => {
        if (current()) setState("saving", false)
      })
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

  // A pasted Ace API key is the Zen-style route: the key alone selects the
  // workspace it is billed to, no browser round trip, and it belongs to the
  // account that created it rather than to this device.
  const submitKey = () => {
    const key = state.key.trim()
    if (!key || state.keyEntry === "submitting") return
    setState("keyEntry", "submitting")
    props.onError?.(undefined)
    void settingsApi<LoginResult>(sdk.url, fetchFn, "/account/login-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    })
      .then((result) => {
        if (!result.ok) throw new Error(result.error || "That key could not be used. Check it and try again.")
        setState({ keyEntry: "closed", key: "" })
        window.dispatchEvent(new Event("openscience:account-changed"))
        void syncProviders("The Ace account changed")
      })
      .catch((error) => {
        setState("keyEntry", "open")
        fail(error)
      })
  }

  const unsubscribe = globalSync.onProvidersRefreshed(() => void loadBilling())
  // The server stored a newer summary after serving the previous one; the
  // re-read keeps the current values on screen until the new ones land.
  const unsubscribeAccount = globalSync.onAccountRefreshed(() => void loadWallet())
  onMount(() => {
    refresh()
    window.addEventListener("focus", refresh)
    window.addEventListener("online", refresh)
    document.addEventListener("visibilitychange", resumed)
    window.addEventListener("openscience:account-changed", accountChanged)
  })
  onCleanup(() => {
    lifecycle.disposed = true
    recovery.dispose()
    window.removeEventListener("focus", refresh)
    window.removeEventListener("online", refresh)
    document.removeEventListener("visibilitychange", resumed)
    window.removeEventListener("openscience:account-changed", accountChanged)
    unsubscribe()
    unsubscribeAccount()
  })

  const managedUnavailable = () => state.wallet !== undefined && !canSelectManaged(state.wallet)
  const aceLabel = () => {
    if (state.account === "error") return "Account unavailable"
    if (!state.wallet) return "Account"
    if (!state.wallet.signedIn) return "Sign in required"
    if (!state.wallet.managedSupported) return "Unavailable"
    if (state.wallet.aceEnabled) return "On"
    if (state.wallet.managedUnlocked) return "Wallet funded"
    if (state.wallet.balanceUsd === null) return "Account connected"
    return "No purchased balance"
  }
  const balanceLabel = () => {
    if (state.wallet && !state.wallet.signedIn) return "Sign in to view"
    if (!state.wallet || (state.account === "loading" && state.wallet.balanceUsd === null))
      return state.account === "error" ? "Unavailable" : "—"
    if (state.wallet.balanceRedacted) return "Private to admins"
    if (state.wallet.balanceUsd === null) return "Unavailable"
    return formatCreditBalance(state.wallet.balanceUsd)
  }
  // Holds for turns in flight come off the purchased balance before the next
  // turn can spend it, so the headline is what is spendable now and the held
  // amount is named only while something is held.
  const spendable = () => {
    const wallet = state.wallet
    if (!wallet?.signedIn || wallet.balanceRedacted || typeof wallet.availableUsd !== "number") return
    return wallet.availableUsd
  }
  const heldLabel = () => {
    const wallet = state.wallet
    const available = spendable()
    if (available === undefined || typeof wallet?.balanceUsd !== "number") return
    const held = wallet.balanceUsd - available
    return held >= 0.005 ? formatCreditBalance(held) : undefined
  }
  const reloadActive = () => Boolean(state.wallet?.aceEnabled && state.wallet.aceContract?.reloadControlledByAce)
  const accountAction = () => {
    if (state.wallet && !state.wallet.signedIn) return state.signingIn ? "Waiting for browser…" : "Sign in"
    if (state.account === "error") return "Retry"
    if (!state.wallet) return "Open Wallet"
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
    if (!state.wallet) {
      platform.openLink(billingURL())
      return
    }
    if (state.wallet.balanceUsd === null && !state.wallet.managedUnlocked && !state.wallet.aceEnabled) {
      refresh()
      return
    }
    platform.openLink(billingURL())
  }
  // Funds and auto reload belong to the workspace the credential is billed
  // to; the bare /billing page is the browser account's Personal wallet, which
  // is the wrong place for a team key.
  const billingURL = () => {
    const workspace = state.wallet?.workspace
    return workspace && !workspace.personal ? URLS.workspaceBilling(workspace.organizationId) : URLS.dashboardBilling
  }
  const originLabel = () => {
    const wallet = state.wallet
    if (!wallet?.signedIn) return
    const where = wallet.workspace ? (wallet.workspace.personal ? "Personal" : wallet.workspace.name) : undefined
    if (wallet.origin === "key") return where ? `API key · ${where}` : "API key"
    return where && !wallet.workspace?.personal ? where : undefined
  }

  const walletDescription = () => {
    if (state.wallet && !state.wallet.signedIn) return "Sign in to see the purchased balance."
    return "Purchased funds for Ace models."
  }
  const signedOut = () => Boolean(state.wallet && !state.wallet.signedIn)
  // A summary re-read passes through "loading" often; the row keeps its
  // button and state through it rather than flickering.
  const showAccountAction = () => !(props.accountOwnedByHost && signedOut())

  return (
    <div class="models-inference" aria-label="Model access">
      {/* Ace: what it is and whether it is on; one way to manage it. */}
      <div class="settings-row settings-preference-row">
        <div class="settings-row-copy">
          <strong>Ace</strong>
          <span>
            <Show when={signedOut()} fallback={<>Managed models through your Wallet, no provider keys.</>}>
              Managed models through your Wallet once you sign in. Your own provider keys stay separate.
            </Show>
            <Show when={originLabel()}>{(label) => <> · {label()}</>}</Show>
          </span>
        </div>
        <div class="settings-preference-row__actions models-access-actions">
          <span
            class="models-routing__status"
            data-active={state.wallet?.aceEnabled ? "true" : undefined}
            role="status"
          >
            {aceLabel()}
          </span>
          <Show when={showAccountAction()}>
            <Button size="small" variant="secondary" disabled={state.signingIn} onClick={actOnAccount}>
              {accountAction()}
            </Button>
          </Show>
          <LoginApproval active={state.signingIn} openLink={(url) => platform.openLink(url)} />
        </div>
      </div>

      {/* Wallet: what is spendable now, and what turns in flight hold. */}
      <dl class="settings-row settings-preference-row models-routing__wallet">
        <div class="settings-row-copy">
          <dt>Wallet</dt>
          <span>{walletDescription()}</span>
          <Show when={heldLabel()}>
            {(held) => <span class="models-routing__held">{held()} held for turns in flight</span>}
          </Show>
        </div>
        <div class="settings-preference-row__actions models-access-actions">
          <dd
            aria-live="polite"
            class="models-account-summary__balance settings-account-value"
            data-refreshing={state.wallet?.refreshing ? "true" : undefined}
          >
            <Show when={spendable() !== undefined} fallback={balanceLabel()}>
              {formatCreditBalance(spendable()!)} <span class="models-routing__wallet-unit">available</span>
            </Show>
            <Show when={state.wallet?.refreshing}>
              <span class="models-routing__sync sr-only"> Refreshing…</span>
            </Show>
          </dd>
          <Show when={state.wallet?.signedIn && !state.wallet.balanceRedacted}>
            <Button size="small" variant="secondary" onClick={() => platform.openLink(billingURL())}>
              Add funds
            </Button>
          </Show>
        </div>
      </dl>

      {/* Auto-reload: the rule and whether it is in force. Ace's Manage above is where it changes. */}
      <Show when={state.wallet?.signedIn && state.wallet.aceContract}>
        {(contract) => (
          <div class="settings-row settings-preference-row" data-model-reload>
            <div class="settings-row-copy">
              <strong>Auto-reload</strong>
              <span class="models-routing__reload-terms">
                <Show
                  when={reloadActive()}
                  fallback={`Turning on Ace adds $${contract().reloadAmountUsd} whenever the Wallet drops below $${contract().reloadThresholdUsd}.`}
                >
                  Adds ${contract().reloadAmountUsd} when the Wallet drops below ${contract().reloadThresholdUsd}.
                </Show>
              </span>
            </div>
            <div class="settings-preference-row__actions models-access-actions">
              <span class="models-routing__status" data-active={reloadActive() ? "true" : undefined}>
                {reloadActive() ? "On" : "Off"}
              </span>
            </div>
          </div>
        )}
      </Show>

      {/* API key: the Zen-style way in, billed to the key's own workspace. */}
      <div class="settings-row settings-preference-row">
        <div class="settings-row-copy">
          <strong>API key</strong>
          <span>Sign in with a key from any workspace you belong to. It bills that workspace.</span>
        </div>
        <div class="settings-preference-row__actions">
          <Show when={state.keyEntry === "closed"}>
            <Button
              size="small"
              variant="secondary"
              data-model-access-use-key
              onClick={() => setState("keyEntry", "open")}
            >
              {state.wallet?.signedIn ? "Use a different API key" : "Use an API key"}
            </Button>
          </Show>
        </div>
      </div>
      <Show when={state.keyEntry !== "closed"}>
        <form
          class="settings-row settings-preference-row models-routing__key"
          data-model-access-key-form
          onSubmit={(event) => {
            event.preventDefault()
            submitKey()
          }}
        >
          <div class="settings-row-copy">
            <input
              type="password"
              class="models-routing__key-input"
              placeholder="osk_… or thk_… from app.syntheticsciences.ai → Settings → Keys"
              autocomplete="off"
              spellcheck={false}
              value={state.key}
              disabled={state.keyEntry === "submitting"}
              onInput={(event) => setState("key", event.currentTarget.value)}
              aria-label="Ace API key"
            />
            <span class="models-routing__key-note">
              Signing out later forgets the key on this device without revoking it.
            </span>
          </div>
          <div class="settings-preference-row__actions">
            <Button
              type="button"
              size="small"
              variant="ghost"
              disabled={state.keyEntry === "submitting"}
              onClick={() => setState({ keyEntry: "closed", key: "" })}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="small"
              variant="primary"
              disabled={!state.key.trim() || state.keyEntry === "submitting"}
            >
              {state.keyEntry === "submitting" ? "Checking…" : "Connect"}
            </Button>
          </div>
        </form>
      </Show>

      {/* Which route wins when both a key and Ace could serve a model. */}
      <div class="settings-row settings-preference-row models-routing__preference">
        <div class="settings-row-copy">
          <strong>Preferred model access</strong>
          <span id={description} class="models-routing__description" aria-live="polite">
            <Show when={state.saving} fallback="Which route a model uses when both could serve it.">
              Saving {selected().title}…
            </Show>
            <Show when={!state.saving && state.refreshing}>
              <span class="models-routing__sync"> Updating model availability…</span>
            </Show>
          </span>
        </div>
        <div
          class="settings-preference-row__actions settings-segmented-control models-routing__modes"
          role="group"
          aria-label="Model access mode"
          aria-describedby={description}
        >
          <For each={MODES}>
            {(option) => {
              const disabled = () =>
                state.saving ||
                (option.value === "managed" && (state.account !== "ready" || !canSelectManaged(state.wallet)))
              return (
                <button
                  type="button"
                  aria-pressed={state.mode === option.value}
                  aria-busy={state.saving}
                  disabled={disabled()}
                  class="settings-segmented-control__option models-routing__option"
                  data-selected={state.mode === option.value ? "true" : undefined}
                  title={
                    option.value === "managed" && managedUnavailable()
                      ? "Sign in, add purchased Wallet funds, or turn on Ace to use managed models"
                      : option.body
                  }
                  onClick={() => update(option.value)}
                >
                  {option.title}
                </button>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}
