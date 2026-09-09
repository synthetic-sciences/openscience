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
import { Button } from "@synsci/ui/button"
import { TextField } from "@synsci/ui/text-field"
import {
  IconBolt,
  IconCheckCircle,
  IconChevronDown,
  IconChevronLeft,
  IconLink,
  IconPhoto,
  IconSearch,
  IconShield,
  IconSparkles,
  IconUser,
} from "@/atlas/shared/Icon"
import { Wordmark } from "@/atlas/Wordmark"
import { ProviderLogo } from "@/components/settings/ProviderLogo"
import { settingsApi } from "@/components/settings/api"
import { ACCOUNT_DEADLINE_MS, withAccountDeadline } from "@/components/settings/account-deadline"
import { URLS } from "@/config/urls"
import { usePlatform } from "@/context/platform"
import type { Platform } from "@/context/platform"
import { useServer } from "@/context/server"
import { AsciiSpinner } from "./shared/AsciiSpinner"
import "./DesktopOnboarding.css"

/** The setup revision every install sees once. Mirrors ONBOARDING_VERSION on the server. */
export const ONBOARDING_VERSION = 2

export type OnboardingStep = "account" | "ace" | "connect" | "done"
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
  error?: string
}

type Connection = {
  id: string
  logo: string
  name: string
  detail: string
  kind: "oauth" | "key" | "credential" | "detect"
  placeholder?: string
}

const CONNECTIONS: Connection[] = [
  {
    id: "openai-codex",
    logo: "openai-codex",
    name: "ChatGPT / Codex",
    detail: "Use your ChatGPT subscription",
    kind: "oauth",
  },
  { id: "anthropic", logo: "anthropic", name: "Anthropic", detail: "API key", kind: "key", placeholder: "sk-ant-…" },
  { id: "openai", logo: "openai", name: "OpenAI", detail: "API key", kind: "key", placeholder: "sk-…" },
  {
    id: "openrouter",
    logo: "openrouter",
    name: "OpenRouter",
    detail: "API key · one key for many models",
    kind: "key",
    placeholder: "sk-or-…",
  },
  {
    id: "firecrawl",
    logo: "firecrawl",
    name: "Firecrawl",
    detail: "API key · your own literature and web search",
    kind: "credential",
    placeholder: "fc-…",
  },
  {
    id: "modal",
    logo: "modal",
    name: "Modal",
    detail: "Remote compute · detected from your Modal CLI profile",
    kind: "detect",
  },
]

