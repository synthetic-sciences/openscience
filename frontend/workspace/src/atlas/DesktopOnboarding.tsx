import { For, Show, createEffect, createMemo, createSignal, onMount, type ParentProps } from "solid-js"
import { Button } from "@synsci/ui/button"
import { TextField } from "@synsci/ui/text-field"
import { IconFolder, IconPlus } from "@/atlas/shared/Icon"
import { Wordmark } from "@/atlas/Wordmark"
import { settingsApi } from "@/components/settings/api"
import type { ProjectCreateInput } from "@/components/dialog-create-project"
import { URLS } from "@/config/urls"
import { usePlatform } from "@/context/platform"
import type { Platform } from "@/context/platform"
import { useServer } from "@/context/server"
import type { ProjectRecord } from "@/pages/home-projects"
import { projectHref } from "@/utils/project-route"
import { canUseManaged, type ManagedWallet } from "./desktop-onboarding-access"
import { AsciiSpinner } from "./shared/AsciiSpinner"
import { projectPrefs } from "./store/projectPrefs"
import "./DesktopOnboarding.css"

type Account = {
  session?: boolean
  user?: { email?: string; name?: string }
  balance_usd?: number | null
}

type AccountState = "loading" | "ready" | "error"
type Configured = "ace" | "api"
type Busy = "folder" | "blank" | "ace" | "api"
type DesktopPreferences = {
  desktop_onboarding_version: number
}

type DesktopOnboardingOperation = {
  operation_id: string
}

const providers = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "openrouter", label: "OpenRouter" },
]

const formatBalance = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "Balance unavailable"
  return `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)} balance`
}

export function folderProjectName(path: string) {
  const normalized = path.trim().replace(/[\\/]+$/u, "")
  const name = normalized.split(/[\\/]/u).filter(Boolean).at(-1)?.trim()
  return name?.slice(0, 100) || "Research project"
}

export function onboardingDraftFingerprint(draft: ProjectCreateInput) {
  // Match the canonical values accepted by the project route. Array order is
  // intentionally preserved because it is part of that route's fingerprint.
  return JSON.stringify({
    name: draft.name
      .normalize("NFC")
      .trim()
      .replace(/[ \t]+/gu, " "),
    sources: draft.sources.map((source) => ({ path: source.path.trim(), access: source.access })),
  })
}

export function createOnboardingProjectFlow(input: {
  create: (project: ProjectCreateInput & { operation_id: string }) => Promise<ProjectRecord>
  markComplete: () => Promise<unknown>
  activate: (project: ProjectRecord) => void | Promise<void>
  operationID?: () => string
  loadOperationID?: (fingerprint: string) => string | undefined | Promise<string | undefined>
  persistOperationID?: (fingerprint: string, operationID: string) => void | Promise<void>
  clearOperationID?: (fingerprint: string) => void | Promise<void>
}) {
  type Attempt = {
    operationID?: string
    persisted: boolean
    binding?: Promise<string>
    project?: ProjectRecord
    creating?: Promise<ProjectRecord>
  }
  const attempts = new Map<string, Attempt>()

  return async (draft: ProjectCreateInput) => {
    const key = onboardingDraftFingerprint(draft)
    let attempt = attempts.get(key)
    if (!attempt) {
      attempt = { persisted: false }
      attempts.set(key, attempt)
    }

    if (!attempt.project) {
      attempt.binding ??= (async () => {
        if (!attempt!.persisted) {
          const saved = await input.loadOperationID?.(key)
          attempt!.operationID = saved ?? attempt!.operationID ?? input.operationID?.() ?? crypto.randomUUID()
          if (!saved) await input.persistOperationID?.(key, attempt!.operationID)
          attempt!.persisted = true
        }
        return attempt!.operationID!
      })()
      let operationID: string
      try {
        operationID = await attempt.binding
      } finally {
        attempt.binding = undefined
      }
      attempt.creating ??= input.create({ ...draft, operation_id: operationID })
      try {
        attempt.project = await attempt.creating
      } finally {
        attempt.creating = undefined
      }
    }

    await input.markComplete()
    await input.activate(attempt.project)
    await input.clearOperationID?.(key)
    return attempt.project
  }
}

