// General — account, workspace navigation, and appearance
// controls. Everything here is wired to a real endpoint:
//   • Account   → client.account.get / client.account.logout, billing link.
//   • Licensing  → /settings/preferences (real JSON store, persisted to ~/.openscience).
//   • Appearance → the extracted AppearanceSections (display mode, sounds, updates, …).
import { Component, Show, createSignal, onMount, type JSX } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Icon, type IconProps } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { Switch } from "@synsci/ui/switch"
import { showToast } from "@synsci/ui/toast"
import { confirmDialog } from "@/atlas/dialogs"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { URLS } from "@/config/urls"
import { AppearanceSections } from "../settings-general"
import { settingsApi } from "./api"
import { commitPreference } from "./preference-write"
import { productPreferences } from "@/context/product-preferences"
import { PanelBody, PanelHeader, PanelScroll, Section } from "./_shared"
import "./preference-panels.css"

type Account = {
  session?: boolean
  user?: Record<string, unknown> & { email?: string; subscription_plan?: string }
  balance_usd?: number
  billing_mode?: { mode: "byok" | "managed" } | null
}

type Preferences = {
  extra_budget_usd: number
  show_trace: boolean
  atlas_enabled: boolean
}

export default function General() {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const server = useServer()
  const dialog = useDialog()

  const fetchFn = () => platform.fetch ?? fetch
  const base = () => server.url

  const [account, setAccount] = createSignal<Account | undefined>()
  const [prefs, setPrefs] = createSignal<Preferences | undefined>()
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [preferenceBusy, setPreferenceBusy] = createSignal(false)
  const [showAdvanced, setShowAdvanced] = createSignal(false)

  const loadAccount = async () => {
    try {
      const res = await sdk.client.account.get()
      setAccount(((res as any).data ?? res) as Account)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const loadPrefs = async () => {
    try {
      const next = await settingsApi<Preferences>(base(), fetchFn(), "/settings/preferences")
      setPrefs(next)
      productPreferences.sync(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  onMount(() => {
    void loadAccount()
    void loadPrefs()
  })

  const savePref = async (patch: Partial<Preferences>) => {
    if (preferenceBusy()) return
    setPreferenceBusy(true)
    setError(undefined)
    const result = await commitPreference(
      () =>
        settingsApi<Preferences>(base(), fetchFn(), "/settings/preferences", {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      (next) => {
        setPrefs(next)
        productPreferences.sync(next)
      },
    )
    if (!result.ok) setError(result.error)
    setPreferenceBusy(false)
  }

  const signOut = async () => {
    const confirmed = await confirmDialog(dialog, {
      title: "Disconnect this server?",
      message: "This signs the local server out of OpenScience. Local projects and files stay on this machine.",
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
    } catch (err) {
      showToast({ variant: "error", title: "Sign out failed", description: message(err) })
    } finally {
      setBusy(false)
    }
  }

  const plan = () => {
    const value = account()?.user?.subscription_plan as string | undefined
    if (!value) return "—"
    return `${value.charAt(0).toLocaleUpperCase()}${value.slice(1)}`
  }
  const org = () => {
    const u = account()?.user ?? {}
    return (u.organization ?? u.org ?? u.team ?? u.organization_name) as string | undefined
  }

  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-preferences-panel--general">
        <PanelHeader title="General" description="Manage your account and everyday workspace preferences." />
        <PanelBody>
          <Show when={error()}>
            <div class="settings-alert" data-tone="critical" role="alert">
              {error()}
            </div>
          </Show>

          {/* Account */}
          <Section title="Account" description="Your OpenScience identity and subscription.">
            <div class="settings-card settings-preferences-card">
              <Row icon="providers" title="Email">
                <span class="settings-account-value">
                  {(account()?.user?.email as string) ?? (account()?.session === false ? "Not connected" : "—")}
                </span>
              </Row>
              <Row icon="star" title="Plan">
                <span class="settings-account-value">{plan()}</span>
              </Row>
              <Show when={org()}>
                <Row icon="home" title="Organization">
                  <span class="settings-account-value">{org()}</span>
                </Row>
              </Show>
              <Row icon="bolt" title="Billing" description="Manage your subscription, wallet, and invoices.">
                <Button size="small" variant="secondary" onClick={() => platform.openLink(URLS.dashboardBilling)}>
                  Manage
                </Button>
              </Row>
              <Row icon="link" title="Session" description="Disconnect this machine from OpenScience.">
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
                    Signed out — run <code class="font-mono text-11-regular">openscience connect login</code> in a
                    terminal to reconnect this machine.
                  </p>
                </div>
              </Show>
            </div>
          </Section>

          <Section title="Navigation" description="Choose which optional research surfaces appear in each project.">
            <div class="settings-card settings-preferences-card">
              <Row
                icon="branch"
                title="Atlas"
                description="Show the research map in project navigation. Your map data is never changed."
              >
                <Switch
                  hideLabel
                  checked={prefs()?.atlas_enabled ?? false}
                  disabled={!prefs() || preferenceBusy()}
                  onChange={(atlas_enabled) => void savePref({ atlas_enabled })}
                >
                  Show Atlas
                </Switch>
              </Row>
              <Row
                icon="activity"
                title="Trace"
                description="Show the local time, cost, and activity trace in session navigation."
              >
                <Switch
                  hideLabel
                  checked={prefs()?.show_trace ?? false}
                  disabled={!prefs() || preferenceBusy()}
                  onChange={(show_trace) => void savePref({ show_trace })}
                >
                  Show Trace
                </Switch>
              </Row>
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