const ACE_BENEFITS = [
  { icon: IconSparkles, title: "Managed models", detail: "Frontier models with no keys to manage." },
  { icon: IconSearch, title: "Literature search", detail: "High-quality search and full text through Firecrawl." },
  { icon: IconPhoto, title: "Schematics and images", detail: "Scientific figures and image generation." },
  { icon: IconShield, title: "Team wallet", detail: "One workspace balance, pay as you go." },
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
        <Wordmark size="md" />
        <AsciiSpinner label="Preparing your workspace…" color="var(--color-text-muted)" />
      </div>
    </main>
  )
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
  const seen = desktop && cachedVersion() >= ONBOARDING_VERSION
  const [complete, setComplete] = createSignal(!desktop || seen)
  const [ready, setReady] = createSignal(!desktop || seen)
  const [step, setStep] = createSignal<OnboardingStep>("account")
  const [error, setError] = createSignal<string>()
  const [account, setAccount] = createStore({ connected: false, pending: false, keyEntry: false, key: "" })
  const [ace, setAce] = createStore({
    status: "idle" as "idle" | "checking" | "waiting" | "on" | "unavailable",
    balance: undefined as number | null | undefined,
    note: undefined as string | undefined,
  })
  const [connect, setConnect] = createStore({
    open: undefined as string | undefined,
    busy: undefined as string | undefined,
    drafts: {} as Record<string, string>,
    connected: {} as Record<string, string>,
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
      if (value.desktop_onboarding_version >= ONBOARDING_VERSION) {
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

  const readWallet = async (summary: boolean) => {
    if (ace.status === "on") return true
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
    if (lifetime.signal.aborted) return false
    if (wallet.aceEnabled) {
      // Ace is the funding source now; the model list follows the billing mode.
      await api("/settings/billing", { method: "PUT", body: JSON.stringify({ llm: "managed" }) }).catch(() => undefined)
      setAce({ status: "on", balance: wallet.availableUsd ?? wallet.balanceUsd, note: undefined })
      return true
    }
    if (ace.status === "checking") setAce("status", wallet.error ? "unavailable" : "idle")
    if (wallet.error) setAce("note", wallet.error)
    return false
  }

  const turnOnAce = () => {
    platform.openLink(URLS.dashboardBilling)
    setAce({ status: "waiting", note: undefined })
    const started = Date.now()
    const poll = async () => {
      if (lifetime.signal.aborted || ace.status !== "waiting") return
      if (await readWallet(false)) return
      if (Date.now() - started > ACE_WAIT_MS) {
        setAce({ status: "idle", note: "Ace is not on yet. Finish in your browser, then check again." })
        return
      }
      aceWait = setTimeout(() => void poll(), props.acePollMs ?? ACE_POLL_MS)
    }
    aceWait = setTimeout(() => void poll(), props.acePollMs ?? ACE_POLL_MS)
  }

  const checkAce = async () => {
    if (aceWait) clearTimeout(aceWait)
    setAce("status", "checking")
    const on = await readWallet(false)
    if (!on && !lifetime.signal.aborted)
      setAce("note", (note) => note ?? "Ace is not on yet. Finish in your browser, then check again.")
  }

  const login = async () => {
    if (account.pending) return
    setAccount("pending", true)
    setError(undefined)
    let expired = false
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
      await api(`/auth/${encodeURIComponent(item.id)}/onboarding`, {
        method: "PUT",
        body: JSON.stringify({ type: "api", key: draft }),
        signal: lifetime.signal,
      })
      return "Key saved"
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

  const connectedCount = () => Object.keys(connect.connected).length
  const modelSource = () =>
    ace.status === "on" ||
    CONNECTIONS.some((item) => item.kind !== "credential" && item.kind !== "detect" && connect.connected[item.id])
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
            <Wordmark size="md" />
            <section class="desktop-onboarding__card" data-step={step()}>
              <ol class="desktop-onboarding__dots" aria-label={`Step ${STEPS.indexOf(step()) + 1} of ${STEPS.length}`}>
                <For each={STEPS}>
                  {(item) => (
                    <li
                      data-state={
                        item === step() ? "current" : STEPS.indexOf(item) < STEPS.indexOf(step()) ? "done" : "upcoming"
                      }
                      aria-current={item === step() ? "step" : undefined}
                    />
                  )}
                </For>
              </ol>

              <Switch>
                <Match when={step() === "account"}>
                  <div class="desktop-onboarding__panel">
                    <span class="desktop-onboarding__tile" aria-hidden="true">
                      <IconUser size={18} strokeWidth={1.5} />
                    </span>
                    <h1 ref={title} id="desktop-onboarding-title" tabindex="-1">
                      Welcome to OpenScience
                    </h1>
                    <p class="desktop-onboarding__lead">
                      Create your account or sign in to continue. Your workspace supplies model access, shared
                      credentials, and the team wallet.
                    </p>
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
                              {account.pending ? "Waiting for sign-in…" : "Continue with Synthetic Sciences"}
                            </Button>
                            <p class="desktop-onboarding__status" role="status" aria-live="polite">
                              {account.pending
                                ? "Choose your workspace in your browser. This window continues automatically."
                                : "Opens Synthetic Sciences in your browser to sign up or sign in."}
                            </p>
                            <button
                              type="button"
                              class="desktop-onboarding__link"
                              disabled={account.pending}
                              onClick={() => setAccount("keyEntry", true)}
                            >
                              Use a sign-in key instead
                            </button>
                          </>
                        }
                      >
                        <div class="desktop-onboarding__inline">
                          <label class="desktop-onboarding__field">
                            <span>Sign-in key</span>
                            <TextField
                              hideLabel
                              type="password"
                              value={account.key}
                              disabled={account.pending}
                              onChange={(value: string) => setAccount("key", value)}
                              placeholder="Paste the key from app.syntheticsciences.ai"
                              autocomplete="off"
                              onKeyDown={(event: KeyboardEvent) => {
                                if (event.key !== "Enter") return
                                event.preventDefault()
                                void loginWithKey()
                              }}
                            />
                          </label>
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
                  </div>
                </Match>

                <Match when={step() === "ace"}>
                  <div class="desktop-onboarding__panel desktop-onboarding__panel--wide">
                    <span class="desktop-onboarding__tile" aria-hidden="true">
                      <IconBolt size={18} strokeWidth={1.5} />
                    </span>
                    <h1 ref={title} id="desktop-onboarding-title" tabindex="-1">
                      Turn on Ace
                    </h1>
                    <p class="desktop-onboarding__lead">
                      Managed models and research tools, pay as you go. $0 to activate, provider price plus a 5.5%
                      funding fee, no subscription.
                    </p>
                    <ul class="desktop-onboarding__benefits">
                      <For each={ACE_BENEFITS}>
                        {(benefit) => (
                          <li>
                            <benefit.icon size={16} strokeWidth={1.5} aria-hidden="true" />
                            <div>
                              <strong>{benefit.title}</strong>
                              <span>{benefit.detail}</span>
                            </div>
                          </li>
                        )}
                      </For>
                    </ul>
                    <div class="desktop-onboarding__actions">
                      <Switch>
                        <Match when={ace.status === "on"}>
                          <p class="desktop-onboarding__done" role="status" aria-live="polite">
                            <IconCheckCircle size={14} strokeWidth={1.5} aria-hidden="true" />
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
                          <p class="desktop-onboarding__status" role="status" aria-live="polite">
                            {ace.status === "checking"
                              ? "Reading your wallet."
                              : "Finish in your browser. This window continues automatically."}
                          </p>
                          <button type="button" class="desktop-onboarding__link" onClick={() => void checkAce()}>
                            I've done this, check again
                          </button>
                        </Match>
                        <Match when={true}>
                          <span class="desktop-onboarding__recommended">
                            <Button variant="primary" size="large" onClick={turnOnAce}>
                              Turn on Ace
                            </Button>
                            <small aria-label="Recommended">Recommended</small>
                          </span>
                          <p class="desktop-onboarding__status" role="status" aria-live="polite">
                            {ace.note ?? "Opens your billing page in the browser."}
                          </p>
                          <button type="button" class="desktop-onboarding__link" onClick={() => remember("connect")}>
                            Skip for now
                          </button>
                        </Match>
                      </Switch>
                      {errorNote()}
                    </div>
                  </div>
                </Match>

                <Match when={step() === "connect"}>
                  <div class="desktop-onboarding__panel desktop-onboarding__panel--wide">
                    <span class="desktop-onboarding__tile" aria-hidden="true">
                      <IconLink size={18} strokeWidth={1.5} />
                    </span>
                    <h1 ref={title} id="desktop-onboarding-title" tabindex="-1">
                      Connect your own models
                    </h1>
                    <p class="desktop-onboarding__lead">
                      {ace.status === "on"
                        ? "Optional. Anything you connect here is used alongside Ace."
                        : "Bring a ChatGPT subscription or provider keys. Everything here is optional."}
                    </p>
                    <ul class="desktop-onboarding__connections" aria-label="Connections">
                      <For each={CONNECTIONS}>
                        {(item) => {
                          const open = () => connect.open === item.id
                          const done = () => connect.connected[item.id]
                          const busy = () => connect.busy === item.id
                          const expandable = () => item.kind === "key" || item.kind === "credential"
                          return (
                            <li data-open={open() ? "true" : undefined} data-connected={done() ? "true" : undefined}>
                              <div class="desktop-onboarding__connection">
                                <ProviderLogo id={item.logo} label={item.name} />
                                <span class="desktop-onboarding__connection-copy">
                                  <strong>{item.name}</strong>
                                  <small>{done() ?? item.detail}</small>
                                </span>
                                <Show
                                  when={!done()}
                                  fallback={
                                    <span
                                      class="desktop-onboarding__connection-done"
                                      aria-label={`${item.name} connected`}
                                    >
                                      <IconCheckCircle size={14} strokeWidth={1.5} aria-hidden="true" />
                                    </span>
                                  }
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
                                        {busy()
                                          ? item.kind === "oauth"
                                            ? "Waiting…"
                                            : "Checking…"
                                          : item.kind === "oauth"
                                            ? "Connect"
                                            : "Detect"}
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
                                      Add key
                                      <IconChevronDown size={12} strokeWidth={1.5} aria-hidden="true" />
                                    </Button>
                                  </Show>
                                </Show>
                              </div>
                              <Show when={open() && expandable() && !done()}>
                                <div class="desktop-onboarding__inline">
                                  <label class="desktop-onboarding__field">
                                    <span>{item.name} API key</span>
                                    <TextField
                                      hideLabel
                                      type="password"
                                      value={connect.drafts[item.id] ?? ""}
                                      disabled={Boolean(connect.busy)}
                                      onChange={(value: string) => setConnect("drafts", item.id, value)}
                                      placeholder={item.placeholder ?? "Paste key"}
                                      autocomplete="off"
                                      onKeyDown={(event: KeyboardEvent) => {
                                        if (event.key !== "Enter") return
                                        event.preventDefault()
                                        void connectItem(item)
                                      }}
                                    />
                                  </label>
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
                    <p class="desktop-onboarding__note">
                      Keys are stored in an owner-only file on this device, never in project files or conversations.
                      Local models (Ollama, LM Studio) connect later in Customize → Local models.
                    </p>
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
                        <p class="desktop-onboarding__status" role="status">
                          You will need a model before your first message. Add one anytime in Customize → Models.
                        </p>
                      </Show>
                      {errorNote()}
                    </div>
                  </div>
                </Match>

                <Match when={step() === "done"}>
                  <div class="desktop-onboarding__panel">
                    <span class="desktop-onboarding__tile desktop-onboarding__tile--success" aria-hidden="true">
                      <IconCheckCircle size={18} strokeWidth={1.5} />
                    </span>
                    <h1 ref={title} id="desktop-onboarding-title" tabindex="-1">
                      You're set
                    </h1>
                    <p class="desktop-onboarding__lead">
                      Create your first project in the workspace and send a message.
                    </p>
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
                            : "Off · turn on in Customize → Models"}
                        </dd>
                      </div>
                      <div>
                        <dt>Connected</dt>
                        <dd>
                          {connectedCount()
                            ? CONNECTIONS.filter((item) => connect.connected[item.id])
                                .map((item) => item.name)
                                .join(", ")
                            : "Nothing yet"}
                        </dd>
                      </div>
                    </dl>
                    <div class="desktop-onboarding__actions">
                      <Button variant="primary" size="large" onClick={() => void finish()}>
                        Open workspace
                      </Button>
                      {errorNote()}
                    </div>
                  </div>
                </Match>
              </Switch>

              <Show when={back()}>
                {(previous) => (
                  <button type="button" class="desktop-onboarding__back" onClick={() => remember(previous())}>
                    <IconChevronLeft size={12} strokeWidth={1.5} aria-hidden="true" />
                    Back
                  </button>
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
