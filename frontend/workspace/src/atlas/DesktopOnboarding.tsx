import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type ParentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import { AtomLoader } from "@synsci/ui/atom-loader"
import { Button } from "@synsci/ui/button"
import { TextField } from "@synsci/ui/text-field"
import { ProviderIcon } from "@synsci/ui/provider-icon"
import { ProviderLogo } from "@/components/settings/ProviderLogo"
import { settingsApi } from "@/components/settings/api"
import { LOGIN_APPROVAL_EVENT, LoginApproval } from "@/components/settings/LoginApproval"
import { ACCOUNT_DEADLINE_MS, withAccountDeadline } from "@/components/settings/account-deadline"
import { URLS } from "@/config/urls"
import { usePlatform } from "@/context/platform"
import type { Platform } from "@/context/platform"
import { useServer } from "@/context/server"
import { createOpenScienceClient } from "@synsci/sdk/v2/client"
import "./DesktopOnboarding.css"

/** The setup revision every install sees once. Mirrors ONBOARDING_VERSION on the server. */
export const ONBOARDING_VERSION = 2

type OnboardingStep = "account" | "ace" | "connect" | "done"
const STEPS: OnboardingStep[] = ["account", "ace", "connect", "done"]

type Preferences = {
  desktop_onboarding_version: number
  desktop_onboarding_step?: OnboardingStep
}

type Wallet = {
  signedIn: boolean
  balanceUsd: number | null
  availableUsd?: number | null
  accessVerified?: boolean
  managedSupported: boolean
  managedUnlocked: boolean
  aceEnabled: boolean
  aceContract?: { reloadThresholdUsd: number; reloadAmountUsd: number }
  workspace?: { organizationId: string; personal: boolean }
  error?: string
}

/** The part of `GET /provider` this step reads. */
type Providers = {
  all: Array<{ id: string; source?: string }>
  connected: string[]
}

/** Ace is the reload rule; a funded Wallet runs managed models without it. */
type AceAccess = "on" | "funded" | "off"

type Connection = {
  id: string
  logo: string
  name: string
  kind: "oauth" | "key" | "credential" | "detect"
  placeholder?: string
}

const CONNECTIONS: Connection[] = [
  { id: "openai-codex", logo: "openai-codex", name: "ChatGPT / Codex", kind: "oauth" },
  { id: "anthropic", logo: "anthropic", name: "Anthropic", kind: "key", placeholder: "sk-ant-…" },
  { id: "openai", logo: "openai", name: "OpenAI", kind: "key", placeholder: "sk-…" },
  { id: "openrouter", logo: "openrouter", name: "OpenRouter", kind: "key", placeholder: "sk-or-…" },
  { id: "google", logo: "google", name: "Google", kind: "key", placeholder: "AIza…" },
  { id: "firecrawl", logo: "firecrawl", name: "Firecrawl", kind: "credential", placeholder: "fc-…" },
  { id: "modal", logo: "modal", name: "Modal", kind: "detect" },
]

const VERSION_KEY = "openscience.desktop_onboarding_version"
/** How long the window waits for the browser sign-in to finish before it lets
 * the user try again. */
const SIGN_IN_DEADLINE_MS = 5 * 60_000
/** How long Ace activation is polled after the billing page opens. */
const ACE_WAIT_MS = 10 * 60_000
const ACE_POLL_MS = 4_000

function cachedVersion() {
  try {
    return Number(localStorage.getItem(VERSION_KEY)) || 0
  } catch {
    return 0
  }
}

function rememberVersion(version: number) {
  try {
    localStorage.setItem(VERSION_KEY, String(version))
  } catch {}
}

function later(a: OnboardingStep, b: OnboardingStep): OnboardingStep {
  return STEPS.indexOf(a) >= STEPS.indexOf(b) ? a : b
}

function money(value: number | null | undefined) {
  if (typeof value !== "number") return undefined
  return `$${value.toFixed(2)}`
}

