import { For, Show, createMemo, createSignal, onMount, type ParentProps } from "solid-js"
import { Button } from "@synsci/ui/button"
import { TextField } from "@synsci/ui/text-field"
import { settingsApi } from "@/components/settings/api"
import { URLS } from "@/config/urls"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { canUseManaged, type ManagedWallet } from "./desktop-onboarding-access"
import "./DesktopOnboarding.css"

type Route = "ace" | "api" | "local" | "chatgpt"
type AccessGroup = "ace" | "own"

type Account = {
  session?: boolean
  user?: { email?: string; name?: string }
  balance_usd?: number | null
}

type Wallet = ManagedWallet

type AccountState = "loading" | "ready" | "error"

const ownRoutes: Array<{ id: Exclude<Route, "ace">; title: string; detail: string }> = [
  { id: "chatgpt", title: "ChatGPT / Codex", detail: "Use an eligible ChatGPT subscription." },
  { id: "api", title: "Provider key", detail: "OpenAI, Anthropic, or OpenRouter." },
  { id: "local", title: "Local models", detail: "Ollama or LM Studio on this computer." },
]

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
  const [step, setStep] = createSignal<1 | 2>(1)
  const [accessGroup, setAccessGroup] = createSignal<AccessGroup>("ace")
  const [route, setRoute] = createSignal<Route>("ace")
  const [provider, setProvider] = createSignal("anthropic")
  const [key, setKey] = createSignal("")
  const [account, setAccount] = createSignal<Account>()
  const [wallet, setWallet] = createSignal<Wallet>()
  const [accountState, setAccountState] = createSignal<AccountState>("loading")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const server = useServer()
  const platform = usePlatform()
  const fetcher = () => platform.fetch ?? fetch

  const loadAccount = async () => {
    setAccountState("loading")
    const [accountResult, walletResult] = await Promise.allSettled([
      settingsApi<Account>(server.url, fetcher(), "/account"),
      settingsApi<Wallet>(server.url, fetcher(), "/settings/wallet"),
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
    // Account profile and wallet sync may cross the network. They enrich the
    // selected Ace card but must never delay the first useful screen.
    void loadAccount()
  })

  const chooseGroup = (value: AccessGroup) => {
    if (value === "ace") setKey("")
    setAccessGroup(value)
    setRoute(value === "ace" ? "ace" : route() === "ace" ? "chatgpt" : route())
    setError(undefined)
  }

  const canContinue = createMemo(() => {
    if (route() === "ace") return accountState() === "ready" && canUseManaged(wallet())
    return route() !== "api" || Boolean(key().trim())
  })
  const connectedIdentity = createMemo(
    () => account()?.user?.email ?? account()?.user?.name ?? "Synthetic Sciences account connected",
  )

  const finish = async () => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    await (async () => {
      if (route() === "ace") {
        const known = await loadAccount()
        if (!known) throw new Error("Couldn't verify your Ace access. Check the connection and retry.")
        if (!canUseManaged(wallet())) {
          platform.openLink(URLS.dashboardBilling)
          throw new Error("Turn on supported Ace access at app.syntheticsciences.ai, then return here to continue.")
        }
      }
      await settingsApi(server.url, fetcher(), "/account/billing-mode", {
        method: "POST",
        body: JSON.stringify({ mode: route() === "ace" ? "managed" : "byok" }),
      })
      if (route() === "api") {
        if (!key().trim()) throw new Error("Enter the provider API key to continue.")
        await settingsApi(server.url, fetcher(), `/auth/${encodeURIComponent(provider())}`, {
          method: "PUT",
          body: JSON.stringify({ type: "api", key: key().trim() }),
        })
        setKey("")
      }
      await settingsApi(server.url, fetcher(), "/settings/preferences", {
        method: "PATCH",
        body: JSON.stringify({ desktop_onboarding_version: 1 }),
      })
      setComplete(true)
    })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    setBusy(false)
  }

  const skip = async () => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    await settingsApi(server.url, fetcher(), "/settings/preferences", {
      method: "PATCH",
      body: JSON.stringify({ desktop_onboarding_version: 1 }),
    })
      .then(() => setComplete(true))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    setBusy(false)
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
                <div class="desktop-onboarding__progress" aria-label={`Setup step ${step()} of 2`}>
                  <span data-active="true" />
                  <span data-active={step() === 2} />
                  <small>{step()} of 2</small>
                </div>
              </header>

              <Show
                when={step() === 1}
                fallback={
                  <div class="desktop-onboarding__content desktop-onboarding__content--ready">
                    <div class="desktop-onboarding__intro">
                      <p>Ready</p>
                      <h1 id="desktop-onboarding-title">Start with a real research question</h1>
                      <span>
                        Open or create a project, then describe the outcome you want. OpenScience keeps durable work in
                        the project and scratch work in the session.
                      </span>
                    </div>

                    <div class="desktop-onboarding__ready-card">
                      <div>
                        <span class="desktop-onboarding__ready-index">1</span>
                        <div>
                          <strong>Open a project</strong>
                          <span>Choose an existing folder or create a focused workspace.</span>
                        </div>
                      </div>
                      <div>
                        <span class="desktop-onboarding__ready-index">2</span>
                        <div>
                          <strong>Describe the result</strong>
                          <span>Ask for an analysis, literature review, experiment, or scientific report.</span>
                        </div>
                      </div>
                    </div>

                    <div class="desktop-onboarding__summary" aria-label="Selected model access">
                      <span>Model access</span>
                      <strong>
                        {route() === "ace"
                          ? "OpenScience Ace"
                          : (ownRoutes.find((item) => item.id === route())?.title ?? "Existing access")}
                      </strong>
                      <small>Remote compute can be connected later from Customize → Compute.</small>
                    </div>
                  </div>
                }
              >
                <div class="desktop-onboarding__content">
                  <div class="desktop-onboarding__intro">
                    <p>Model access</p>
                    <h1 id="desktop-onboarding-title">How should OpenScience run models?</h1>
                    <span>Your account is connected. Choose a path now, or set up models later from Customize.</span>
                  </div>

                  <div class="desktop-onboarding__choices" role="group" aria-label="Model access">
                    <button
                      type="button"
                      aria-pressed={accessGroup() === "ace"}
                      data-selected={accessGroup() === "ace"}
                      onClick={() => chooseGroup("ace")}
                    >
                      <span class="desktop-onboarding__choice-topline">
                        <strong>OpenScience Ace</strong>
                        <em>Recommended</em>
                      </span>
                      <span>Managed models and enhanced research search, billed to your Ace balance.</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={accessGroup() === "own"}
                      data-selected={accessGroup() === "own"}
                      onClick={() => chooseGroup("own")}
                    >
                      <span class="desktop-onboarding__choice-topline">
                        <strong>Use my own access</strong>
                      </span>
                      <span>Connect a subscription, provider key, or local model runtime.</span>
                    </button>
                  </div>

                  <Show
                    when={accessGroup() === "ace"}
                    fallback={
                      <div class="desktop-onboarding__detail">
                        <div class="desktop-onboarding__route-list" role="group" aria-label="Existing model access">
                          <For each={ownRoutes}>
                            {(item) => (
                              <button
                                type="button"
                                aria-pressed={route() === item.id}
                                data-selected={route() === item.id}
                                onClick={() => {
                                  if (item.id !== "api") setKey("")
                                  setRoute(item.id)
                                  setError(undefined)
                                }}
                              >
                                <strong>{item.title}</strong>
                                <span>{item.detail}</span>
                              </button>
                            )}
                          </For>
                        </div>
                        <Show when={route() === "api"}>
                          <div class="desktop-onboarding__credentials">
                            <label>
                              <span>Provider</span>
                              <select value={provider()} onChange={(event) => setProvider(event.currentTarget.value)}>
                                <For each={providers}>{(item) => <option value={item.id}>{item.label}</option>}</For>
                              </select>
                            </label>
                            <label class="desktop-onboarding__field">
                              <span>
                                API key <small>required</small>
                              </span>
                              <TextField
                                hideLabel
                                type="password"
                                value={key()}
                                onChange={setKey}
                                placeholder="Paste provider key"
                                autocomplete="off"
                              />
                            </label>
                          </div>
                        </Show>
                        <Show when={route() === "chatgpt" || route() === "local"}>
                          <p class="desktop-onboarding__note">
                            Open the workspace now, then finish this connection from Customize → Models. No terminal is
                            required.
                          </p>
                        </Show>
                      </div>
                    }
                  >
                    <div class="desktop-onboarding__detail desktop-onboarding__account">
                      <div class="desktop-onboarding__account-copy">
                        <span
                          class="desktop-onboarding__status"
                          data-ready={accountState() === "ready" && canUseManaged(wallet())}
                        >
                          <i aria-hidden="true" />
                          {accountState() === "loading"
                            ? "Checking account"
                            : accountState() === "error"
                              ? "Account check failed"
                              : canUseManaged(wallet())
                                ? wallet()?.aceEnabled
                                  ? "Ace ready"
                                  : "Wallet ready"
                                : "Ace setup required"}
                        </span>
                        <strong>{connectedIdentity()}</strong>
                        <small>
                          {wallet()?.aceEnabled
                            ? `${formatBalance(wallet()?.balanceUsd)} · Ace is ready`
                            : wallet()?.managedSupported
                              ? `${formatBalance(wallet()?.balanceUsd)} · Auto reload is off`
                              : "Ace is managed at app.syntheticsciences.ai"}
                        </small>
                      </div>
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={accountState() === "loading"}
                        onClick={() => {
                          if (accountState() === "error") {
                            void loadAccount()
                            return
                          }
                          platform.openLink(URLS.dashboardBilling)
                        }}
                      >
                        {accountState() === "error"
                          ? "Retry"
                          : canUseManaged(wallet())
                            ? "Manage Wallet"
                            : "Set up Ace"}
                      </Button>
                    </div>
                  </Show>
                </div>
              </Show>

              <Show when={error()}>
                <p class="desktop-onboarding__error" role="alert">
                  {error()}
                </p>
              </Show>

              <footer class="desktop-onboarding__footer">
                <Show
                  when={step() === 1}
                  fallback={
                    <Button variant="secondary" size="small" disabled={busy()} onClick={() => setStep(1)}>
                      Back
                    </Button>
                  }
                >
                  <Button variant="secondary" size="small" disabled={busy()} onClick={() => void skip()}>
                    Set up models later
                  </Button>
                </Show>
                <Button
                  variant="primary"
                  size="small"
                  disabled={busy() || (step() === 1 && !canContinue())}
                  onClick={() => {
                    if (step() === 1) {
                      setError(undefined)
                      setStep(2)
                      return
                    }
                    void finish()
                  }}
                >
                  {busy() ? "Saving…" : step() === 1 ? "Continue" : "Open workspace"}
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
