// Wallet — read-only view of the Atlas prepaid wallet: balance, plan billing
// mode, lifetime spend, and the recent credit ledger. Wired to a real endpoint
// (GET /settings/wallet → routes/settings/wallet.ts). Adding funds is a hand-off
// to app.syntheticsciences.ai/cli (opens the Plan tab) — there is NO in-app
// payment. Sections whose data is absent are omitted (registry HARD RULE: no
// dead controls). Refetches on window focus so a dashboard top-up reflects on
// return.
import { type JSX, For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@synsci/ui/button"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { URLS } from "@/config/urls"
import { FONT_SANS } from "@/styles/tokens"
import { Card, PanelBody, PanelHeader, PanelScroll, Row, SectionLabel } from "./_shared"
import { settingsApi } from "./api"

type Transaction = {
  id: string
  amountCents: number
  source: string
  description: string
  createdAt: string
}
type WalletState = {
  signedIn: boolean
  balanceUsd: number
  billingMode: "managed" | "byok" | null
  managedSupported: boolean
  lifetimeSpentUsd: number
  transactions: Transaction[]
}

const money = (n: number) => `$${(n < 0 ? 0 : n).toFixed(n >= 100 ? 0 : 2)}`

// Signed money for the ledger — top-ups read +, debits read −.
const delta = (cents: number) => {
  const usd = Math.abs(cents) / 100
  return `${cents < 0 ? "−" : "+"}$${usd.toFixed(usd >= 100 ? 0 : 2)}`
}

const when = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

export default function Wallet() {
  const sdk = useGlobalSDK()
  const platform = usePlatform()

  const base = () => sdk.url
  const fetchFn = () => platform.fetch ?? fetch

  const [wallet, setWallet] = createSignal<WalletState>()
  const [error, setError] = createSignal<string>()

  const load = async () => {
    setError(undefined)
    try {
      setWallet(await settingsApi<WalletState>(base(), fetchFn(), "/settings/wallet"))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  // Refetch on focus so a dashboard top-up (Add funds opens a new tab) shows up
  // as soon as the user comes back.
  const focus = () => void load()
  onMount(() => {
    void load()
    window.addEventListener("focus", focus)
  })
  onCleanup(() => window.removeEventListener("focus", focus))

  const loading = () => wallet() === undefined
  const signedIn = () => wallet()?.signedIn === true
  // Distinguish signed-out / unknown (-1) / real so the panel never renders a
  // bogus "−$1.00" for the wire's unknown sentinel.
  const balanceKnown = () => signedIn() && typeof wallet()?.balanceUsd === "number" && wallet()!.balanceUsd >= 0
  const mode = () => wallet()?.billingMode
  const txns = () => wallet()?.transactions ?? []

  return (
    <PanelScroll>
      <PanelHeader
        title="Wallet"
        description="Your Atlas prepaid balance and recent credit activity. Add funds in the dashboard — credits never expire."
      />
      <PanelBody>
        <Show when={error()}>
          <div style={errorBanner()}>{error()}</div>
        </Show>

        {/* Balance */}
        <div class="flex flex-col gap-3">
          <SectionLabel label="Balance" />
          <Card>
            <Row>
              <div class="flex flex-col gap-0.5">
                <span class="text-12-regular text-text-weak">Atlas session</span>
                <span class="text-13-medium text-text-strong">
                  {loading() ? "…" : signedIn() ? "Signed in" : "Signed out"}
                </span>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-12-regular text-text-weak">Balance</span>
                <Show
                  when={balanceKnown()}
                  fallback={<span class="text-16-medium text-text-weak">{loading() ? "…" : "—"}</span>}
                >
                  <span class="text-16-medium text-text-strong">{money(wallet()!.balanceUsd)}</span>
                </Show>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-12-regular text-text-weak">Billing</span>
                <Show
                  when={!loading() && signedIn() && mode()}
                  fallback={<span class="text-13-medium text-text-weak">{loading() ? "…" : "—"}</span>}
                >
                  <span class="text-13-medium text-text-strong capitalize">{mode()}</span>
                </Show>
              </div>
              <div class="flex-1" />
              <Button size="small" variant="primary" onClick={() => platform.openLink(URLS.dashboardCli)}>
                Add funds
              </Button>
            </Row>
            <Show when={signedIn() && (wallet()?.lifetimeSpentUsd ?? 0) > 0}>
              <Row>
                <span class="text-12-regular text-text-weak flex-1">Lifetime spent</span>
                <span class="text-13-medium text-text-strong">{money(wallet()!.lifetimeSpentUsd)}</span>
              </Row>
            </Show>
            <Show when={!loading() && !signedIn()}>
              <Row>
                <p class="text-12-regular text-text-weak">
                  Sign in to Atlas to use managed credits. Bring-your-own-key models work without an account.
                </p>
              </Row>
            </Show>
          </Card>
        </div>

        {/* Recent transactions — the credit ledger. Omitted entirely when empty
            (or when signed out / the Atlas endpoint is unavailable). */}
        <Show when={txns().length > 0}>
          <div class="flex flex-col gap-3">
            <SectionLabel label="Recent transactions" count={txns().length} />
            <Card>
              <For each={txns()}>
                {(t) => (
                  <Row>
                    <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span class="text-13-regular text-text-strong truncate">{t.description || t.source}</span>
                      <span class="text-11-regular text-text-weak">{when(t.createdAt)}</span>
                    </div>
                    <span
                      class="text-13-medium flex-shrink-0"
                      classList={{ "text-text-strong": t.amountCents >= 0, "text-text-weak": t.amountCents < 0 }}
                    >
                      {delta(t.amountCents)}
                    </span>
                  </Row>
                )}
              </For>
            </Card>
          </div>
        </Show>
      </PanelBody>
    </PanelScroll>
  )
}

function errorBanner(): JSX.CSSProperties {
  return {
    "font-family": FONT_SANS,
    "font-size": "12px",
    "line-height": 1.5,
    color: "var(--color-error)",
    border: "1px solid var(--color-error-muted)",
    "border-radius": "4px",
    padding: "10px 12px",
    "white-space": "pre-wrap",
  }
}
