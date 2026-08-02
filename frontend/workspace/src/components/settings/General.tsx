// General — Account and Licensing, plus the appearance/theme
// controls. Everything here is wired to a real endpoint:
//   • Account   → client.account.get / client.account.logout, billing link.
//   • Licensing  → /settings/preferences (real JSON store, persisted to ~/.openscience).
//   • Appearance → the extracted AppearanceSections (theme, sounds, updates, …).
import { Component, Show, createSignal, onMount, type JSX } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Switch } from "@synsci/ui/switch"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { URLS } from "@/config/urls"
import { FONT_CODE, FONT_SANS } from "@/styles/tokens"
import { AppearanceSections } from "../settings-general"
import { settingsApi } from "./api"
import { productPreferences } from "@/context/product-preferences"

type Account = {
  session?: boolean
  user?: Record<string, unknown> & { email?: string; subscription_plan?: string }
  balance_usd?: number
  billing_mode?: { mode: "byok" | "managed" } | null
}

type Preferences = {
  intent: "commercial" | "non-commercial"
  extra_budget_usd: number
  show_trace: boolean
  atlas_enabled: boolean
}

export default function General() {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const server = useServer()

  const fetchFn = () => platform.fetch ?? fetch
  const base = () => server.url

  const [account, setAccount] = createSignal<Account | undefined>()
  const [prefs, setPrefs] = createSignal<Preferences | undefined>()
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

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
    const next = await settingsApi<Preferences>(base(), fetchFn(), "/settings/preferences", {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
    setPrefs(next)
    productPreferences.sync(next)
  }

  const signOut = async () => {
    if (!window.confirm("Disconnect this local server from OpenScience?")) return
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

  const plan = () => (account()?.user?.subscription_plan as string | undefined) ?? undefined
  const org = () => {
    const u = account()?.user ?? {}
    return (u.organization ?? u.org ?? u.team ?? u.organization_name) as string | undefined
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-8">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-8 pb-8 max-w-[760px]">
          <h2 class="text-16-medium text-text-strong">General</h2>
          <p class="text-13-regular text-text-weak">Your account, workspace, licensing, and appearance.</p>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full max-w-[760px]">
        <Show when={error()}>
          <div
            style={{
              "font-family": FONT_SANS,
              "font-size": "12px",
              color: "var(--color-error)",
              border: "1px solid var(--color-error-muted)",
              "border-radius": "4px",
              padding: "10px 12px",
            }}
          >
            {error()}
          </div>
        </Show>

        {/* Account */}
        <Section title="Account" description="Your OpenScience identity and subscription.">
          <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
            <Row title="Email">
              <span class="text-13-regular text-text-strong">
                {(account()?.user?.email as string) ?? (account()?.session === false ? "Not connected" : "—")}
              </span>
            </Row>
            <Row title="Plan">
              <span class="text-13-regular text-text-strong capitalize">{plan() ?? "Free"}</span>
            </Row>
            <Show when={org()}>
              <Row title="Organization">
                <span class="text-13-regular text-text-strong">{org()}</span>
              </Row>
            </Show>
            <Row title="Billing" description="Manage your subscription, wallet, and invoices.">
              <Button size="small" variant="secondary" onClick={() => platform.openLink(URLS.dashboardCli)}>
                manage billing
              </Button>
            </Row>
            <Row title="Session" description="Disconnect this machine from OpenScience.">
              <Button
                size="small"
                variant="secondary"
                disabled={busy() || account()?.session === false}
                onClick={() => void signOut()}
              >
                sign out
              </Button>
            </Row>
            <Show when={account()?.session === false}>
              <div class="px-4 py-3">
                <p class="text-12-regular text-text-weak">
                  Signed out — run{" "}
                  <code style={{ "font-family": FONT_CODE, "font-size": "11px" }}>openscience connect login</code> in a
                  terminal to reconnect this machine.
                </p>
              </div>
            </Show>
          </div>
        </Section>

        {/* Licensing */}
        <Section title="Licensing" description="How you intend to use outputs from OpenScience.">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <IntentCard
              active={prefs()?.intent === "non-commercial"}
              title="Non-commercial"
              body="Research, evaluation, and personal projects."
              onClick={() => void savePref({ intent: "non-commercial" })}
            />
            <IntentCard
              active={prefs()?.intent === "commercial"}
              title="Commercial"
              body="Use in a product or for-profit work."
              onClick={() => void savePref({ intent: "commercial" })}
            />
          </div>
        </Section>

        <Section title="Workspace" description="Choose which advanced surfaces appear in every project.">
          <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
            <Row
              title="Atlas"
              description="Show the research map in project navigation. Your map data is never changed."
            >
              <Switch
                hideLabel
                checked={prefs()?.atlas_enabled ?? true}
                disabled={!prefs()}
                onChange={(atlas_enabled) => void savePref({ atlas_enabled })}
              >
                Show Atlas
              </Switch>
            </Row>
            <Row title="Trace" description="Show the local time, cost, and activity trace in session navigation.">
              <Switch
                hideLabel
                checked={prefs()?.show_trace ?? false}
                disabled={!prefs()}
                onChange={(show_trace) => void savePref({ show_trace })}
              >
                Show Trace
              </Switch>
            </Row>
          </div>
        </Section>

        {/* Appearance / theme / notifications / sounds / updates */}
        <AppearanceSections />
      </div>
    </div>
  )
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

const Section: Component<{ title: string; description?: string; children: JSX.Element }> = (props) => (
  <div class="flex flex-col gap-3">
    <div class="flex flex-col gap-0.5">
      <h3 class="text-13-medium text-text-weak tracking-wide">{props.title}</h3>
      <Show when={props.description}>
        <p class="text-12-regular text-text-weak">{props.description}</p>
      </Show>
    </div>
    {props.children}
  </div>
)

const Row: Component<{ title: string; description?: string; children: JSX.Element }> = (props) => (
  <div class="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5 border-b border-border-weak-base last:border-none">
    <div class="flex flex-col gap-0.5 min-w-0">
      <span class="text-14-medium text-text-strong">{props.title}</span>
      <Show when={props.description}>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </Show>
    </div>
    <div class="flex-shrink-0">{props.children}</div>
  </div>
)

const IntentCard: Component<{ active: boolean; title: string; body: string; onClick: () => void }> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    style={{
      all: "unset",
      cursor: "pointer",
      display: "flex",
      "flex-direction": "column",
      gap: "5px",
      padding: "14px 16px",
      "border-radius": "4px",
      border: "1px solid var(--color-border)",
      "box-shadow": props.active ? "inset 0 0 0 1px var(--color-text-interactive-base, var(--color-text))" : "none",
      background: props.active ? "var(--color-surface-interactive-weak, var(--color-accent-subtle))" : "transparent",
      transition: "border-color 120ms, box-shadow 120ms, background 120ms",
    }}
  >
    <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
      <span class="text-14-medium text-text-strong">{props.title}</span>
      <Show when={props.active}>
        <span style={{ "font-family": FONT_SANS, "font-size": "11px", color: "var(--color-text-muted)" }}>active</span>
      </Show>
    </div>
    <span class="text-12-regular text-text-weak" style={{ "line-height": 1.5 }}>
      {props.body}
    </span>
  </button>
)
