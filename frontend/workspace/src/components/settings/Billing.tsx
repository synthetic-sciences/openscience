// Billing — the single money surface. Merges the former Wallet, Spend, and
// Usage panels, which each rendered their own balance/session card (three
// copies of the same thing). One balance card now, plus spend routing, usage
// analytics, and the credit ledger. Each concern loads from ONE real endpoint,
// independently, so one failure never blanks the others:
//   • Balance + Ledger → GET /settings/wallet (routes/settings/wallet.ts)
//   • Spend routing    → client.settings.billing.get / .update
//   • Usage + budget   → /settings/usage + /settings/preferences
import { Component, For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { Button } from "@synsci/ui/button"
import type { SettingsBillingGetResponse } from "@synsci/sdk/v2/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { URLS } from "@/config/urls"
import { FONT_CODE, FONT_SANS, sectionTitle } from "@/styles/tokens"
import { decode64 } from "@/utils/base64"
import { settingsApi } from "./api"
import { Card, PanelBody, PanelHeader, PanelScroll, Row, SectionLabel } from "./_shared"

type Billing = SettingsBillingGetResponse

type Transaction = { id: string; amountCents: number; source: string; description: string; createdAt: string }
type WalletState = {
  signedIn: boolean
  balanceUsd: number
  billingMode: "managed" | "byok" | null
  managedSupported: boolean
  lifetimeSpentUsd: number
  transactions: Transaction[]
}

type Tokens = { input: number; output: number; reasoning: number; cache_read: number; cache_write: number }
type Usage = {
  sessions: number
  total: { cost: number; tokens: Tokens }
  latest: { id: string; title: string; cost: number; tokens: Tokens } | null
  weekly: { date: string; cost: number; tokens: number }[]
  by_model: { key: string; provider: string; model: string; cost: number; tokens: number }[]
}
type Preferences = { extra_budget_usd: number }

const money = (n: number) => `$${(n < 0 ? 0 : n).toFixed(n >= 100 ? 0 : 2)}`
const compact = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}
const tokenSum = (t: Tokens) => t.input + t.output + t.reasoning + t.cache_read + t.cache_write
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

const LLM_MODES = [
  {
    value: "managed" as const,
    title: "Managed",
    body: "LLM calls route through your Atlas wallet — metered credits, no API keys needed.",
  },
  {
    value: "byok" as const,
    title: "BYOK",
    body: "Your own provider keys or OAuth subscriptions (Claude Pro, ChatGPT, Copilot). Never billed here.",
  },
  {
    value: null,
    title: "Auto",
    body: "Detect from the credential backing each call — managed proxy tokens bill the wallet, your own keys don't.",
  },
]
const COMPUTE_MODES = [
  { value: "managed" as const, title: "Managed", body: "Atlas-provisioned GPUs, billed to your wallet." },
  {
    value: "byok" as const,
    title: "BYOK",
    body: "Your own connected GPU providers (Settings → Compute). Your provider bills you directly.",
  },
]

