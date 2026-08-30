import { Button } from "@synsci/ui/button"
import { Icon, type IconProps } from "@synsci/ui/icon"
import { Select } from "@synsci/ui/select"
import { useDialog } from "@synsci/ui/context/dialog"
import { Show, createMemo, createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js"
import { confirmDialog } from "@/atlas/dialogs"
import { URLS } from "@/config/urls"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { AppearanceSections } from "../settings-general"
import { PanelBody, PanelHeader, PanelScroll, Section } from "./_shared"
import { settingsApi } from "./api"
import { walletBalanceLabel } from "./credit-balance"
import { ProviderLogo } from "./ProviderLogo"
import { withAccountDeadline } from "./account-deadline"
import "./preference-panels.css"

type FundingOrganization = {
  organization_id: string
  name: string
  is_personal: boolean
  status: string
  membership_status: string
  funding_available?: boolean
  use_shared_wallet?: boolean
}

type FundingContext = {
  type: "personal" | "organization"
  organization_id?: string
  available: boolean
  locked: boolean
  organizations: FundingOrganization[]
}

type Account = {
  session: boolean
  user?: Record<string, unknown> & { email?: string }
  balance_usd: number | null
  funding_context: FundingContext
  credential?: { type: "personal" | "organization"; legacy: boolean } | null
  credential_sync?: SyncStatus
}
type SyncStatus = { state: "disconnected" | "syncing" | "ready" | "error"; error?: string }

type LoginResult = { ok: boolean; error?: string }
type WorkspaceOption = { value: string; label: string }

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export default function General() {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const platform = usePlatform()
  const dialog = useDialog()
  const fetchFn = platform.fetch ?? fetch
  const [account, setAccount] = createSignal<Account>()
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal<"login" | "logout" | "workspace" | "sync">()

  const loadAccount = () =>
    withAccountDeadline((signal) => settingsApi<Account>(sdk.url, fetchFn, "/account", { signal }), 12_000)
      .then(setAccount)
      .catch((cause) => setError(errorMessage(cause)))

  const refreshAccount = () => {
    setError(undefined)
    void loadAccount()
  }

  const syncCredentials = async () => {
    if (busy()) return
    setBusy("sync")
    setError(undefined)
    try {
      const result = await withAccountDeadline(
        (signal) => settingsApi<SyncStatus>(sdk.url, fetchFn, "/account/sync", { method: "POST", signal }),
        12_000,
      )
      setAccount((current) => current && { ...current, credential_sync: result })
      if (result.state !== "ready") throw new Error(result.error ?? "Sign in to sync workspace credentials.")
      void sync
        .refreshProviders()
        .catch((cause) => setError(`Credentials synced, but models could not refresh: ${errorMessage(cause)}`))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const login = async (context: "login" | "workspace") => {
    if (busy()) return
    setBusy(context)
    setError(undefined)
    try {
      const result = await settingsApi<LoginResult>(sdk.url, fetchFn, "/account/login-browser", { method: "POST" })
      if (!result.ok) throw new Error(result.error || "Sign in did not complete. Try again.")
      window.dispatchEvent(new Event("openscience:account-changed"))
      void sync
        .refreshProviders()
        .catch((cause) => setError(`Account connected, but models could not refresh: ${errorMessage(cause)}`))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const logout = async () => {
    if (busy()) return
    const confirmed = await confirmDialog(dialog, {
      title: "Disconnect Ace account?",
      message: "This disconnects this device. Local projects, files, and your provider connections stay here.",
      confirmLabel: "Disconnect",
      danger: true,
    })
    if (!confirmed) return
    setBusy("logout")
    setError(undefined)
    try {
      await settingsApi<boolean>(sdk.url, fetchFn, "/account/logout", { method: "POST" })
      window.dispatchEvent(new Event("openscience:account-changed"))
      void sync
        .refreshProviders()
        .catch((cause) => setError(`Account disconnected, but models could not refresh: ${errorMessage(cause)}`))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const workspaceOptions = createMemo<WorkspaceOption[]>(() => {
    const context = account()?.funding_context
    if (!context) return []
    const personal: WorkspaceOption = { value: "personal", label: "Personal" }
    const organizations = context.organizations
      .filter(
        (organization) =>
          !organization.is_personal &&
          organization.status === "active" &&
          organization.membership_status === "active" &&
          organization.funding_available !== false &&
          organization.use_shared_wallet !== false,
      )
      .map((organization) => ({ value: organization.organization_id, label: organization.name }))
    return [personal, ...organizations]
  })
  const workspaceValue = createMemo(() => account()?.funding_context.organization_id ?? "personal")
  const workspace = createMemo(() => workspaceOptions().find((option) => option.value === workspaceValue()))
  const canDirectlySwitchWorkspace = createMemo(
    () =>
      account()?.credential?.type === "organization" &&
      account()?.credential?.legacy === false &&
      account()?.funding_context.locked === false,
  )
  const needsBrowserWorkspaceApproval = createMemo(() => workspaceOptions().length > 1 && !canDirectlySwitchWorkspace())

  const setWorkspace = async (option: WorkspaceOption | undefined) => {
    if (!option || busy() || option.value === workspaceValue()) return
    if (!canDirectlySwitchWorkspace()) {
      await login("workspace")
      return
    }
    setBusy("workspace")
    setError(undefined)
    try {
      const funding_context = await settingsApi<FundingContext>(sdk.url, fetchFn, "/account/funding-context", {
        method: "PUT",
        body: JSON.stringify({ organization_id: option.value === "personal" ? null : option.value }),
      })
      setAccount((current) => (current ? { ...current, funding_context } : current))
      window.dispatchEvent(new Event("openscience:account-changed"))
      void sync
        .refreshProviders()
        .catch((cause) => setError(`Workspace changed, but models could not refresh: ${errorMessage(cause)}`))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }

  onMount(() => {
    refreshAccount()
    window.addEventListener("focus", refreshAccount)
    window.addEventListener("openscience:account-changed", refreshAccount)
  })
  onCleanup(() => {
    window.removeEventListener("focus", refreshAccount)
    window.removeEventListener("openscience:account-changed", refreshAccount)
  })

  const email = () => {
    if (!account()) return error() ? "Account unavailable" : "Checking…"
    if (!account()!.session) return "Not connected"
    return account()!.user?.email || "Connected"
  }
  const wallet = () => {
    if (!account()) return error() ? "Unavailable" : "Checking…"
    return walletBalanceLabel({ signedIn: account()!.session, balanceUsd: account()!.balance_usd })
  }

  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-preferences-panel--general">
        <PanelHeader title="General" description="Ace account and app preferences." />
        <PanelBody>
          <Show when={error()}>
            <div class="settings-alert" data-tone="critical" role="alert">
              {error()}
            </div>
          </Show>

          <Section
            id="ace-account"
            title="Ace account"
            description="Your optional Synthetic Sciences sign-in and purchased Wallet balance."
          >
            <div class="settings-card settings-preferences-card settings-account-card">
              <div class="settings-row settings-preference-row">
                <span class="settings-preference-icon settings-account-logo" aria-hidden="true">
                  <ProviderLogo id="synsci" label="Ace" />
                </span>
                <div class="settings-row-copy">
                  <strong>{email()}</strong>
                  <span>
                    {account()?.session ? "Connected on this device" : "Sign in for Ace or workspace credentials"}
                  </span>
                </div>
                <div class="settings-preference-row__actions">
                  <Show
                    when={account()?.session}
                    fallback={
                      <Button
                        size="small"
                        variant="primary"
                        disabled={Boolean(busy())}
                        onClick={() => void login("login")}
                      >
                        {busy() === "login" ? "Waiting for browser…" : "Sign in"}
                      </Button>
                    }
                  >
                    <Button size="small" variant="secondary" disabled={Boolean(busy())} onClick={() => void logout()}>
                      {busy() === "logout" ? "Disconnecting…" : "Disconnect"}
                    </Button>
                  </Show>
                </div>
              </div>

              <AccountRow icon="star" title="Purchased Wallet" description="Available purchased funds for Ace.">
                <span class="settings-account-value">{wallet()}</span>
                <Button size="small" variant="secondary" onClick={() => platform.openLink(URLS.dashboardBilling)}>
                  Manage billing
                </Button>
              </AccountRow>

              <Show when={account()?.session && account()?.funding_context}>
                <AccountRow
                  icon="providers"
                  title="Workspace credentials"
                  description="Synced to this device. Local keys take priority."
                >
                  <span class="settings-account-value" aria-live="polite">
                    {busy() === "sync"
                      ? "Syncing…"
                      : account()?.credential_sync?.state === "ready"
                        ? "Up to date"
                        : account()?.credential_sync?.state === "error"
                          ? "Sync unavailable"
                          : "Ready to sync"}
                  </span>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={Boolean(busy())}
                    onClick={() => void syncCredentials()}
                  >
                    {account()?.credential_sync?.state === "error" ? "Retry sync" : "Sync now"}
                  </Button>
                </AccountRow>
                <AccountRow
                  icon="home"
                  title="Funding workspace"
                  description={
                    needsBrowserWorkspaceApproval()
                      ? "Switching this account requires browser approval."
                      : "Used for Ace usage and purchased Wallet funds."
                  }
                >
                  <Show
                    when={canDirectlySwitchWorkspace() && workspaceOptions().length > 1}
                    fallback={
                      <span class="settings-account-value">
                        {workspace()?.label ?? (account()!.funding_context.available ? "Personal" : "Unavailable")}
                      </span>
                    }
                  >
                    <div class="settings-account-workspace">
                      <Select
                        aria-label="Funding workspace"
                        options={workspaceOptions()}
                        current={workspace()}
                        value={(option) => option.value}
                        label={(option) => option.label}
                        disabled={busy() === "workspace"}
                        onSelect={(option) => void setWorkspace(option)}
                        variant="secondary"
                        size="small"
                        triggerVariant="settings"
                      />
                    </div>
                  </Show>
                  <Show when={needsBrowserWorkspaceApproval()}>
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={Boolean(busy())}
                      onClick={() => void login("workspace")}
                    >
                      {busy() === "workspace" ? "Waiting for browser…" : "Switch workspace"}
                    </Button>
                  </Show>
                </AccountRow>
              </Show>
            </div>
          </Section>

          <AppearanceSections />
        </PanelBody>
      </div>
    </PanelScroll>
  )
}

const AccountRow: Component<{
  icon: IconProps["name"]
  title: string
  description: string
  children: JSX.Element
}> = (props) => (
  <div class="settings-row settings-preference-row">
    <span class="settings-preference-icon" aria-hidden="true">
      <Icon name={props.icon} size="small" />
    </span>
    <div class="settings-row-copy">
      <strong>{props.title}</strong>
      <span>{props.description}</span>
    </div>
    <div class="settings-preference-row__actions">{props.children}</div>
  </div>
)