export function DesktopOnboardingLoading() {
  return (
    <main class="desktop-onboarding" aria-label="Loading desktop setup">
      <section class="desktop-onboarding__shell desktop-onboarding__shell--loading">
        <Wordmark size="sm" />
        <div class="desktop-onboarding__loading" role="status" aria-live="polite">
          <AsciiSpinner label="Preparing your workspace…" color="var(--text-weak)" />
        </div>
      </section>
    </main>
  )
}

type ServerProjects = ReturnType<typeof useServer>["projects"]
type OnboardingServer = {
  url: string
  projects: Pick<ServerProjects, "open" | "touch">
}

export function DesktopOnboardingController(
  props: ParentProps & { server: OnboardingServer; platform: Platform; desktop?: boolean },
) {
  const desktop = props.desktop ?? new URLSearchParams(window.location.search).get("desktop") === "1"
  const [complete, setComplete] = createSignal(!desktop)
  const [ready, setReady] = createSignal(!desktop)
  const [provider, setProvider] = createSignal("anthropic")
  const [key, setKey] = createSignal("")
  const [account, setAccount] = createSignal<Account>()
  const [wallet, setWallet] = createSignal<ManagedWallet>()
  const [accountState, setAccountState] = createSignal<AccountState>("loading")
  const [configured, setConfigured] = createSignal<Configured>()
  const [busy, setBusy] = createSignal<Busy>()
  const [error, setError] = createSignal<string>()
  let errorElement: HTMLParagraphElement | undefined
  const server = props.server
  const platform = props.platform
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
    void settingsApi<DesktopPreferences>(server.url, fetcher(), "/settings/preferences")
      .then((value) => {
        setComplete(value.desktop_onboarding_version >= 1)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setReady(true))
    // Account and wallet data enrich optional model setup but never delay the
    // primary route into a useful workspace.
    void loadAccount()
  })

  createEffect(() => {
    if (!error()) return
    queueMicrotask(() => errorElement?.focus())
  })

  const identity = createMemo(
    () => account()?.user?.email ?? account()?.user?.name ?? "Synthetic Sciences account connected",
  )

  const projectFlow = createOnboardingProjectFlow({
    create: (input) =>
      settingsApi<ProjectRecord>(server.url, fetcher(), "/global/project", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    markComplete: () =>
      settingsApi(server.url, fetcher(), "/settings/preferences", {
        method: "PATCH",
        body: JSON.stringify({ desktop_onboarding_version: 1 }),
      }),
    activate: (project) => {
      projectPrefs.unhide(project.id, project.worktree)
      server.projects.open(project.worktree)
      server.projects.touch(project.id)
      window.history.replaceState(window.history.state, "", projectHref(project))
    },
    loadOperationID: async (fingerprint) =>
      (
        await settingsApi<DesktopOnboardingOperation>(
          server.url,
          fetcher(),
          "/settings/preferences/onboarding-operation",
          {
            method: "POST",
            body: JSON.stringify({ fingerprint }),
          },
        )
      ).operation_id,
    clearOperationID: (fingerprint) =>
      settingsApi(server.url, fetcher(), "/settings/preferences/onboarding-operation", {
        method: "DELETE",
        body: JSON.stringify({ fingerprint }),
      }),
  })

  const createProject = async (draft: ProjectCreateInput) => {
    await projectFlow(draft)
    setComplete(true)
  }

  const run = async (kind: Busy, action: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(kind)
    setError(undefined)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const openFolder = async () => {
    await run("folder", async () => {
      if (!platform.openDirectoryPickerDialog) {
        throw new Error("The system folder picker is unavailable. Start a blank project, then connect a folder later.")
      }
      const result = await platform.openDirectoryPickerDialog({
        title: "Open a research folder",
        multiple: false,
        serverUrl: server.url,
      })
      const path = Array.isArray(result) ? result[0] : result
      if (!path) return
      await createProject({
        name: folderProjectName(path),
        sources: [{ path, access: "write" }],
      })
    })
  }

  const startBlank = async () => {
    await run("blank", () => createProject({ name: "New research project", sources: [] }))
  }

  const useAce = async () => {
    await run("ace", async () => {
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
    })
  }

  const saveKey = async () => {
    const value = key().trim()
    if (!value) return
    await run("api", async () => {
      // The local server owns the snapshot and compensation so a previous key
      // never has to cross back through the browser to be restored.
      await settingsApi(server.url, fetcher(), `/auth/${encodeURIComponent(provider())}/onboarding`, {
        method: "PUT",
        body: JSON.stringify({ type: "api", key: value }),
      })
      setKey("")
      setConfigured("api")
    })
  }

  return (
    <Show when={ready()} fallback={<DesktopOnboardingLoading />}>
      <Show
        when={complete()}
        fallback={
          <main class="desktop-onboarding" aria-labelledby="desktop-onboarding-title" aria-busy={Boolean(busy())}>
            <section class="desktop-onboarding__shell">
              <header class="desktop-onboarding__header">
                <Wordmark size="sm" />
                <span class="desktop-onboarding__account-state">Account connected</span>
              </header>

              <div class="desktop-onboarding__content">
                <div class="desktop-onboarding__intro">
                  <p>YOUR FIRST WORKSPACE</p>
                  <h1 id="desktop-onboarding-title">Start with your research</h1>
                  <span>
                    Open an existing folder to keep files, sessions, and results together. You can change model and
                    compute access anytime in Customize.
                  </span>
                </div>

                <div class="desktop-onboarding__workspace-actions" aria-label="Choose your first workspace">
                  <button
                    type="button"
                    class="desktop-onboarding__workspace-action desktop-onboarding__workspace-action--primary"
                    disabled={Boolean(busy())}
                    onClick={() => void openFolder()}
                  >
                    <span class="desktop-onboarding__workspace-icon" aria-hidden="true">
                      <IconFolder size={19} strokeWidth={1.55} />
                    </span>
                    <span>
                      <strong>{busy() === "folder" ? "Opening folder…" : "Open a folder"}</strong>
                      <small>Recommended · continue with an existing research directory</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    class="desktop-onboarding__workspace-action"
                    disabled={Boolean(busy())}
                    onClick={() => void startBlank()}
                  >
                    <span class="desktop-onboarding__workspace-icon" aria-hidden="true">
                      <IconPlus size={18} strokeWidth={1.65} />
                    </span>
                    <span>
                      <strong>{busy() === "blank" ? "Creating project…" : "Start a blank project"}</strong>
                      <small>Create a clean workspace and connect folders later</small>
                    </span>
                  </button>
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
                          <select
                            value={provider()}
                            disabled={Boolean(busy())}
                            onChange={(event) => setProvider(event.currentTarget.value)}
                          >
                            <For each={providers}>{(item) => <option value={item.id}>{item.label}</option>}</For>
                          </select>
                        </label>
                        <label class="desktop-onboarding__field">
                          <span>API key</span>
                          <TextField
                            hideLabel
                            type="password"
                            value={key()}
                            disabled={Boolean(busy())}
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
                <p ref={errorElement} class="desktop-onboarding__error" role="alert" tabindex="-1">
                  {error()}
                </p>
              </Show>

              <footer class="desktop-onboarding__footer">
                <span>Model setup is optional. Your project is created before setup is marked complete.</span>
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

export function DesktopOnboarding(props: ParentProps) {
  const server = useServer()
  const platform = usePlatform()
  return (
    <DesktopOnboardingController server={server} platform={platform}>
      {props.children}
    </DesktopOnboardingController>
  )
}