export default function Billing(): JSX.Element {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const server = useServer()
  const params = useParams()

  const fetchFn = () => platform.fetch ?? fetch
  const base = () => server.url
  const directory = () => decode64(params.dir) ?? ""

  // ── Balance + ledger (GET /settings/wallet) ──
  const [wallet, setWallet] = createSignal<WalletState>()
  const [walletError, setWalletError] = createSignal<string>()
  const loadWallet = async () => {
    setWalletError(undefined)
    try {
      setWallet(await settingsApi<WalletState>(base(), fetchFn(), "/settings/wallet"))
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : String(err))
    }
  }

  // ── Spend routing (client.settings.billing) ──
  const [billing, setBilling] = createSignal<Billing>()
  const [billingError, setBillingError] = createSignal<string>()
  const [billingBusy, setBillingBusy] = createSignal(false)
  const loadBilling = async () => {
    setBillingError(undefined)
    const res = await sdk.client.settings.billing.get()
    if (res.data) return setBilling(res.data)
    setBillingError("Couldn't load spend settings.")
  }
  const updateBilling = async (patch: { llm?: "managed" | "byok" | null; compute?: "managed" | "byok" }) => {
    setBillingBusy(true)
    setBillingError(undefined)
    const res = await sdk.client.settings.billing.update(patch)
    if (res.data) setBilling(res.data)
    if (!res.data) setBillingError("Couldn't save spend settings.")
    setBillingBusy(false)
  }

  // ── Usage analytics + budget (/settings/usage + /settings/preferences) ──
  const [usage, setUsage] = createSignal<Usage>()
  const [budget, setBudget] = createSignal(0)
  const [budgetDraft, setBudgetDraft] = createSignal("")
  const [usageError, setUsageError] = createSignal<string>()
  const loadUsage = async () => {
    setUsageError(undefined)
    try {
      const dir = directory()
      const q = dir ? `?directory=${encodeURIComponent(dir)}` : ""
      setUsage(await settingsApi<Usage>(base(), fetchFn(), `/settings/usage${q}`))
    } catch (e) {
      setUsageError(e instanceof Error ? e.message : String(e))
    }
    try {
      const prefs = await settingsApi<Preferences>(base(), fetchFn(), "/settings/preferences")
      setBudget(prefs.extra_budget_usd)
      setBudgetDraft(prefs.extra_budget_usd ? String(prefs.extra_budget_usd) : "")
    } catch {}
  }
  const saveBudget = async () => {
    const value = Math.max(0, Number(budgetDraft()) || 0)
    try {
      const next = await settingsApi<Preferences>(base(), fetchFn(), "/settings/preferences", {
        method: "PATCH",
        body: JSON.stringify({ extra_budget_usd: value }),
      })
      setBudget(next.extra_budget_usd)
      setBudgetDraft(next.extra_budget_usd ? String(next.extra_budget_usd) : "")
    } catch (e) {
      setUsageError(e instanceof Error ? e.message : String(e))
    }
  }

  // Refetch balance + usage on focus so a dashboard top-up (opens a new tab)
  // reflects on return.
  const focus = () => {
    void loadWallet()
    void loadUsage()
  }
  onMount(() => {
    void loadWallet()
    void loadBilling()
    void loadUsage()
    window.addEventListener("focus", focus)
  })
  onCleanup(() => window.removeEventListener("focus", focus))

  // Balance derived state
  const wLoading = () => wallet() === undefined
  const signedIn = () => wallet()?.signedIn === true
  const balanceKnown = () => signedIn() && typeof wallet()?.balanceUsd === "number" && wallet()!.balanceUsd >= 0
  const mode = () => wallet()?.billingMode
  const txns = () => wallet()?.transactions ?? []

  // Usage derived state
  const weekTotal = createMemo(() => usage()?.weekly.reduce((a, d) => a + d.cost, 0) ?? 0)
  const weekMax = createMemo(() => Math.max(0.0001, ...(usage()?.weekly ?? []).map((d) => d.cost)))
  const modelMax = createMemo(() => Math.max(0.0001, ...(usage()?.by_model ?? []).map((m) => m.cost)))

  return (
    <PanelScroll>
      <PanelHeader
        title="Billing"
        description="Your Atlas wallet, what runs on it, and where the spend goes — balance, spend routing, usage, and the credit ledger."
      />
      <PanelBody>
        {/* ── Balance ─────────────────────────────────────────────────── */}
        <div class="flex flex-col gap-3">
          <SectionLabel label="Balance" />
          <Show when={walletError()}>
            <div style={errorBanner()}>{walletError()}</div>
          </Show>
          <Card>
            <Row>
              <div class="flex flex-col gap-0.5">
                <span class="text-12-regular text-text-weak">Atlas session</span>
                <span class="text-13-medium text-text-strong">
                  {wLoading() ? "…" : signedIn() ? "Signed in" : "Signed out"}
                </span>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-12-regular text-text-weak">Balance</span>
                <Show
                  when={balanceKnown()}
                  fallback={<span class="text-16-medium text-text-weak">{wLoading() ? "…" : "—"}</span>}
                >
                  <span class="text-16-medium text-text-strong">{money(wallet()!.balanceUsd)}</span>
                </Show>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-12-regular text-text-weak">Billing</span>
                <Show
                  when={!wLoading() && signedIn() && mode()}
                  fallback={<span class="text-13-medium text-text-weak">{wLoading() ? "…" : "—"}</span>}
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
            <Show when={!wLoading() && !signedIn()}>
              <Row>
                <p class="text-12-regular text-text-weak">
                  Sign in to Atlas to use managed credits. Bring-your-own-key models work without an account.
                </p>
              </Row>
            </Show>
          </Card>
        </div>

        {/* ── Spend routing ───────────────────────────────────────────── */}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1">
            <SectionLabel label="Spend routing" />
            <p class="text-12-regular text-text-weak">
              Choose what runs on your wallet and what runs on your own keys — independently for inference and compute.
            </p>
          </div>
          <Show when={billingError()}>
            <div style={errorBanner()}>{billingError()}</div>
          </Show>
          <div class="flex flex-col gap-2">
            <span class="text-12-regular text-text-weak">LLM inference</span>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <For each={LLM_MODES}>
                {(m) => (
                  <ModeCard
                    active={billing() !== undefined && billing()!.llm === m.value}
                    disabled={billingBusy() || billing() === undefined}
                    title={m.title}
                    body={m.body}
                    onClick={() => void updateBilling({ llm: m.value })}
                  />
                )}
              </For>
            </div>
          </div>
          <div class="flex flex-col gap-2">
            <span class="text-12-regular text-text-weak">Compute</span>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <For each={COMPUTE_MODES}>
                {(m) => (
                  <ModeCard
                    active={billing()?.compute === m.value}
                    disabled={billingBusy() || billing() === undefined}
                    title={m.title}
                    body={m.body}
                    onClick={() => void updateBilling({ compute: m.value })}
                  />
                )}
              </For>
            </div>
          </div>
        </div>

        {/* ── Usage ───────────────────────────────────────────────────── */}
        <div class="flex flex-col gap-3">
          <div class="flex items-baseline justify-between">
            <SectionLabel label="This week" />
            <span class="text-12-regular text-text-weak">
              {money(weekTotal())} · {compact(usage()?.weekly.reduce((a, d) => a + d.tokens, 0) ?? 0)} tokens
            </span>
          </div>
          <Show when={usageError()}>
            <div style={errorBanner()}>{usageError()}</div>
          </Show>
          <div class="border border-border-weak-base rounded-[4px] bg-surface-base/40 px-4 py-4">
            <div class="flex items-end justify-between gap-2 h-[104px]">
              <For each={usage()?.weekly ?? []}>
                {(d) => (
                  <div class="flex flex-col items-center gap-1.5 flex-1 min-w-0 h-full justify-end">
                    <div
                      class="w-full max-w-[34px] rounded-xs"
                      style={{
                        height: `${Math.max(3, (d.cost / weekMax()) * 84)}px`,
                        background:
                          d.cost > 0
                            ? "var(--color-text-interactive-base, var(--icon-strong-base))"
                            : "var(--color-border-strong)",
                        opacity: d.cost > 0 ? 1 : 0.4,
                        transition: "height 160ms",
                      }}
                      title={`${d.date}: ${money(d.cost)}`}
                    />
                    <span class="text-11-regular text-text-weak/80">{d.date.slice(5)}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>

        {/* Extra usage budget */}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1">
            <SectionLabel label="Extra usage budget" />
            <p class="text-12-regular text-text-weak">
              A personal managed-compute ceiling. Set 0 for no extra budget beyond your plan.
            </p>
          </div>
          <div class="border border-border-weak-base rounded-[4px] bg-surface-base/40 px-4 py-4 flex flex-col gap-3">
            <form
              class="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void saveBudget()
              }}
            >
              <label class="flex flex-col gap-1 w-[160px]">
                <span style={sectionTitle}>Budget (USD)</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={budgetDraft()}
                  onInput={(e) => setBudgetDraft(e.currentTarget.value)}
                  placeholder="0"
                  style={fieldStyle()}
                />
              </label>
              <Button
                type="submit"
                size="small"
                variant="secondary"
                disabled={String(budget()) === (budgetDraft() || "0")}
              >
                save
              </Button>
            </form>
            <Show when={budget() > 0}>
              <div class="flex flex-col gap-1">
                <div class="h-2 rounded-full overflow-hidden bg-surface-base">
                  <div
                    class="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (weekTotal() / budget()) * 100)}%`,
                      background:
                        weekTotal() >= budget()
                          ? "var(--color-error)"
                          : "var(--color-text-interactive-base, var(--icon-strong-base))",
                    }}
                  />
                </div>
                <span class="text-11-regular text-text-weak">
                  {money(weekTotal())} of {money(budget())} used this week
                </span>
              </div>
            </Show>
          </div>
        </div>

        {/* Most recent session */}
        <Show when={usage()?.latest}>
          {(latest) => (
            <div class="flex flex-col gap-3">
              <SectionLabel label="Most recent session" />
              <div class="border border-border-weak-base rounded-[4px] bg-surface-base/40 px-4 py-4 flex items-center justify-between gap-4">
                <div class="flex flex-col gap-0.5 min-w-0">
                  <span class="text-13-medium text-text-strong truncate">{latest().title}</span>
                  <span class="text-12-regular text-text-weak">{compact(tokenSum(latest().tokens))} tokens</span>
                </div>
                <span class="text-14-medium text-text-strong">{money(latest().cost)}</span>
              </div>
            </div>
          )}
        </Show>

        {/* Where tokens go */}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1">
            <SectionLabel label="Where tokens go" />
            <p class="text-12-regular text-text-weak">
              Spend per model across {usage()?.sessions ?? 0} local sessions.
            </p>
          </div>
          <Show
            when={(usage()?.by_model.length ?? 0) > 0}
            fallback={
              <div
                class="text-12-regular text-text-weak"
                style={{ border: "1px dashed var(--color-border-strong)", "border-radius": "4px", padding: "16px" }}
              >
                No local usage recorded yet. Run a session and spend will show up here.
              </div>
            }
          >
            <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
              <For each={usage()?.by_model ?? []}>
                {(m) => (
                  <div class="flex flex-col gap-1.5 px-4 py-3 border-b border-border-weak-base last:border-none">
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-13-regular text-text-strong truncate">{m.model}</span>
                      <span class="text-13-regular text-text-weak flex-shrink-0">
                        {money(m.cost)} · {compact(m.tokens)}
                      </span>
                    </div>
                    <div class="h-1.5 rounded-full overflow-hidden bg-surface-base">
                      <div
                        class="h-full rounded-full"
                        style={{
                          width: `${Math.max(2, (m.cost / modelMax()) * 100)}%`,
                          background: "var(--color-text-interactive-base, var(--icon-strong-base))",
                        }}
                      />
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* ── Recent transactions (credit ledger) — omitted when empty ── */}
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

const ModeCard: Component<{ active: boolean; disabled: boolean; title: string; body: string; onClick: () => void }> = (
  props,
) => (
  <button
    type="button"
    disabled={props.disabled}
    onClick={props.onClick}
    style={{
      all: "unset",
      cursor: props.disabled ? "default" : "pointer",
      opacity: props.disabled ? 0.6 : 1,
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

function fieldStyle(): JSX.CSSProperties {
  return {
    all: "unset",
    "box-sizing": "border-box",
    width: "100%",
    height: "36px",
    padding: "0 12px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-surface-solid, var(--color-bg))",
    "font-family": FONT_CODE,
    "font-size": "13px",
    color: "var(--color-text)",
    cursor: "text",
  }
}
