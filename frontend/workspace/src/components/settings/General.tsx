// General — account and appearance controls. Everything here is wired to a
// real endpoint:
//   • Account   → client.account.get / client.account.logout, billing link.
//   • Appearance → the extracted AppearanceSections (display mode, sounds, updates, …).
import { Component, Show, createSignal, onMount, type JSX } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Icon, type IconProps } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { showToast } from "@synsci/ui/toast"
import { confirmDialog } from "@/atlas/dialogs"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { URLS } from "@/config/urls"
import { AppearanceSections } from "../settings-general"
import { PanelBody, PanelHeader, PanelScroll, Section } from "./_shared"
import { walletBalanceLabel } from "./credit-balance"
import { DataUse } from "./DataUse"
import "./preference-panels.css"

type Account = {
  session?: boolean
  user?: Record<string, unknown> & { email?: string }
  balance_usd?: number | null
  billing_mode?: { mode: "byok" | "managed" } | null
}

export default function General() {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const dialog = useDialog()

  const [account, setAccount] = createSignal<Account | undefined>()
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [showAdvanced, setShowAdvanced] = createSignal(false)

  const loadAccount = async () => {
    try {
      const res = await sdk.client.account.get()
      setAccount(((res as any).data ?? res) as Account)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  onMount(() => {
    void loadAccount()
  })

  const signOut = async () => {
    const confirmed = await confirmDialog(dialog, {
      title: "Disconnect this server?",
      message:
        "This disconnects the local server from your Synthetic Sciences account. Local projects and files stay on this machine.",
      confirmLabel: "Disconnect",
      danger: true,
    })
    if (!confirmed) return
    setBusy(true)
    try {
      const res = await sdk.client.account.logout()
      if (res.error)
        throw new Error(typeof res.error === "string" ? res.error : "The server could not clear the session")
      setAccount({ session: false })
      window.dispatchEvent(new Event("openscience:account-changed"))
    } catch (err) {
      showToast({ variant: "error", title: "Sign out failed", description: message(err) })
    } finally {
      setBusy(false)
    }
  }

  const wallet = () => {
    const current = account()
    if (!current) return "Checking…"
    return walletBalanceLabel({
      signedIn: current?.session === true,
      balanceUsd: current?.balance_usd ?? null,
    })
  }
  const accountDescription = () => {
    const current = account()
    if (!current) return "Checking the account connected to this device."
    if (!current.session) return "No Synthetic Sciences account is connected to this device."
    return "Connected to Synthetic Sciences on this device."
  }
  const org = () => {
    const u = account()?.user ?? {}
    return (u.organization ?? u.org ?? u.team ?? u.organization_name) as string | undefined
  }

  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-preferences-panel--general">
        <PanelHeader title="General" description="Manage your Synthetic Sciences account and workspace preferences." />
        <PanelBody>
          <Show when={error()}>
            <div class="settings-alert" data-tone="critical" role="alert">
              {error()}
            </div>
          </Show>

          {/* Account */}
          <Section title="Account" description={accountDescription()}>
            <div class="settings-card settings-preferences-card">
              <Row icon="providers" title="Email">
                <span class="settings-account-value">
                  {(account()?.user?.email as string) ??
                    (account()?.session === false ? "Not connected" : "Not available")}
                </span>
              </Row>
              <Row icon="star" title="Wallet">
                <span class="settings-account-value">{wallet()}</span>
              </Row>
              <Show when={org()}>
                <Row icon="home" title="Organization">
                  <span class="settings-account-value">{org()}</span>
                </Row>
              </Show>
              <Row icon="bolt" title="Wallet and billing" description="Manage Ace, payment methods, and receipts.">
                <Button size="small" variant="secondary" onClick={() => platform.openLink(URLS.dashboardBilling)}>
                  Open billing
                </Button>
              </Row>
              <Row
                icon="link"
                title="Session"
                description="Disconnect this machine from your Synthetic Sciences account."
              >
                <Button
                  size="small"
                  variant="secondary"
                  disabled={busy() || account()?.session === false}
                  onClick={() => void signOut()}
                >
                  Disconnect
                </Button>
              </Row>
              <Show when={account()?.session === false}>
                <div class="px-4 py-3">
                  <p class="text-12-regular text-text-weak">
                    Signed out. Run <code class="font-mono text-11-regular">openscience login</code> in a terminal to
                    reconnect this machine.
                  </p>
                </div>
              </Show>
            </div>
          </Section>

          {/* Keep frequently used display and notification controls visible;
              disclose sound and update preferences only when requested. */}
          <div class="settings-disclosure-group">
            <div class="settings-general-extras" data-expanded={showAdvanced() ? "true" : "false"}>
              <AppearanceSections />
            </div>
            <div class="settings-disclosure-footer">
              <button
                type="button"
                class="settings-preference-action"
                data-variant="quiet"
                aria-expanded={showAdvanced()}
                onClick={() => setShowAdvanced((value) => !value)}
              >
                <Icon
                  name="chevron-down"
                  size="small"
                  classList={{ "rotate-180": showAdvanced() }}
                  aria-hidden="true"
                />
                {showAdvanced() ? "Show fewer settings" : "Show sound and update settings"}
              </button>
            </div>
          </div>

          <DataUse />
        </PanelBody>
      </div>
    </PanelScroll>
  )
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

const Row: Component<{ icon: IconProps["name"]; title: string; description?: string; children: JSX.Element }> = (
  props,
) => (
  <div class="settings-row settings-preference-row justify-between">
    <span class="settings-preference-icon" aria-hidden="true">
      <Icon name={props.icon} size="small" />
    </span>
    <div class="settings-row-copy">
      <strong>{props.title}</strong>
      <Show when={props.description}>
        <span>{props.description}</span>
      </Show>
    </div>
    <div class="ml-auto max-w-full flex-shrink-0">{props.children}</div>
  </div>
)