function reason(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

function DesktopOnboardingLoading() {
  return (
    <main class="desktop-onboarding desktop-onboarding--loading" aria-label="Loading desktop setup">
      <div class="desktop-onboarding__loading" role="status" aria-live="polite">
        <AtomLoader size={180} caption="Preparing your workspace" />
      </div>
    </main>
  )
}

/**
 * Relay the sign-in page the server tried to open (its `account.login` event)
 * to the window, as the workspace's global sync does once it is mounted. Setup
 * runs before that subscription exists, so it listens on its own for as long
 * as a browser sign-in is pending; the stream ends with the signal.
 */
async function approvalPage(base: string, fetchFn: typeof fetch, signal: AbortSignal) {
  const client = createOpenScienceClient({ baseUrl: base, fetch: fetchFn, signal })
  const events = await client.global.event()
  for await (const event of events.stream) {
    if (signal.aborted) return
    if (event.payload.type !== "account.login") continue
    window.dispatchEvent(new CustomEvent(LOGIN_APPROVAL_EVENT, { detail: event.payload.properties.approval_url }))
  }
}

type ServerProjects = ReturnType<typeof useServer>["projects"]
type OnboardingServer = {
  url: string
  projects: Pick<ServerProjects, "open" | "touch">
}

export function DesktopOnboardingController(
  props: ParentProps & {
    server: OnboardingServer
    platform: Platform
    desktop?: boolean
    signInDeadlineMs?: number
    acePollMs?: number
  },
) {
  const desktop = props.desktop ?? new URLSearchParams(window.location.search).get("desktop") === "1"
  // A completed setup is remembered on this device so the shell paints before
  // the preferences round trip; the fetch still verifies it below and brings
  // setup back if the server says it is incomplete.
  const seen = desktop && cachedVersion() > 0
  const [complete, setComplete] = createSignal(!desktop || seen)
  const [ready, setReady] = createSignal(!desktop || seen)
  const [step, setStep] = createSignal<OnboardingStep>("account")
  const [error, setError] = createSignal<string>()
  const [account, setAccount] = createStore({ connected: false, pending: false, keyEntry: false, key: "" })
  const [ace, setAce] = createStore({
    status: "idle" as "idle" | "checking" | "waiting" | "on" | "unavailable",
    // Purchased or promotional credit the Wallet can already spend, with no
    // card or reload rule behind it.
    funded: false,
    balance: undefined as number | null | undefined,
    note: undefined as string | undefined,
    contract: undefined as Wallet["aceContract"],
    workspace: undefined as Wallet["workspace"],
  })
  const [connect, setConnect] = createStore({
    open: undefined as string | undefined,
    busy: undefined as string | undefined,
    drafts: {} as Record<string, string>,
    connected: {} as Record<string, string>,
    // Providers the runtime already reaches without this step: environment
    // keys, keys stored earlier, local endpoints.
    runtime: [] as string[],
  })
  const lifetime = new AbortController()
  let errorElement: HTMLParagraphElement | undefined
  let title: HTMLHeadingElement | undefined
  let aceWait: ReturnType<typeof setTimeout> | undefined
  const server = props.server
  const platform = props.platform
  const fetcher = () => platform.fetch ?? fetch
  const api = <T,>(path: string, init?: RequestInit) => settingsApi<T>(server.url, fetcher(), path, init)

  onCleanup(() => {
    lifetime.abort()
    if (aceWait) clearTimeout(aceWait)
  })

  const remember = (next: OnboardingStep) => {
    setStep(next)
    setError(undefined)
    void api("/settings/preferences", {
      method: "PATCH",
      body: JSON.stringify({ desktop_onboarding_step: next }),
    }).catch(() => undefined)
  }

  onMount(() => {
    if (!desktop) return
    void withAccountDeadline(async (deadline) => {
      const signal = AbortSignal.any([deadline, lifetime.signal])
      const value = await api<Preferences>("/settings/preferences", { signal })
      if (signal.aborted) return
      rememberVersion(value.desktop_onboarding_version)
      if (value.desktop_onboarding_version > 0) {
        setComplete(true)
        return
      }
      setReady(false)
      setComplete(false)
      const session = await api<{ session: boolean }>("/account/session", { signal })
      if (signal.aborted) return
      setAccount("connected", session.session)
      // Account state is authoritative; the stored step only decides how far
      // past it a signed-in user had already gone.
      const stored = value.desktop_onboarding_step ?? "account"
      setStep(session.session ? later(stored, "ace") : "account")
    }, ACCOUNT_DEADLINE_MS)
      .catch((cause) => {
        if (!lifetime.signal.aborted) setError(reason(cause))
      })
      .finally(() => {
        if (!lifetime.signal.aborted) setReady(true)
      })
  })

  createEffect(() => {
    if (!error()) return
    queueMicrotask(() => errorElement?.focus())
  })

  createEffect(() => {
    step()
    if (!ready() || complete()) return
    queueMicrotask(() => title?.focus())
  })

  // Ace: learn the current state once the account exists, so a resumed setup
  // on a later step still knows whether Ace is on. The read mutates the same
  // store it inspects, so it must not become a dependency here.
  createEffect(() => {
    if (!ready() || complete() || step() === "account") return
    untrack(() => {
      if (step() === "ace" || ace.status === "idle") void readWallet(true)
    })
  })

  createEffect(() => {
    if (!ready() || complete() || step() !== "connect") return
    void readProviders()
  })

  const readProviders = async () => {
    const list = await api<Providers>("/provider", { signal: lifetime.signal }).catch(() => undefined)
    if (!list || lifetime.signal.aborted) return
    // The managed route is what Ace pays for; the Ace step already answers for it.
    const managed = new Set(list.all.filter((item) => item.source === "managed").map((item) => item.id))
    setConnect(
      "runtime",
      list.connected.filter((id) => !managed.has(id)),
    )
  }

  const readWallet = async (summary: boolean): Promise<AceAccess> => {
    if (ace.status === "on") return "on"
    if (ace.status === "idle") setAce("status", "checking")
    const wallet = await api<Wallet>(`/settings/wallet${summary ? "?summary=true" : ""}`, {
      signal: lifetime.signal,
    }).catch((cause): Wallet => ({
      signedIn: true,
      balanceUsd: null,
      managedSupported: true,
      managedUnlocked: false,
      aceEnabled: false,
      error: reason(cause),
    }))
    if (lifetime.signal.aborted) return "off"
    setAce({ contract: wallet.aceContract, workspace: wallet.workspace })
    const access: AceAccess = wallet.aceEnabled ? "on" : wallet.managedUnlocked ? "funded" : "off"
    if (access !== "off") {
      // The Wallet is the funding source now; the model list follows the billing mode.
      await api("/settings/billing", { method: "PUT", body: JSON.stringify({ llm: "managed" }) }).catch(() => undefined)
      setAce({ funded: true, balance: wallet.availableUsd ?? wallet.balanceUsd, note: undefined })
    }
    if (access === "on") {
      setAce("status", "on")
      return access
    }
    if (ace.status === "checking") setAce("status", wallet.error && access === "off" ? "unavailable" : "idle")
    if (wallet.error && access === "off") setAce("note", wallet.error)
    return access
  }

  // Funds and the reload rule belong to the workspace the credential is billed
  // to; the bare /billing page is the browser account's Personal wallet.
  const billingURL = () =>
    ace.workspace && !ace.workspace.personal
      ? URLS.workspaceBilling(ace.workspace.organizationId)
      : URLS.dashboardBilling

  const NOT_ON = "Ace is not on yet. Finish in your browser, then check again."

  const turnOnAce = () => {
    platform.openLink(billingURL())
    // A Wallet that was already funded proves nothing about the reload rule,
    // so only a change since the click ends the wait.
    const funded = ace.funded
    setAce({ status: "waiting", note: undefined })
    const started = Date.now()
    const poll = async () => {
      if (lifetime.signal.aborted || ace.status !== "waiting") return
      const access = await readWallet(false)
      if (access === "on" || ace.status !== "waiting") return
      if (access === "funded" && !funded) {
        setAce("status", "idle")
        return
      }
      if (Date.now() - started > ACE_WAIT_MS) {
        setAce({ status: "idle", note: NOT_ON })
        return
      }
      aceWait = setTimeout(() => void poll(), props.acePollMs ?? ACE_POLL_MS)
    }
    aceWait = setTimeout(() => void poll(), props.acePollMs ?? ACE_POLL_MS)
  }

  const checkAce = async () => {
    if (aceWait) clearTimeout(aceWait)
    setAce("status", "checking")
    const access = await readWallet(false)
    if (access !== "on" && !lifetime.signal.aborted) setAce("note", (note) => note ?? NOT_ON)
  }

  const leaveAce = () => {
    if (aceWait) clearTimeout(aceWait)
    if (ace.status !== "on") setAce({ status: "idle", note: undefined })
    remember("connect")
  }

  const login = async () => {
    if (account.pending) return
    setAccount("pending", true)
    setError(undefined)
    let expired = false
    // The workspace's own event subscription mounts after setup, so setup
    // listens for the approval page itself while the sign-in is pending and
    // the line under the button offers it in case no browser appeared.
    const watch = new AbortController()
    void approvalPage(server.url, fetcher(), AbortSignal.any([watch.signal, lifetime.signal])).catch(() => undefined)
    try {
      const result = await withAccountDeadline(async (deadline) => {
        // The helper aborts its signal on every outcome; only an abort that
        // arrives before the request settled is the deadline.
        let settled = false
        deadline.addEventListener("abort", () => (expired = !settled), { once: true })
        return api<{ ok: boolean; error?: string }>("/account/login-browser", {
          method: "POST",
          signal: AbortSignal.any([deadline, lifetime.signal]),
        }).finally(() => (settled = true))
      }, props.signInDeadlineMs ?? SIGN_IN_DEADLINE_MS)
      if (lifetime.signal.aborted) return
      if (!result.ok) throw new Error(result.error || "Sign in did not complete. Try again.")
      setAccount({ connected: true, keyEntry: false, key: "" })
      window.dispatchEvent(new Event("openscience:account-changed"))
      remember("ace")
    } catch (cause) {
      if (!lifetime.signal.aborted && step() === "account") {
        setError(expired ? "Sign-in did not complete in time. Try again." : reason(cause))
      }
    } finally {
      watch.abort()
      if (!lifetime.signal.aborted) setAccount("pending", false)
    }
  }

  const loginWithKey = async () => {
    const key = account.key.trim()
    if (!key || account.pending) return
    setAccount("pending", true)
    setError(undefined)
    try {
      const result = await api<{ ok: boolean; error?: string }>("/account/login-key", {
        method: "POST",
        body: JSON.stringify({ key }),
        signal: lifetime.signal,
      })
      if (lifetime.signal.aborted) return
      if (!result.ok) throw new Error(result.error || "That key was not accepted.")
      setAccount({ connected: true, keyEntry: false, key: "" })
      window.dispatchEvent(new Event("openscience:account-changed"))
      remember("ace")
    } catch (cause) {
      if (!lifetime.signal.aborted) setError(reason(cause))
    } finally {
      if (!lifetime.signal.aborted) setAccount("pending", false)
    }
  }

  const run = async (id: string, action: () => Promise<string>) => {
    if (connect.busy) return
    setConnect("busy", id)
    setError(undefined)
    try {
      const label = await action()
      if (lifetime.signal.aborted) return
      setConnect("connected", id, label)
      setConnect("drafts", id, "")
      setConnect("open", undefined)
    } catch (cause) {
      if (!lifetime.signal.aborted) setError(reason(cause))
    } finally {
      if (!lifetime.signal.aborted) setConnect("busy", undefined)
    }
  }

  const connectItem = (item: Connection) => {
    const draft = (connect.drafts[item.id] ?? "").trim()
    if (item.kind === "oauth") {
      return run(item.id, async () => {
        const result = await api<{ url?: string } | undefined>(`/provider/${item.id}/oauth/authorize`, {
          method: "POST",
          body: JSON.stringify({ method: 0 }),
          signal: lifetime.signal,
        })
        if (result?.url) platform.openLink(result.url)
        await api(`/provider/${item.id}/oauth/callback`, {
          method: "POST",
          body: JSON.stringify({ method: 0 }),
          signal: lifetime.signal,
        })
        return "Signed in"
      })
    }
    if (item.kind === "detect") {
      return run(item.id, async () => {
        await api("/settings/compute/modal/configure", { method: "POST", signal: lifetime.signal })
        return "Connected"
      })
    }
    if (!draft) return
    if (item.kind === "credential") {
      return run(item.id, async () => {
        await api(`/settings/credentials/${item.id}`, {
          method: "PUT",
          body: JSON.stringify({ fields: { api_key: draft } }),
          signal: lifetime.signal,
        })
        return "Key saved"
      })
    }
    return run(item.id, async () => {
      // The local server owns the snapshot and compensation so a previous key
      // never has to cross back through the browser to be restored.
      const result = await api<{ verified?: boolean }>(`/auth/${encodeURIComponent(item.id)}/onboarding`, {
        method: "PUT",
        body: JSON.stringify({ type: "api", key: draft }),
        signal: lifetime.signal,
      })
      return result.verified === false ? "Key saved · could not be checked" : "Key saved"
    })
  }

  const finish = async () => {
    setError(undefined)
    try {
      await api("/settings/preferences", {
        method: "PATCH",
        body: JSON.stringify({ desktop_onboarding_version: ONBOARDING_VERSION, desktop_onboarding_step: "done" }),
        signal: lifetime.signal,
      })
      if (lifetime.signal.aborted) return
      rememberVersion(ONBOARDING_VERSION)
      setComplete(true)
    } catch (cause) {
      if (!lifetime.signal.aborted) setError(reason(cause))
    }
  }

  const dollars = (value: number) => (Number.isInteger(value) ? `$${value}` : money(value))
  const reloadRule = () =>
    ace.contract
      ? `Ace keeps the Wallet topped up: ${dollars(ace.contract.reloadAmountUsd)} whenever it falls below ${dollars(ace.contract.reloadThresholdUsd)}.`
      : "Ace keeps the Wallet topped up so long runs never stop for funds."
  const model = (item: Connection) => item.kind === "oauth" || item.kind === "key"
  const status = (item: Connection) =>
    connect.connected[item.id] ?? (model(item) && connect.runtime.includes(item.id) ? "Connected" : undefined)
  const modelSource = () =>
    ace.status === "on" ||
    ace.funded ||
    connect.runtime.length > 0 ||
    CONNECTIONS.some((item) => model(item) && connect.connected[item.id])
  const errorNote = () => (
    <Show when={error()}>
      <p ref={errorElement} class="desktop-onboarding__error" role="alert" tabindex="-1">
        {error()}
      </p>
    </Show>
  )
  const back = (): OnboardingStep | undefined =>
    step() === "connect" ? "ace" : step() === "done" ? "connect" : undefined

  return (
    <Show when={ready()} fallback={<DesktopOnboardingLoading />}>
      <Show
        when={complete()}
        fallback={
          <main class="desktop-onboarding" aria-labelledby="desktop-onboarding-title" aria-busy={Boolean(connect.busy)}>
            <section class="desktop-onboarding__card" data-step={step()}>
              <header class="desktop-onboarding__top">
                <ProviderIcon id="synsci" class="desktop-onboarding__logo" aria-hidden="true" />
                <span
                  class="desktop-onboarding__count"
                  aria-label={`Step ${STEPS.indexOf(step()) + 1} of ${STEPS.length}`}
                >
                  {STEPS.indexOf(step()) + 1} / {STEPS.length}
                </span>
              </header>

              <Switch>
                <Match when={step() === "account"}>
                  <h1 ref={title} id="desktop-onboarding-title" tabindex="-1">
                    Welcome to OpenScience
                  </h1>
                  <p class="desktop-onboarding__body">Sign in or create an account to continue.</p>
                  <div class="desktop-onboarding__actions">
                    <Show
                      when={account.keyEntry}
                      fallback={
                        <>
                          <Button
                            variant="primary"
                            size="large"
                            disabled={account.pending}
                            onClick={() => void login()}
                          >
                            {account.pending ? "Waiting for your browser…" : "Continue with Synthetic Sciences"}
                          </Button>
                          <Show when={account.pending}>
                            <p class="desktop-onboarding__note" role="status" aria-live="polite">
                              Finish signing in in your browser. This window continues on its own.
                            </p>
                          </Show>
                          <LoginApproval
                            active={account.pending}
                            class="desktop-onboarding__note"
                            linkClass="desktop-onboarding__link"
                            openLink={(url) => platform.openLink(url)}
                          />
                          <button
                            type="button"
                            class="desktop-onboarding__link"
                            disabled={account.pending}
                            onClick={() => setAccount("keyEntry", true)}
                          >
                            Use a sign-in key
                          </button>
                        </>
                      }
                    >
                      <div class="desktop-onboarding__inline">
                        <TextField
                          hideLabel
                          label="Sign-in key"
                          type="password"
                          value={account.key}
                          disabled={account.pending}
                          onChange={(value: string) => setAccount("key", value)}
                          placeholder="Sign-in key"
                          autocomplete="off"
                          onKeyDown={(event: KeyboardEvent) => {
                            if (event.key !== "Enter") return
                            event.preventDefault()
                            void loginWithKey()
                          }}
                        />
                        <Button
                          variant="primary"
                          disabled={account.pending || !account.key.trim()}
                          onClick={() => void loginWithKey()}
                        >
                          {account.pending ? "Signing in…" : "Sign in"}
                        </Button>
                      </div>
                      <button
                        type="button"
                        class="desktop-onboarding__link"
                        disabled={account.pending}
                        onClick={() => setAccount({ keyEntry: false, key: "" })}
                      >
                        Back to browser sign-in
                      </button>
                    </Show>
                    {errorNote()}
                  </div>
                </Match>

                <Match when={step() === "ace"}>
                  <h1 ref={title} id="desktop-onboarding-title" tabindex="-1">
                    Turn on Ace
                  </h1>
                  <p class="desktop-onboarding__body">
                    Managed models, literature search through Firecrawl, schematics and image generation, and one team
                    wallet. Pay as you go, $0 to start.
                  </p>
                  <div class="desktop-onboarding__actions">
                    <Switch>
                      <Match when={ace.status === "on"}>
                        <p class="desktop-onboarding__done" role="status" aria-live="polite">
                          Ace is on{money(ace.balance) ? ` · ${money(ace.balance)} available` : ""}
                        </p>
                        <Button variant="primary" size="large" onClick={() => remember("connect")}>
                          Continue
                        </Button>
                      </Match>
                      <Match when={ace.status === "waiting" || ace.status === "checking"}>
                        <Button variant="primary" size="large" disabled>
                          {ace.status === "checking" ? "Checking…" : "Waiting for Ace…"}
                        </Button>
                        <p class="desktop-onboarding__note" role="status" aria-live="polite">
                          {ace.status === "checking" ? "Reading your wallet." : "Finish in your browser."}
                        </p>
                        <button type="button" class="desktop-onboarding__link" onClick={() => void checkAce()}>
                          Check again
                        </button>
                        <button type="button" class="desktop-onboarding__link" onClick={leaveAce}>
                          {ace.funded ? "Continue with your Wallet" : "Skip for now"}
                        </button>
                      </Match>
                      <Match when={ace.funded}>
                        <p class="desktop-onboarding__done" role="status" aria-live="polite">
                          Managed models are ready
                          {money(ace.balance) ? ` · ${money(ace.balance)} available, no card needed` : ""}
                        </p>
                        <Button variant="primary" size="large" onClick={leaveAce}>
                          Continue
                        </Button>
                        <p class="desktop-onboarding__note">{reloadRule()}</p>
                        <Show when={ace.note}>
                          <p class="desktop-onboarding__note" role="status" aria-live="polite">
                            {ace.note}
                          </p>
                        </Show>
                        <button type="button" class="desktop-onboarding__link" onClick={turnOnAce}>
                          Turn on Ace
                        </button>
                      </Match>
                      <Match when={true}>
                        <Button variant="primary" size="large" onClick={turnOnAce}>
                          Turn on Ace
                        </Button>
                        <Show when={ace.note}>
                          <p class="desktop-onboarding__note" role="status" aria-live="polite">
                            {ace.note}
                          </p>
                        </Show>
                        <button type="button" class="desktop-onboarding__link" onClick={leaveAce}>
                          Skip for now
                        </button>
                      </Match>
                    </Switch>
                    {errorNote()}
                  </div>
                </Match>

                <Match when={step() === "connect"}>
                  <h1 ref={title} id="desktop-onboarding-title" tabindex="-1">
                    Connect your models
                  </h1>
                  <p class="desktop-onboarding__body">
                    {ace.status === "on"
                      ? "Optional. Anything you add is used alongside Ace."
                      : ace.funded
                        ? "Optional. Anything you add is used alongside your Wallet."
                        : "Optional. Keys stay on this device."}
                  </p>
                  <ul class="desktop-onboarding__rows" aria-label="Connections">
                    <For each={CONNECTIONS}>
                      {(item) => {
                        const open = () => connect.open === item.id
                        const done = () => status(item)
                        const busy = () => connect.busy === item.id
                        const expandable = () => item.kind === "key" || item.kind === "credential"
                        return (
                          <li data-open={open() ? "true" : undefined}>
                            <div class="desktop-onboarding__row">
                              <ProviderLogo id={item.logo} label={item.name} size="small" />
                              <span class="desktop-onboarding__row-name">{item.name}</span>
                              <Show
                                when={!done()}
                                fallback={<span class="desktop-onboarding__row-done">{done()}</span>}
                              >
                                <Show
                                  when={expandable()}
                                  fallback={
                                    <Button
                                      variant="secondary"
                                      size="small"
                                      disabled={Boolean(connect.busy)}
                                      onClick={() => void connectItem(item)}
                                    >
                                      {busy() ? "Waiting…" : item.kind === "oauth" ? "Connect" : "Detect"}
                                    </Button>
                                  }
                                >
                                  <Button
                                    variant="secondary"
                                    size="small"
                                    disabled={Boolean(connect.busy)}
                                    aria-expanded={open()}
                                    onClick={() => setConnect("open", open() ? undefined : item.id)}
                                  >
                                    {open() ? "Cancel" : "Add key"}
                                  </Button>
                                </Show>
                              </Show>
                            </div>
                            <Show when={open() && expandable() && !done()}>
                              <div class="desktop-onboarding__inline">
                                <TextField
                                  hideLabel
                                  label={`${item.name} API key`}
                                  type="password"
                                  value={connect.drafts[item.id] ?? ""}
                                  disabled={Boolean(connect.busy)}
                                  onChange={(value: string) => setConnect("drafts", item.id, value)}
                                  placeholder={item.placeholder ?? "API key"}
                                  autocomplete="off"
                                  onKeyDown={(event: KeyboardEvent) => {
                                    if (event.key !== "Enter") return
                                    event.preventDefault()
                                    void connectItem(item)
                                  }}
                                />
                                <Button
                                  variant="primary"
                                  size="small"
                                  disabled={Boolean(connect.busy) || !(connect.drafts[item.id] ?? "").trim()}
                                  onClick={() => void connectItem(item)}
                                >
                                  {busy() ? "Saving…" : "Save"}
                                </Button>
                              </div>
                            </Show>
                          </li>
                        )
                      }}
                    </For>
                  </ul>
                  <div class="desktop-onboarding__actions">
                    <Button
                      variant="primary"
                      size="large"
                      disabled={Boolean(connect.busy)}
                      onClick={() => remember("done")}
                    >
                      Continue
                    </Button>
                    <Show when={!modelSource()}>
                      <p class="desktop-onboarding__note" role="status">
                        No model connected yet. Add one later in Customize → Models.
                      </p>
                    </Show>
                    {errorNote()}
                  </div>
                </Match>

                <Match when={step() === "done"}>
                  <h1 ref={title} id="desktop-onboarding-title" tabindex="-1">
                    You're set
                  </h1>
                  <dl class="desktop-onboarding__summary">
                    <div>
                      <dt>Account</dt>
                      <dd>Signed in</dd>
                    </div>
                    <div>
                      <dt>Ace</dt>
                      <dd>
                        {ace.status === "on"
                          ? `On${money(ace.balance) ? ` · ${money(ace.balance)}` : ""}`
                          : ace.funded
                            ? `Off · Wallet${money(ace.balance) ? ` ${money(ace.balance)}` : ""} funds managed models`
                            : "Off"}
                      </dd>
                    </div>
                    <div>
                      <dt>Connected</dt>
                      <dd>
                        {CONNECTIONS.filter(status)
                          .map((item) => item.name)
                          .join(", ") || "Nothing yet"}
                      </dd>
                    </div>
                  </dl>
                  <div class="desktop-onboarding__actions">
                    <Button variant="primary" size="large" onClick={() => void finish()}>
                      Open workspace
                    </Button>
                    {errorNote()}
                  </div>
                </Match>
              </Switch>

              <Show when={back()}>
                {(previous) => (
                  <footer class="desktop-onboarding__foot">
                    <button type="button" class="desktop-onboarding__link" onClick={() => remember(previous())}>
                      Back
                    </button>
                  </footer>
                )}
              </Show>
            </section>
          </main>
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}

export function DesktopOnboarding(props: ParentProps) {
  const server = useServer()
  const platform = usePlatform()
  return (
    <DesktopOnboardingController server={server} platform={platform}>
      {props.children}
    </DesktopOnboardingController>
  )
}
