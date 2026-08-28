import { For, Show, createMemo, createSignal, onMount, type ParentProps } from "solid-js"
import { Button } from "@synsci/ui/button"
import { TextField } from "@synsci/ui/text-field"
import { settingsApi } from "@/components/settings/api"
import { URLS } from "@/config/urls"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { canUseManaged, type ManagedWallet } from "./desktop-onboarding-access"
import "./DesktopOnboarding.css"

type Account = {
  session?: boolean
  user?: { email?: string; name?: string }
  balance_usd?: number | null
}

type AccountState = "loading" | "ready" | "error"
type Configured = "ace" | "api"

const providers = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "openrouter", label: "OpenRouter" },
]

const formatBalance = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "Balance unavailable"
  return `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)} balance`
}

export function DesktopOnboarding(props: ParentProps) {
  const desktop = new URLSearchParams(window.location.search).get("desktop") === "1"
  const [complete, setComplete] = createSignal(!desktop)
  const [ready, setReady] = createSignal(!desktop)
  const [provider, setProvider] = createSignal("anthropic")
  const [key, setKey] = createSignal("")
  const [account, setAccount] = createSignal<Account>()
  const [wallet, setWallet] = createSignal<ManagedWallet>()
  const [accountState, setAccountState] = createSignal<AccountState>("loading")
  const [configured, setConfigured] = createSignal<Configured>()
  const [busy, setBusy] = createSignal<"workspace" | "ace" | "api">()
  const [error, setError] = createSignal<string>()
  const server = useServer()
  const platform = usePlatform()
  const fetcher = () => platform.fetch ?? fetch

  const loadAccount = async () => {
    setAccountState("loading")
    const [accountResult, walletResult] = await Promise.allSettled([
      settingsApi<Account>(server.url, fetcher(), "/account"),
      settingsApi<ManagedWallet>(server.url, fetcher(), "/settings/wallet"),
    ])
    if (accountResult.status !== "fulfilled" || walletResult.status !== "fulfilled") {
      setAccountState("error")
      return false
    }
    setAccount(accountResult.value)
    setWallet(walletResult.value)
    setAccountState("ready")
    return true
  }

  onMount(() => {
    if (!desktop) return
    void settingsApi<{ desktop_onboarding_version: number }>(server.url, fetcher(), "/settings/preferences")
      .then((value) => setComplete(value.desktop_onboarding_version >= 1))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setReady(true))
    // Account and wallet data enrich optional model setup but never delay the
    // primary route into the workspace.
    void loadAccount()
  })

  const identity = createMemo(
    () => account()?.user?.email ?? account()?.user?.name ?? "Synthetic Sciences account connected",
  )

  const useAce = async () => {
    if (busy()) return
    setBusy("ace")
    setError(undefined)
    await (async () => {
      const known = accountState() === "ready" ? true : await loadAccount()
      if (!known) throw new Error("Couldn't verify your Ace access. Check the connection and retry.")
      if (!canUseManaged(wallet())) {
        platform.openLink(URLS.dashboardBilling)
        throw new Error("Set up Ace at app.syntheticsciences.ai, then return here and try again.")
      }
      await settingsApi(server.url, fetcher(), "/account/billing-mode", {
        method: "POST",
        body: JSON.stringify({ mode: "managed" }),
      })
      setConfigured("ace")
    })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    setBusy(undefined)
  }

  const saveKey = async () => {
    const value = key().trim()
    if (!value || busy()) return
    setBusy("api")
    setError(undefined)
    await (async () => {
      await settingsApi(server.url, fetcher(), "/account/billing-mode", {
        method: "POST",
        body: JSON.stringify({ mode: "byok" }),
      })
      await settingsApi(server.url, fetcher(), `/auth/${encodeURIComponent(provider())}`, {
        method: "PUT",
        body: JSON.stringify({ type: "api", key: value }),
      })
      setKey("")
      setConfigured("api")
    })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    setBusy(undefined)
  }

  const openWorkspace = async () => {
    if (busy()) return
    setBusy("workspace")
    setError(undefined)
    await settingsApi(server.url, fetcher(), "/settings/preferences", {
      method: "PATCH",
      body: JSON.stringify({ desktop_onboarding_version: 1 }),
    })
      .then(() => setComplete(true))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    setBusy(undefined)
  }

  return (
    <Show when={ready()} fallback={<main class="desktop-onboarding" aria-label="Loading desktop setup" />}>
      <Show
        when={complete()}
        fallback={
          <main class="desktop-onboarding" aria-labelledby="desktop-onboarding-title">
            <section class="desktop-onboarding__shell">
              <header class="desktop-onboarding__header">
                <div class="desktop-onboarding__brand">
                  <span class="desktop-onboarding__mark" aria-hidden="true">
                    OS
                  </span>
                  <span>OpenScience</span>
                </div>
                <span class="desktop-onboarding__account-state">Account connected</span>
              </header>

              <div class="desktop-onboarding__content">
                <div class="desktop-onboarding__intro">
                  <p>Ready to work</p>
                  <h1 id="desktop-onboarding-title">Open your workspace</h1>
                  <span>
                    Your account is connected. Start now, or optionally set up model access below. You can change it
                    anytime in Customize.
                  </span>
                </div>

                <details class="desktop-onboarding__models">
                  <summary>
                    <span>
                      <strong>Model access</strong>
                      <small>Optional · set up now or later</small>
                    </span>
                    <span aria-hidden="true">+</span>
                  </summary>
                  <div class="desktop-onboarding__model-options">
                    <section class="desktop-onboarding__model-option">
                      <div class="desktop-onboarding__model-copy">
                        <span
                          class="desktop-onboarding__status"
                          data-ready={accountState() === "ready" && canUseManaged(wallet())}
                        >
                          <i aria-hidden="true" />
                          {accountState() === "loading"
                            ? "Checking Ace"
                            : accountState() === "error"
                              ? "Account check failed"
                              : canUseManaged(wallet())
                                ? "Ace available"
                                : "Ace setup required"}
                        </span>
                        <strong>OpenScience Ace</strong>
                        <small>
                          {accountState() === "ready"
                            ? `${identity()} · ${formatBalance(wallet()?.balanceUsd)}`
                            : "Managed model access through your Synthetic Sciences account."}
                        </small>
                      </div>
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={Boolean(busy())}
                        onClick={() => {
                          if (accountState() === "error") {
                            void loadAccount()
                            return
                          }
                          if (accountState() === "ready" && !canUseManaged(wallet())) {
                            platform.openLink(URLS.dashboardBilling)
                            return
                          }
                          void useAce()
                        }}
                      >
                        {busy() === "ace"
                          ? "Saving…"
                          : accountState() === "error"
                            ? "Retry"
                            : accountState() === "ready" && !canUseManaged(wallet())
                              ? "Set up Ace"
                              : configured() === "ace"
                                ? "Using Ace"
                                : "Use Ace"}
                      </Button>
                    </section>

                    <section class="desktop-onboarding__model-option desktop-onboarding__model-option--key">
                      <div class="desktop-onboarding__model-copy">
                        <strong>Provider key</strong>
                        <small>Stored locally and billed directly by the provider.</small>
                      </div>
                      <div class="desktop-onboarding__credentials">
                        <label>
                          <span>Provider</span>
                          <select value={provider()} onChange={(event) => setProvider(event.currentTarget.value)}>
                            <For each={providers}>{(item) => <option value={item.id}>{item.label}</option>}</For>
                          </select>
                        </label>
                        <label class="desktop-onboarding__field">
                          <span>API key</span>
                          <TextField
                            hideLabel
                            type="password"
                            value={key()}
                            onChange={setKey}
                            placeholder="Paste provider key"
                            autocomplete="off"
                            onKeyDown={(event: KeyboardEvent) => {
                              if (event.key !== "Enter") return
                              event.preventDefault()
                              void saveKey()
                            }}
                          />
                        </label>
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={Boolean(busy()) || !key().trim()}
                          onClick={() => void saveKey()}
                        >
                          {busy() === "api" ? "Saving…" : configured() === "api" ? "Saved" : "Save key"}
                        </Button>
                      </div>
                    </section>

                    <p class="desktop-onboarding__note">
                      Connect ChatGPT / Codex in Customize → Models. Set up local runtimes in Customize → Local models.
                    </p>
                  </div>
                </details>
              </div>

              <Show when={error()}>
                <p class="desktop-onboarding__error" role="alert">
                  {error()}
                </p>
              </Show>

              <footer class="desktop-onboarding__footer">
                <span>Model setup is not required to open the workspace.</span>
                <Button variant="primary" size="small" disabled={Boolean(busy())} onClick={() => void openWorkspace()}>
                  {busy() === "workspace" ? "Opening…" : "Open workspace"}
                </Button>
              </footer>
            </section>
          </main>
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}
